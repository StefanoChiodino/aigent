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

/** Sentinel ID used when auto-speak is playing the streaming message. */
export const TTS_STREAMING_ID = '__streaming__';

interface TTSControls {
  speakText: (text: string, onDone?: () => void, speakingId?: string) => void;
  stopAll: () => void;
  stopStream: () => void;
  enqueueChunk: (text: string) => void;
  flushStream: (final?: boolean) => void;
  ttsStreamLastLen: { current: number };
}

// When the page is embedded in an iframe (i.e., inside the PiP window), suppress
// all TTS so the user doesn't hear responses twice — once from the main tab and
// once from the PiP iframe.
const IS_IFRAME = typeof window !== 'undefined' && window !== window.top;

// Module-level singletons so all useTTS() instances share the same audio state.
// Without this, App.tsx's flushStream starts audio on one set of refs while
// InputArea.tsx's stopAll tries to stop a different (empty) set.
let ttsAudio: HTMLAudioElement | null = null;
let ttsAbortCtrl: AbortController | null = null;
let ttsChunkQueue: Array<Promise<string>> = [];
let ttsChunkPlaying = false;
let ttsStreamFetchCtrls: AbortController[] = [];
const ttsStreamLastLen = { current: 0 };

/** Split text into sentence-sized chunks for pipelined TTS. */
function splitIntoSentences(text: string): string[] {
  const re = /[.!?]['"\u00BB]?\s+|\n\n/g;
  const chunks: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const chunk = text.slice(last, end).trim();
    if (chunk) chunks.push(chunk);
    last = end;
  }
  // Remainder after the last sentence boundary
  const tail = text.slice(last).trim();
  if (tail) chunks.push(tail);
  return chunks;
}

/** Get the current TTS audio element (for connecting an AnalyserNode). */
export function getTtsAudioElement(): HTMLAudioElement | null {
  return ttsAudio;
}

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
  useVoiceStore.getState().setTtsSpeakingId(null);
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
    useVoiceStore.getState().setTtsSpeakingId(null);
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
    useVoiceStore.getState().setTtsSpeakingId(null);
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
      utterance.onend = () => { useVoiceStore.getState().setTtsPlaying(false); useVoiceStore.getState().setTtsSpeakingId(null); };
      utterance.onerror = () => { useVoiceStore.getState().setTtsPlaying(false); useVoiceStore.getState().setTtsSpeakingId(null); };
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
    // Never talk over the user — suppress TTS while mic is active
    if (useVoiceStore.getState().micState !== 'idle') return;
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
        useVoiceStore.getState().setTtsSpeakingId(TTS_STREAMING_ID);
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

    // If the <speak> block was already spoken this turn, suppress all further
    // TTS. This handles post-tool-use text: startToolBlock clears streaming.text
    // so the <speak> tag is no longer present, but we already spoke the summary.
    if (useVoiceStore.getState().speakBlockSpoken) return;

    const unspoken = streamText.slice(ttsStreamLastLen.current);
    if (!unspoken) return;

    if (final) {
      useVoiceStore.getState().setTtsSpeakingId(TTS_STREAMING_ID);
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
      useVoiceStore.getState().setTtsSpeakingId(TTS_STREAMING_ID);
      enqueueChunk(unspoken.slice(0, lastEnd));
      ttsStreamLastLen.current += lastEnd;
    }
  }, [enqueueChunk]);

  const speakText = useCallback((text: string, onDone?: () => void, speakingId?: string): void => {
    if (IS_IFRAME) { onDone?.(); return; }
    stopAll();

    // Set the speaking ID so only the active message's button shows stop state.
    useVoiceStore.getState().setTtsSpeakingId(speakingId ?? null);

    const stripped = stripMarkdownForTTS(text);

    // Demo mode: use browser SpeechSynthesis
    if (isDemo()) {
      const utterance = new SpeechSynthesisUtterance(stripped);
      utterance.rate = 1 + getRatePct() / 100;
      utterance.onstart = () => useVoiceStore.getState().setTtsPlaying(true);
      utterance.onend = () => { useVoiceStore.getState().setTtsPlaying(false); useVoiceStore.getState().setTtsSpeakingId(null); onDone?.(); };
      utterance.onerror = () => { useVoiceStore.getState().setTtsPlaying(false); useVoiceStore.getState().setTtsSpeakingId(null); onDone?.(); };
      speechSynthesis.speak(utterance);
      return;
    }

    // Split text into sentence chunks so the first sentence starts playing
    // immediately while the rest synthesize in the background.
    const sentences = splitIntoSentences(stripped);
    if (sentences.length === 0) { onDone?.(); return; }

    // Use the streaming chunk queue — enqueue each sentence, then attach
    // onDone to fire after the last chunk finishes playing.
    for (const sentence of sentences) {
      enqueueChunk(sentence);
    }

    // When onDone is provided, poll for queue drain and call it.
    if (onDone) {
      const checkDone = () => {
        if (!ttsChunkPlaying && ttsChunkQueue.length === 0) { onDone(); return; }
        setTimeout(checkDone, 100);
      };
      checkDone();
    }
  }, [stopAll, enqueueChunk]);

  return { speakText, stopAll, stopStream, enqueueChunk, flushStream, ttsStreamLastLen };
}
