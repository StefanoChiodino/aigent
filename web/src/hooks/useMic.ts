import { useRef, useCallback } from 'react';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import { encodeWav, playMicSound } from '../lib/audio';
import { useConnectionStore } from '../stores/connection';

export interface MicControls {
  startMic: (silent?: boolean, baseText?: string) => Promise<void>;
  stopMic: (silent?: boolean) => Promise<void>;
  abortMic: () => void;
  clearTranscript: () => void;
  micRecording: boolean;
}

// Max samples to send per live chunk (12 s at 16 kHz — more context improves Whisper accuracy)
const MIC_WINDOW_SAMPLES = 16000 * 12;

export function useMic(onTranscript: (text: string, windowCapped: boolean) => void): MicControls {
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
  const micLastText = useRef('');
  const vadLoudFrames = useRef(0);
  const vadSpeaking = useRef(false);
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

    // Check if audio exceeds the window. If so, commit the last good
    // transcription into micBaseText, clear samples, and start a fresh
    // window. This prevents old text from being lost when Whisper only
    // sees the trailing 12 s.
    let totalLen = 0;
    for (const s of micSamples.current) totalLen += s.length;
    if (totalLen > MIC_WINDOW_SAMPLES) {
      if (micLastText.current) {
        micBaseText.current = micBaseText.current
          ? micBaseText.current + ' ' + micLastText.current
          : micLastText.current;
      }
      micSamples.current = [];
      micLastText.current = '';
      micReqSeq.current = 0;
      micDisplayedSeq.current = 0;
      // Update UI to show the committed text while fresh audio accumulates
      if (micBaseText.current) {
        onTranscript(micBaseText.current, false);
      }
      return;
    }

    const seq = ++micReqSeq.current;

    const sampleRate = micAudioCtx.current?.sampleRate ?? 16000;
    const wavBuf = encodeWav(micSamples.current, sampleRate);

    const ctrl = new AbortController();
    // Timeout live chunks at 5 s — if STT is slower than that, skip rather than
    // pile up concurrent slow requests that resolve after recording ends.
    const liveTimeout = setTimeout(() => ctrl.abort(), 5000);
    micLiveAbortCtrls.current.push(ctrl);

    // Don't toggle micState to 'transcribing' during live chunks — that causes
    // the mic button to flicker between the stop icon and spinner every 1.2s.
    // The 'transcribing' state is only used for the final transcription in stopMic.
    try {
      const resp = await fetch('/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBuf,
        signal: ctrl.signal,
      });
      if (resp.ok && seq > micDisplayedSeq.current) {
        const data = await resp.json() as { text?: string };
        const text = data.text?.trim() ?? '';
        if (text) {
          micLastText.current = text;
          micDisplayedSeq.current = seq;
          onTranscript(micBaseText.current ? micBaseText.current + ' ' + text : text, false);
        }
      }
    } catch { /* aborted */ } finally {
      clearTimeout(liveTimeout);
      micLiveAbortCtrls.current = micLiveAbortCtrls.current.filter(c => c !== ctrl);
    }
  }, [onTranscript]);

  const startMic = useCallback(async (silent = false, baseText = ''): Promise<void> => {
    if (useVoiceStore.getState().micState !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
      micStream.current = stream;
      const ctx = new AudioContext({ sampleRate: 16000 });
      micAudioCtx.current = ctx;
      micSamples.current = [];
      micLastText.current = '';
      micReqSeq.current = 0;
      micDisplayedSeq.current = 0;
      micBaseText.current = baseText.trimEnd();
      vadLoudFrames.current = 0;
      vadSpeaking.current = false;
      micLastSpeechTime.current = 0;
      micLiveAbortCtrls.current = [];

      const source = ctx.createMediaStreamSource(stream);
      micSource.current = source;
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      micProcessor.current = proc;

      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);

        // VAD — compute RMS
        let sum = 0;
        for (let i = 0; i < copy.length; i++) sum += copy[i]! * copy[i]!;
        const rms = Math.sqrt(sum / copy.length);

        const silenceThresh = silenceThreshold();
        const loudFramesNeeded = loudFrames();
        const silenceTail = silenceTailMs();

        if (rms > silenceThresh) {
          // Speech detected — accumulate audio
          micSamples.current.push(copy);
          micLastSpeechTime.current = Date.now();
          // Cancel any pending auto-send timer when speech resumes
          if (micSilenceTimer.current !== null) {
            clearTimeout(micSilenceTimer.current);
            micSilenceTimer.current = null;
          }
          // Visual pulse: require a few consecutive loud frames to avoid flicker
          vadLoudFrames.current++;
          if (vadLoudFrames.current >= loudFramesNeeded && !vadSpeaking.current) {
            vadSpeaking.current = true;
            setVadActive(true);
          }
        } else {
          // Keep a short tail of silence after speech so words don't get clipped
          if (vadSpeaking.current) micSamples.current.push(copy);
          vadLoudFrames.current = 0;
          if (vadSpeaking.current && Date.now() - micLastSpeechTime.current > silenceTail) {
            vadSpeaking.current = false;
            setVadActive(false);
          }
          // Auto-send on silence: in sticky mode, schedule a submit after the
          // configured silence duration. Only arm the timer once (when null).
          const micSticky = useVoiceStore.getState().micSticky;
          if (micSticky && autoSend() && micLastText.current && micSilenceTimer.current === null) {
            micSilenceTimer.current = setTimeout(() => {
              micSilenceTimer.current = null;
              const state = useVoiceStore.getState();
              if (state.micSticky && state.micState === 'recording' && micLastText.current) {
                send({ type: 'command', cmd: '__submit__' });
              }
            }, autoSendMs());
          }
        }
      };

      source.connect(proc);
      proc.connect(ctx.destination);

      micLastSpeechTime.current = Date.now();

      // Send first chunk after a short delay (let audio accumulate), then every 1.2 s.
      // Requests run concurrently; the seq counter ensures only the latest wins.
      setTimeout(() => { void sendLiveChunk(); }, 800);
      micChunkTimer.current = setInterval(() => {
        void sendLiveChunk();
      }, 1200);

      if (!silent) playMicSound('start');
      setMicState('recording');
    } catch { /* permission denied */ }
  }, [sendLiveChunk, send, setMicState, setVadActive]);

  const stopMic = useCallback(async (silent = false): Promise<void> => {
    const currentState = useVoiceStore.getState().micState;
    if (currentState === 'idle') return;

    vadSpeaking.current = false;
    vadLoudFrames.current = 0;
    setVadActive(false);
    if (!silent) playMicSound('stop');

    // Stop timers and abort all in-flight live STT requests
    if (micChunkTimer.current) { clearInterval(micChunkTimer.current); micChunkTimer.current = null; }
    if (micSilenceTimer.current) { clearTimeout(micSilenceTimer.current); micSilenceTimer.current = null; }
    for (const c of micLiveAbortCtrls.current) c.abort();
    micLiveAbortCtrls.current = [];

    setMicState('transcribing');

    micProcessor.current?.disconnect();
    micSource.current?.disconnect();
    micStream.current?.getTracks().forEach(t => t.stop());
    await micAudioCtx.current?.close();

    const samples = micSamples.current;
    micSamples.current = [];
    micProcessor.current = null;
    micSource.current = null;
    micStream.current = null;
    micAudioCtx.current = null;

    if (samples.length === 0) {
      // Samples may be empty if the window-cap commit just cleared them.
      // Emit the accumulated base text so it isn't lost.
      if (micBaseText.current) {
        onTranscript(micBaseText.current, false);
      }
      setMicState('idle');
      return;
    }

    let finalText = micLastText.current;
    try {
      // No client-side timeout for the final call — the full recording may be long
      // and Whisper may need several seconds to process it.
      const resp = await fetch('/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: encodeWav(samples, 16000),
      });
      if (resp.ok) {
        const data = await resp.json() as { text?: string };
        if (data.text) finalText = data.text.trim();
      }
    } catch {
      // STT service not running — use last live chunk result
    }

    if (finalText) {
      onTranscript(micBaseText.current ? micBaseText.current + ' ' + finalText : finalText, false);
    }
    setMicState('idle');
  }, [sendLiveChunk, onTranscript, setMicState, setVadActive]);

  const clearTranscript = useCallback((): void => {
    // Discard all accumulated audio so the next sendLiveChunk has nothing to send
    micSamples.current = [];
    micLastText.current = '';
    micBaseText.current = '';
    // Bump seq so any in-flight responses are ignored (seq <= displayedSeq)
    micDisplayedSeq.current = ++micReqSeq.current;
    // Abort in-flight STT requests
    for (const c of micLiveAbortCtrls.current) c.abort();
    micLiveAbortCtrls.current = [];
  }, []);

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
    vadSpeaking.current = false;
    setMicState('idle');
    setVadActive(false);
  }, [setMicState, setVadActive]);

  return {
    startMic,
    stopMic,
    abortMic,
    clearTranscript,
    micRecording: useVoiceStore.getState().micState !== 'idle',
  };
}
