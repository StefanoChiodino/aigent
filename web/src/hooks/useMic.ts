import { useRef, useCallback } from 'react';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import { encodeWav, playMicSound } from '../lib/audio';
import { useConnectionStore } from '../stores/connection';

export interface MicControls {
  startMic: (silent?: boolean) => Promise<void>;
  stopMic: (silent?: boolean) => Promise<void>;
  abortMic: () => void;
  micRecording: boolean;
}

export function useMic(onTranscript: (text: string) => void): MicControls {
  const micAudioCtx = useRef<AudioContext | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micSamples = useRef<Float32Array[]>([]);
  const micSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessor = useRef<ScriptProcessorNode | null>(null);
  const micChunkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const micSilenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micReqSeq = useRef(0);
  const micDisplayedSeq = useRef(0);
  const micBaseText = useRef('');
  const vadLoudFrames = useRef(0);
  const micLastSpeechTime = useRef(0);
  const micLiveAbortCtrls = useRef<AbortController[]>([]);

  const getSetting = useSettingsStore.getState().getClientSetting;

  const silenceThreshold = () => getSetting('mic_silence_threshold') as number;
  const loudFrames = () => getSetting('mic_loud_frames') as number;
  const silenceTailMs = () => getSetting('mic_silence_tail_ms') as number;
  const autoSend = () => getSetting('mic_auto_send') as boolean;
  const autoSendMs = () => getSetting('mic_auto_send_ms') as number;

  const setMicState = useVoiceStore.getState().setMicState;
  const setVadActive = useVoiceStore.getState().setVadActive;
  const send = useConnectionStore.getState().send;

  const sendLiveChunk = useCallback(async (): Promise<void> => {
    if (micSamples.current.length === 0) return;
    const samples = micSamples.current.splice(0);
    const sampleRate = micAudioCtx.current?.sampleRate ?? 16000;
    const wavBuf = encodeWav(samples, sampleRate);
    const seq = ++micReqSeq.current;

    const ctrl = new AbortController();
    micLiveAbortCtrls.current.push(ctrl);

    setMicState('transcribing');
    try {
      const resp = await fetch('/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBuf,
        signal: ctrl.signal,
      });
      if (!resp.ok) return;
      const data = await resp.json() as { text?: string };
      const text = data.text?.trim() ?? '';
      if (seq > micDisplayedSeq.current && text) {
        micDisplayedSeq.current = seq;
        onTranscript(micBaseText.current + text);
      }
    } catch { /* aborted */ } finally {
      micLiveAbortCtrls.current = micLiveAbortCtrls.current.filter(c => c !== ctrl);
      if (useVoiceStore.getState().micState === 'transcribing') {
        setMicState('recording');
      }
    }
  }, [onTranscript, setMicState]);

  const startMic = useCallback(async (silent = false): Promise<void> => {
    if (useVoiceStore.getState().micState !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      micAudioCtx.current = ctx;
      micSamples.current = [];
      micReqSeq.current = 0;
      micDisplayedSeq.current = 0;
      micBaseText.current = '';
      vadLoudFrames.current = 0;
      micLastSpeechTime.current = 0;

      const source = ctx.createMediaStreamSource(stream);
      micSource.current = source;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      micProcessor.current = proc;

      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        micSamples.current.push(copy);

        // VAD
        const rms = Math.sqrt(copy.reduce((s, v) => s + v * v, 0) / copy.length);
        if (rms > silenceThreshold()) {
          vadLoudFrames.current++;
          if (vadLoudFrames.current >= loudFrames()) {
            setVadActive(true);
            micLastSpeechTime.current = Date.now();
          }
        } else {
          vadLoudFrames.current = 0;
          setVadActive(false);
        }

        // Auto-send on silence
        if (autoSend() && micLastSpeechTime.current > 0) {
          const silent_duration = Date.now() - micLastSpeechTime.current;
          if (silent_duration > autoSendMs() && !micSilenceTimer.current) {
            micSilenceTimer.current = setTimeout(() => {
              micSilenceTimer.current = null;
              send({ type: 'command', cmd: '__submit__' });
            }, 100);
          }
        }
      };

      source.connect(proc);
      proc.connect(ctx.destination);

      micChunkTimer.current = setInterval(() => {
        void sendLiveChunk();
      }, 2000);

      if (!silent) playMicSound('start');
      setMicState('recording');
      useVoiceStore.getState().setMicState('recording');
    } catch { /* permission denied */ }
  }, [sendLiveChunk, send, setMicState, setVadActive]);

  const stopMic = useCallback(async (silent = false): Promise<void> => {
    if (micChunkTimer.current) { clearInterval(micChunkTimer.current); micChunkTimer.current = null; }
    if (micSilenceTimer.current) { clearTimeout(micSilenceTimer.current); micSilenceTimer.current = null; }
    micProcessor.current?.disconnect();
    micSource.current?.disconnect();
    micStream.current?.getTracks().forEach(t => t.stop());
    micAudioCtx.current?.close();
    micProcessor.current = null;
    micSource.current = null;
    micStream.current = null;
    micAudioCtx.current = null;

    // Final transcription
    if (micSamples.current.length > 0) {
      await sendLiveChunk();
    }

    if (!silent) playMicSound('stop');
    setMicState('idle');
    setVadActive(false);
  }, [sendLiveChunk, setMicState, setVadActive]);

  const abortMic = useCallback((): void => {
    for (const ctrl of micLiveAbortCtrls.current) ctrl.abort();
    micLiveAbortCtrls.current = [];
    if (micChunkTimer.current) { clearInterval(micChunkTimer.current); micChunkTimer.current = null; }
    if (micSilenceTimer.current) { clearTimeout(micSilenceTimer.current); micSilenceTimer.current = null; }
    micProcessor.current?.disconnect();
    micSource.current?.disconnect();
    micStream.current?.getTracks().forEach(t => t.stop());
    micAudioCtx.current?.close();
    micProcessor.current = null;
    micSource.current = null;
    micStream.current = null;
    micAudioCtx.current = null;
    micSamples.current = [];
    setMicState('idle');
    setVadActive(false);
  }, [setMicState, setVadActive]);

  return {
    startMic,
    stopMic,
    abortMic,
    micRecording: useVoiceStore.getState().micState !== 'idle',
  };
}
