import { useCallback } from 'react';
import { useVoiceStore } from '../stores/voice';
import { isDemo } from '../demo/useDemoMode';
import { stripMarkdownForTTS, extractSpeakContent } from '../lib/markdown';
import { useChatStore } from '../stores/chat';

/** Apply the user's chosen speaker device to an HTMLAudioElement (if supported). */
async function applySinkId(audio: HTMLAudioElement): Promise<void> {
  const id = useVoiceStore.getState().speakerDeviceId;
  if (!id) return; // '' = system default, no action needed
  if (typeof (audio as any).setSinkId === 'function') {
    try { await (audio as any).setSinkId(id); } catch { /* unsupported or device gone */ }
  }
}

interface TTSControls {
  speakText: (text: string, onDone?: () => void) => void;
  stopAll: () => void;
  stopStream: () => void;
  enqueueChunk: (text: string) => void;
  flushStream: (final?: boolean) => void;
  ttsStreamLastLen: { current: number };
}

// When the page is embedded in an iframe (i.e., inside the PiP window), suppress
// all TTS so the user doesn't hear responses twice — once from the main tab and
// once from the PiP iframe.
const IS_IFRAME = window !== window.top;

// Module-level singletons so all useTTS() instances share the same audio state.
// Without this, App.tsx's flushStream starts audio on one set of refs while
// InputArea.tsx's stopAll tries to stop a different (empty) set.
let ttsAudio: HTMLAudioElement | null = null;
let ttsAbortCtrl: AbortController | null = null;
let ttsChunkQueue: Array<Promise<string>> = [];
let ttsChunkPlaying = false;
let ttsStreamFetchCtrls: AbortController[] = [];
const ttsStreamLastLen = { current: 0 };

/** Stop all TTS playback — callable outside of React (e.g. from useMic). */
export function ttsStopAll(): void {
  for (const ctrl of ttsStreamFetchCtrls) ctrl.abort();
  ttsStreamFetchCtrls = [];
  ttsChunkQueue = [];
  ttsChunkPlaying = false;
  ttsStreamLastLen.current = 0;
  ttsAbortCtrl?.abort();
  ttsAbortCtrl = null;
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
  if (isDemo()) speechSynthesis.cancel();
  useVoiceStore.getState().setTtsPlaying(false);
}

