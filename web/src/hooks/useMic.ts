import { useRef, useCallback } from 'react';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import { useUIStore } from '../stores/ui';
import { encodeWav, playMicSound } from '../lib/audio';
import { useConnectionStore } from '../stores/connection';
import { ttsStopAll } from './useTTS';

export interface MicControls {
  startMic: (silent?: boolean, baseText?: string) => Promise<void>;
  stopMic: (silent?: boolean) => Promise<void>;
  abortMic: () => void;
  clearTranscript: () => void;
  commitBase: (text: string) => void;
  micRecording: boolean;
}

// Max samples to send per live chunk (8 s at 16 kHz — fallback cap for continuous speech
// with no pauses; silence-based commit normally keeps windows much shorter)
const MIC_WINDOW_SAMPLES = 16000 * 8;

export function useMic(onTranscript: (text: string, windowCapped: boolean) => void): MicControls {
  const micAudioCtx = useRef<AudioContext | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micSamples = useRef<Float32Array[]>([]);
  const micSource = useRef<MediaStreamAudioSourceNode | null>(null);
  const micProcessor = useRef<AudioWorkletNode | null>(null);
  const micChunkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const micSilenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micReqSeq = useRef(0);
  const micDisplayedSeq = useRef(0);
  const micBaseText = useRef('');
  const micLastText = useRef('');
  const vadLoudFrames = useRef(0);
  const vadSpeaking = useRef(false);
  const micLastSpeechTime = useRef(0);
  const micLiveAbortCtrls = useRef<AbortController[]>([]);
  const pendingSilenceCommit = useRef(false);
  const isFetching = useRef(false);

  const getSetting = useSettingsStore.getState().getClientSetting;

  const silenceThreshold = () => getSetting('mic_silence_threshold') as number;
  const loudFrames = () => getSetting('mic_loud_frames') as number;
  const silenceTailMs = () => getSetting('mic_silence_tail_ms') as number;
  const autoSend = () => getSetting('mic_auto_send') as boolean;
  const autoSendMs = () => getSetting('mic_auto_send_ms') as number;
  const idleTimeoutMin = () => getSetting('mic_idle_timeout_min') as number;

  const setMicState = useVoiceStore.getState().setMicState;
  const setVadActive = useVoiceStore.getState().setVadActive;
  const send = useConnectionStore.getState().send;

  const sendLiveChunk = useCallback(async (): Promise<void> => {
    if (micSamples.current.length === 0) return;
    if (isFetching.current) return; // serialize — skip if previous request still in flight

    // Check if audio exceeds the window. If so, commit the last good
    // transcription into micBaseText, clear samples, and start a fresh
    // window. Fallback for continuous speech with no pauses.
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
    isFetching.current = true;
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

          // Silence-based commit: when VAD detected a pause and we now
          // have a response covering the audio up to that pause, commit
          // the transcription and start a fresh audio window.
          if (pendingSilenceCommit.current) {
            pendingSilenceCommit.current = false;
            micBaseText.current = micBaseText.current
              ? micBaseText.current + ' ' + text
              : text;
            micSamples.current = [];
            micLastText.current = '';
            micReqSeq.current = 0;
            micDisplayedSeq.current = 0;
            onTranscript(micBaseText.current, false);
          } else {
            onTranscript(micBaseText.current ? micBaseText.current + ' ' + text : text, false);
          }
        }
      }
    } catch { /* aborted */ } finally {
      isFetching.current = false;
      clearTimeout(liveTimeout);
      micLiveAbortCtrls.current = micLiveAbortCtrls.current.filter(c => c !== ctrl);
    }
  }, [onTranscript]);

  const startMic = useCallback(async (silent = false, baseText = ''): Promise<void> => {
    if (useVoiceStore.getState().micState !== 'idle') return;

    // Stop any active TTS so the agent doesn't talk over the user
    ttsStopAll();

    // Clean up any leftover infrastructure from a previous session that was
    // externally reset (e.g. test cleanup setting micState to 'idle' without
    // going through stopMic/abortMic).
    if (micChunkTimer.current) { clearInterval(micChunkTimer.current); micChunkTimer.current = null; }
    if (micSilenceTimer.current) { clearTimeout(micSilenceTimer.current); micSilenceTimer.current = null; }
    if (micIdleTimer.current) { clearTimeout(micIdleTimer.current); micIdleTimer.current = null; }
    for (const c of micLiveAbortCtrls.current) c.abort();

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        useUIStore.getState().setError('Microphone not available (secure context required)');
        return;
      }
      const { micDeviceId: micDevId, micDeviceLabel } = useVoiceStore.getState();
      const audioConstraints: MediaTrackConstraints = { channelCount: 1 };
      if (micDevId) {
        // Validate device still exists before using { exact } — browsers can
        // regenerate device IDs across sessions, causing OverconstrainedError.
        const available = await navigator.mediaDevices.enumerateDevices();
        const micInputs = available.filter(d => d.kind === 'audioinput');
        const byId = micInputs.find(d => d.deviceId === micDevId);
        if (byId) {
          audioConstraints.deviceId = { exact: micDevId };
        } else {
          // ID is stale — try to re-match by label (Chrome regenerates IDs each session)
          const byLabel = micDeviceLabel
            ? micInputs.find(d => d.label === micDeviceLabel)
            : null;
          if (byLabel) {
            useVoiceStore.getState().setMicDevice(byLabel.deviceId, byLabel.label);
            audioConstraints.deviceId = { exact: byLabel.deviceId };
          } else {
            useVoiceStore.getState().setMicDevice('', '');
          }
        }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
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
      pendingSilenceCommit.current = false;
      isFetching.current = false;

      const source = ctx.createMediaStreamSource(stream);
      micSource.current = source;

      await ctx.audioWorklet.addModule('/mic-processor.js');
      const worklet = new AudioWorkletNode(ctx, 'mic-processor');
      micProcessor.current = worklet;

      worklet.port.onmessage = (e: MessageEvent<{ samples: Float32Array; rms: number }>) => {
        const { samples: copy, rms } = e.data;

        // Always accumulate audio — the STT model handles silence natively.
        // VAD is only used for visual feedback (pulse) and auto-send timing.
        micSamples.current.push(copy);

        // VAD — rms is pre-computed on the audio thread (visual feedback only)
        const silenceThresh = silenceThreshold();
        const loudFramesNeeded = loudFrames();
        const silenceTail = silenceTailMs();

        if (rms > silenceThresh) {
          micLastSpeechTime.current = Date.now();
          // Speech resumed — cancel any pending silence commit
          pendingSilenceCommit.current = false;
          // Cancel any pending auto-send timer when speech resumes
          if (micSilenceTimer.current !== null) {
            clearTimeout(micSilenceTimer.current);
            micSilenceTimer.current = null;
          }
          // Cancel any pending idle-timeout timer when speech resumes
          if (micIdleTimer.current !== null) {
            clearTimeout(micIdleTimer.current);
            micIdleTimer.current = null;
          }
          // Visual pulse: require a few consecutive loud frames to avoid flicker
          vadLoudFrames.current++;
          if (vadLoudFrames.current >= loudFramesNeeded && !vadSpeaking.current) {
            vadSpeaking.current = true;
            setVadActive(true);
            // Barge-in: stop TTS when user starts speaking
            ttsStopAll();
          }
        } else {
          vadLoudFrames.current = 0;
          if (vadSpeaking.current && Date.now() - micLastSpeechTime.current > silenceTail) {
            vadSpeaking.current = false;
            setVadActive(false);
            // Natural speech pause — schedule a commit on the next STT response
            // so the audio window resets and inference stays fast.
            pendingSilenceCommit.current = true;
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
          // Idle timeout: in sticky mode, stop mic after prolonged silence to save battery
          const idleMs = idleTimeoutMin() * 60_000;
          if (micSticky && idleMs > 0 && micIdleTimer.current === null) {
            micIdleTimer.current = setTimeout(() => {
              micIdleTimer.current = null;
              const vs = useVoiceStore.getState();
              if (vs.micSticky && vs.micState === 'recording') {
                vs.setMicSticky(false);
                // Tear down mic infrastructure directly (stopMic is not in scope here)
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
                vs.setMicState('idle');
                vs.setVadActive(false);
              }
            }, idleMs);
          }
        }
      };

      // Connect source to worklet — output is not routed to destination since
      // we only use the audio thread for sample collection, not playback.
      source.connect(worklet);

      micLastSpeechTime.current = Date.now();

      // Send first chunk after a short delay (let audio accumulate), then every 1.2 s.
      // Requests run concurrently; the seq counter ensures only the latest wins.
      setTimeout(() => { void sendLiveChunk(); }, 800);
      micChunkTimer.current = setInterval(() => {
        void sendLiveChunk();
      }, 1200);

      if (!silent) playMicSound('start');
      setMicState('recording');
    } catch (err) {
      const msg = err instanceof Error
        ? (err.message || err.name || 'Unknown error')
        : String(err);
      useUIStore.getState().setError(`Microphone error: ${msg}`);
    }
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
    if (micIdleTimer.current) { clearTimeout(micIdleTimer.current); micIdleTimer.current = null; }
    for (const c of micLiveAbortCtrls.current) c.abort();
    pendingSilenceCommit.current = false;
    isFetching.current = false;
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
      // and Parakeet may need several seconds to process it.
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
    pendingSilenceCommit.current = false;
    isFetching.current = false;
  }, []);

  /** Adopt new base text during recording (e.g. user typed or pasted).
   *  Clears accumulated audio so the next STT chunk only contains speech
   *  recorded after the edit, preventing duplication with the new base. */
  const commitBase = useCallback((text: string): void => {
    micBaseText.current = text;
    micLastText.current = '';
    micSamples.current = [];
    micDisplayedSeq.current = ++micReqSeq.current;
    for (const c of micLiveAbortCtrls.current) c.abort();
    micLiveAbortCtrls.current = [];
    pendingSilenceCommit.current = false;
    isFetching.current = false;
  }, []);

  const abortMic = useCallback((): void => {
    for (const ctrl of micLiveAbortCtrls.current) ctrl.abort();
    micLiveAbortCtrls.current = [];
    if (micChunkTimer.current) { clearInterval(micChunkTimer.current); micChunkTimer.current = null; }
    if (micSilenceTimer.current) { clearTimeout(micSilenceTimer.current); micSilenceTimer.current = null; }
    if (micIdleTimer.current) { clearTimeout(micIdleTimer.current); micIdleTimer.current = null; }
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
    pendingSilenceCommit.current = false;
    isFetching.current = false;
    setMicState('idle');
    setVadActive(false);
  }, [setMicState, setVadActive]);

  return {
    startMic,
    stopMic,
    abortMic,
    clearTranscript,
    commitBase,
    micRecording: useVoiceStore.getState().micState !== 'idle',
  };
}
