import { getTtsAudioElement } from './useTTS';
import { useVoiceStore } from '../stores/voice';
import { useUIStore } from '../stores/ui';

/**
 * Shared audio analysis module for visualizer background themes.
 *
 * Provides FFT frequency data and time-domain waveform data from the TTS
 * audio element.  When no real audio is available (idle or demo mode),
 * generates gentle simulated data that responds to the isLoading (working)
 * state so backgrounds always have something to render.
 *
 * Usage from a theme component's rAF loop:
 *   initAudioAnalysis();          // once on mount
 *   const frame = getAudioFrame(); // every frame
 *   destroyAudioAnalysis();       // on cleanup
 */

export interface AudioAnalysisData {
  /** Frequency domain data (0-255 per bin) */
  frequencyData: Uint8Array;
  /** Time domain waveform data (0-255, centered at 128) */
  waveformData: Uint8Array;
  /** Whether connected to real TTS audio */
  isRealAudio: boolean;
  /** Whether TTS is currently playing */
  isPlaying: boolean;
  /** Overall energy 0-1 (RMS of frequency data) */
  energy: number;
  /** Bass energy 0-1 (bottom quarter of bins) */
  bassEnergy: number;
  /** Mid energy 0-1 (middle half of bins) */
  midEnergy: number;
  /** Treble energy 0-1 (top quarter of bins) */
  trebleEnergy: number;
}

// ── Module-level singletons ─────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let source: MediaElementAudioSourceNode | null = null;
let connectedEl: HTMLAudioElement | null = null;
let refCount = 0;
let simPhase = 0;

const BIN_COUNT = 128; // fftSize 256 → 128 bins

// Reusable buffers
const freqBuf = new Uint8Array(BIN_COUNT);
const waveBuf = new Uint8Array(BIN_COUNT);

// ── Public API ──────────────────────────────────────────────────────────────

/** Call once when a visualizer theme mounts. Ref-counted. */
export function initAudioAnalysis(): void {
  refCount++;
}

/** Call once when a visualizer theme unmounts. Cleans up when last consumer leaves. */
export function destroyAudioAnalysis(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    if (source) { try { source.disconnect(); } catch { /* ok */ } source = null; }
    if (analyser) { try { analyser.disconnect(); } catch { /* ok */ } analyser = null; }
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {});
    }
    audioCtx = null;
    connectedEl = null;
  }
}

/** Call every animation frame.  Returns current audio data (real or simulated). */
export function getAudioFrame(): AudioAnalysisData {
  const ttsPlaying = useVoiceStore.getState().ttsPlaying;
  const isWorking = useUIStore.getState().isLoading;

  let isRealAudio = false;

  if (ttsPlaying) {
    isRealAudio = tryConnect();
  }

  if (isRealAudio && analyser) {
    analyser.getByteFrequencyData(freqBuf);
    analyser.getByteTimeDomainData(waveBuf);
  } else {
    generateSimulated(isWorking, ttsPlaying);
  }

  // Compute energy bands
  const quarter = Math.floor(BIN_COUNT / 4);
  let totalSum = 0, bassSum = 0, midSum = 0, trebleSum = 0;

  for (let i = 0; i < BIN_COUNT; i++) {
    const v = freqBuf[i];
    totalSum += v * v;
    if (i < quarter) bassSum += v * v;
    else if (i < quarter * 3) midSum += v * v;
    else trebleSum += v * v;
  }

  return {
    frequencyData: freqBuf,
    waveformData: waveBuf,
    isRealAudio,
    isPlaying: ttsPlaying,
    energy: Math.sqrt(totalSum / BIN_COUNT) / 255,
    bassEnergy: Math.sqrt(bassSum / quarter) / 255,
    midEnergy: Math.sqrt(midSum / (quarter * 2)) / 255,
    trebleEnergy: Math.sqrt(trebleSum / quarter) / 255,
  };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function tryConnect(): boolean {
  const audioEl = getTtsAudioElement();
  if (!audioEl) return false;

  // Already connected to this element
  if (connectedEl === audioEl && analyser) return true;

  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
    }

    // Disconnect old source if element changed
    if (source && connectedEl !== audioEl) {
      try { source.disconnect(); } catch { /* ok */ }
      source = null;
    }

    source = audioCtx.createMediaElementSource(audioEl);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = BIN_COUNT * 2; // 256
    analyser.smoothingTimeConstant = 0.7;

    source.connect(analyser);
    analyser.connect(audioCtx.destination);

    connectedEl = audioEl;
    return true;
  } catch {
    return false;
  }
}

function generateSimulated(isWorking: boolean, isPlaying: boolean): void {
  // Phase advances faster when working or playing
  const speed = isPlaying ? 0.14 : isWorking ? 0.08 : 0.03;
  simPhase += speed;

  // Amplitude: playing > working > idle
  const amp = isPlaying ? 0.7 : isWorking ? 0.45 : 0.2;

  // Frequency data — sine waves with harmonic layering
  for (let i = 0; i < BIN_COUNT; i++) {
    const frac = i / BIN_COUNT;
    // Base wave with two harmonics
    const base =
      Math.sin(simPhase + i * 0.25) * 0.5 +
      Math.sin(simPhase * 1.7 + i * 0.15) * 0.3 +
      Math.sin(simPhase * 0.6 + i * 0.4) * 0.2;
    const normalized = (base + 1) * 0.5; // 0-1
    // Lower frequencies are louder (natural rolloff)
    const rolloff = 1 - frac * 0.6;
    const noise = Math.random() * 0.08;
    const val = (normalized * amp * rolloff + noise) * 255;
    freqBuf[i] = Math.max(0, Math.min(255, val));
  }

  // Waveform data — centered at 128
  for (let i = 0; i < BIN_COUNT; i++) {
    const wave =
      Math.sin(simPhase * 2 + i * 0.15) * 0.4 +
      Math.sin(simPhase * 3.3 + i * 0.08) * 0.2;
    const val = 128 + wave * amp * 127;
    waveBuf[i] = Math.max(0, Math.min(255, val));
  }
}