export function useTTS(): TTSControls {
  const getRatePct = () => useVoiceStore.getState().ttsRatePct;
  const getAutoSpeak = () => useVoiceStore.getState().ttsAutoSpeak;

  const stopStream = useCallback((): void => {
    for (const ctrl of ttsStreamFetchCtrls) ctrl.abort();
    ttsStreamFetchCtrls = [];
    ttsChunkQueue = [];
    ttsChunkPlaying = false;
    ttsStreamLastLen.current = 0;
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
    if (isDemo()) speechSynthesis.cancel();
    useVoiceStore.getState().setTtsPlaying(false);
  }, []);

  const stopAll = useCallback((): void => {
    stopStream();
    ttsAbortCtrl?.abort();
    ttsAbortCtrl = null;
    if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
    if (isDemo()) speechSynthesis.cancel();
  }, [stopStream]);

  const drainQueue = useCallback(async (): Promise<void> => {
    ttsChunkPlaying = true;
    useVoiceStore.getState().setTtsPlaying(true);
    while (ttsChunkQueue.length > 0) {
      const p = ttsChunkQueue.shift()!;
      let blobUrl: string;
      try { blobUrl = await p; } catch { continue; }
      if (!ttsChunkPlaying) { URL.revokeObjectURL(blobUrl); break; }
      await new Promise<void>((resolve) => {
        const audio = new Audio(blobUrl);
        ttsAudio = audio;
        const cleanup = () => { URL.revokeObjectURL(blobUrl); ttsAudio = null; resolve(); };
        audio.onended = cleanup;
        audio.onerror = cleanup;
        void applySinkId(audio).then(() => audio.play()).catch(cleanup);
      });
      if (!ttsChunkPlaying) break;
    }
    ttsChunkPlaying = false;
    useVoiceStore.getState().setTtsPlaying(false);
  }, []);

  const enqueueChunk = useCallback((text: string): void => {
    if (IS_IFRAME) return;
    const stripped = stripMarkdownForTTS(text);
    if (!stripped.trim()) return;

    // Demo mode: use browser SpeechSynthesis (no server needed)
    if (isDemo()) {
      const utterance = new SpeechSynthesisUtterance(stripped);
      utterance.rate = 1 + getRatePct() / 100;
      utterance.onstart = () => useVoiceStore.getState().setTtsPlaying(true);
      utterance.onend = () => useVoiceStore.getState().setTtsPlaying(false);
      utterance.onerror = () => useVoiceStore.getState().setTtsPlaying(false);
      speechSynthesis.speak(utterance);
      return;
    }

    const ratePct = getRatePct();
    const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;
    const ctrl = new AbortController();
    ttsStreamFetchCtrls.push(ctrl);
    const p = fetch(`/tts?rate=${encodeURIComponent(rateStr)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: stripped,
      signal: ctrl.signal,
    }).then(async (r) => {
      if (!r.ok) throw new Error('tts error');
      return URL.createObjectURL(await r.blob());
    });
    // Attach a no-op catch so abort/errors don't become unhandled rejections
    // before drainQueue consumes this promise.
    p.catch(() => undefined);
    ttsChunkQueue.push(p);
    if (!ttsChunkPlaying) void drainQueue();
  }, [drainQueue]);

  const flushStream = useCallback((final = false): void => {
    if (!getAutoSpeak()) return;
    const streamText = useChatStore.getState().streaming.text;

    // Concise mode: responses wrap the TTS summary in <speak>...</speak>.
    // Speak only that block (once), then ignore the rest of the stream.
    if (streamText.includes('<speak>')) {
      const speakContent = extractSpeakContent(streamText);
      if (!speakContent) {
        // <speak> opened but </speak> not yet arrived — wait for it.
        return;
      }
      if (!useVoiceStore.getState().speakBlockSpoken) {
        useVoiceStore.getState().setSpeakBlockSpoken(true);
        // Advance the pointer past the closing </speak> tag so we never
        // re-process this region, then speak the extracted content.
        const closeTag = '</speak>';
        const closeIdx = streamText.indexOf(closeTag);
        ttsStreamLastLen.current = closeIdx + closeTag.length;
        enqueueChunk(speakContent);
      }
      // Don't speak the markdown body that follows the <speak> block.
      return;
    }

    const unspoken = streamText.slice(ttsStreamLastLen.current);
    if (!unspoken) return;

    if (final) {
      enqueueChunk(unspoken);
      ttsStreamLastLen.current = streamText.length;
      return;
    }

    const re = /[.!?]['\"»]?\s+|\n\n/g;
    let lastEnd = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(unspoken)) !== null) {
      lastEnd = m.index + m[0].length;
    }
    if (lastEnd > 0) {
      enqueueChunk(unspoken.slice(0, lastEnd));
      ttsStreamLastLen.current += lastEnd;
    }
  }, [enqueueChunk]);

  const speakText = useCallback((text: string, onDone?: () => void): void => {
    if (IS_IFRAME) { onDone?.(); return; }
    stopAll();

    const stripped = stripMarkdownForTTS(text);

    // Demo mode: use browser SpeechSynthesis
    if (isDemo()) {
      const utterance = new SpeechSynthesisUtterance(stripped);
      utterance.rate = 1 + getRatePct() / 100;
      utterance.onstart = () => useVoiceStore.getState().setTtsPlaying(true);
      utterance.onend = () => { useVoiceStore.getState().setTtsPlaying(false); onDone?.(); };
      utterance.onerror = () => { useVoiceStore.getState().setTtsPlaying(false); onDone?.(); };
      speechSynthesis.speak(utterance);
      return;
    }

    const ratePct = getRatePct();
    const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;
    const ctrl = new AbortController();
    ttsAbortCtrl = ctrl;

    useVoiceStore.getState().setTtsPlaying(true);
    fetch(`/tts?rate=${encodeURIComponent(rateStr)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: stripped,
      signal: ctrl.signal,
    }).then(async (resp) => {
      if (!resp.ok) throw new Error('TTS unavailable');
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      if (ttsAbortCtrl !== ctrl) { URL.revokeObjectURL(blobUrl); return; }
      const audio = new Audio(blobUrl);
      ttsAudio = audio;
      audio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        ttsAudio = null;
        if (ttsAbortCtrl === ctrl) ttsAbortCtrl = null;
        useVoiceStore.getState().setTtsPlaying(false);
        onDone?.();
      };
      await applySinkId(audio);
      void audio.play();
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (ttsAbortCtrl === ctrl) ttsAbortCtrl = null;
      useVoiceStore.getState().setTtsPlaying(false);
    });
  }, [stopAll]);

  return { speakText, stopAll, stopStream, enqueueChunk, flushStream, ttsStreamLastLen };
}
