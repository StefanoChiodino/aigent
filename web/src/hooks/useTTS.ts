import { useRef, useCallback } from 'react';
import { useVoiceStore } from '../stores/voice';
import { stripMarkdownForTTS, extractSpeakContent } from '../lib/markdown';
import { useChatStore } from '../stores/chat';

interface TTSControls {
  speakText: (text: string, onDone?: () => void) => void;
  stopAll: () => void;
  stopStream: () => void;
  enqueueChunk: (text: string) => void;
  flushStream: (final?: boolean) => void;
  ttsStreamLastLen: React.MutableRefObject<number>;
}

export function useTTS(): TTSControls {
  const ttsAudio = useRef<HTMLAudioElement | null>(null);
  const ttsAbortCtrl = useRef<AbortController | null>(null);
  const ttsChunkQueue = useRef<Array<Promise<string>>>([]);
  const ttsChunkPlaying = useRef(false);
  const ttsStreamFetchCtrls = useRef<AbortController[]>([]);
  const ttsStreamLastLen = useRef(0);

  const getRatePct = () => useVoiceStore.getState().ttsRatePct;
  const getAutoSpeak = () => useVoiceStore.getState().ttsAutoSpeak;
  const getConcise = () => useChatStore.getState().streaming.active
    ? useChatStore.getState().streaming.active
    : false;

  const stopStream = useCallback((): void => {
    for (const ctrl of ttsStreamFetchCtrls.current) ctrl.abort();
    ttsStreamFetchCtrls.current = [];
    ttsChunkQueue.current = [];
    ttsChunkPlaying.current = false;
    ttsStreamLastLen.current = 0;
    if (ttsAudio.current) { ttsAudio.current.pause(); ttsAudio.current = null; }
    useVoiceStore.getState().setTtsPlaying(false);
  }, []);

  const stopAll = useCallback((): void => {
    stopStream();
    ttsAbortCtrl.current?.abort();
    ttsAbortCtrl.current = null;
    if (ttsAudio.current) { ttsAudio.current.pause(); ttsAudio.current = null; }
  }, [stopStream]);

  const drainQueue = useCallback(async (): Promise<void> => {
    ttsChunkPlaying.current = true;
    useVoiceStore.getState().setTtsPlaying(true);
    while (ttsChunkQueue.current.length > 0) {
      const p = ttsChunkQueue.current.shift()!;
      let blobUrl: string;
      try { blobUrl = await p; } catch { continue; }
      if (!ttsChunkPlaying.current) { URL.revokeObjectURL(blobUrl); break; }
      await new Promise<void>((resolve) => {
        const audio = new Audio(blobUrl);
        ttsAudio.current = audio;
        const cleanup = () => { URL.revokeObjectURL(blobUrl); ttsAudio.current = null; resolve(); };
        audio.onended = cleanup;
        audio.onerror = cleanup;
        void audio.play().catch(cleanup);
      });
      if (!ttsChunkPlaying.current) break;
    }
    ttsChunkPlaying.current = false;
    useVoiceStore.getState().setTtsPlaying(false);
  }, []);

  const enqueueChunk = useCallback((text: string): void => {
    const stripped = stripMarkdownForTTS(text);
    if (!stripped.trim()) return;
    const ratePct = getRatePct();
    const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;
    const ctrl = new AbortController();
    ttsStreamFetchCtrls.current.push(ctrl);
    const p = fetch(`/tts?rate=${encodeURIComponent(rateStr)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: stripped,
      signal: ctrl.signal,
    }).then(async (r) => {
      if (!r.ok) throw new Error('tts error');
      return URL.createObjectURL(await r.blob());
    });
    ttsChunkQueue.current.push(p);
    if (!ttsChunkPlaying.current) void drainQueue();
  }, [drainQueue]);

  const flushStream = useCallback((final = false): void => {
    if (!getAutoSpeak()) return;
    const streamText = useChatStore.getState().streaming.text;
    const conciseMode = useVoiceStore.getState().ttsAutoSpeak; // reuse concise from chat store if needed

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
    stopAll();

    const stripped = stripMarkdownForTTS(text);
    const ratePct = getRatePct();
    const rateStr = ratePct >= 0 ? `+${ratePct}%` : `${ratePct}%`;
    const ctrl = new AbortController();
    ttsAbortCtrl.current = ctrl;

    fetch(`/tts?rate=${encodeURIComponent(rateStr)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: stripped,
      signal: ctrl.signal,
    }).then(async (resp) => {
      if (!resp.ok) throw new Error('TTS unavailable');
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(blob);
      if (ttsAbortCtrl.current !== ctrl) { URL.revokeObjectURL(blobUrl); return; }
      const audio = new Audio(blobUrl);
      ttsAudio.current = audio;
      audio.onended = () => {
        URL.revokeObjectURL(blobUrl);
        ttsAudio.current = null;
        if (ttsAbortCtrl.current === ctrl) ttsAbortCtrl.current = null;
        onDone?.();
      };
      void audio.play();
    }).catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (ttsAbortCtrl.current === ctrl) ttsAbortCtrl.current = null;
    });
  }, [stopAll]);

  return { speakText, stopAll, stopStream, enqueueChunk, flushStream, ttsStreamLastLen };
}
