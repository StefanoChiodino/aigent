/**
 * Regression test: stale live-chunk STT response must not call onTranscript
 * after stopMic() has already returned.
 *
 * Bug: when the user pressed stop, in-flight live chunk requests that
 * completed *after* stopMic() were still delivered because the seq check
 * (seq > micDisplayedSeq) remained true. The stale transcript then re-injected
 * text into the input after the final transcript was already set.
 *
 * Fix: stopMic() must advance micDisplayedSeq to the current micReqSeq so
 * that any concurrent in-flight live-chunk response sees seq <= micDisplayedSeq
 * and is silently dropped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceStore } from '../stores/voice';
import { useUIStore } from '../stores/ui';
import { useConnectionStore } from '../stores/connection';

// ---- Module mocks (must be before imports of the module under test) ----

vi.mock('../lib/audio', () => ({
  encodeWav: vi.fn(() => new ArrayBuffer(0)),
  playMicSound: vi.fn(),
}));

vi.mock('../hooks/useTTS', () => ({
  ttsStopAll: vi.fn(),
  useTTS: () => ({ stopAll: vi.fn() }),
}));

// ---- fetch mock ----

// We control when each fetch promise resolves so we can simulate races.
type FetchResolver = (value: Response) => void;
const pendingFetches: FetchResolver[] = [];

const mockFetch = vi.fn((_url: string) => {
  return new Promise<Response>((resolve) => {
    pendingFetches.push(resolve);
  });
});

// ---- AudioWorkletNode port storage ----

// The mic worklet sends audio samples via port.onmessage. We capture the
// handler so tests can drive "audio arriving" manually.
let workletPortHandler: ((e: { data: { samples: Float32Array; rms: number } }) => void) | null = null;

// ---- Browser API stubs ----

class FakeAudioWorkletNode {
  port = {
    onmessage: null as ((e: { data: { samples: Float32Array; rms: number } }) => void) | null,
    postMessage: vi.fn(),
  };
  disconnect = vi.fn();

  constructor() {
    // Capture the handler reference so tests can fire messages
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    Object.defineProperty(this.port, 'onmessage', {
      set(fn) { workletPortHandler = fn; self.port._handler = fn; },
      get() { return self.port._handler; },
    });
    (this.port as Record<string, unknown>)._handler = null;
  }
}

class FakeAudioContext {
  sampleRate = 16000;
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  close = vi.fn().mockResolvedValue(undefined);
}

const mockTrack = { stop: vi.fn() };
const mockStream = { getTracks: () => [mockTrack] };

// ---- Setup / teardown ----

beforeEach(() => {
  vi.clearAllMocks();
  pendingFetches.length = 0;
  workletPortHandler = null;
  globalThis.fetch = mockFetch as unknown as typeof globalThis.fetch;

  // jsdom environment — AudioContext and AudioWorkletNode need stubs.
  // Use function constructors so `new` works correctly.
  globalThis.AudioContext = function() {
    return new FakeAudioContext();
  } as unknown as typeof AudioContext;
  globalThis.AudioWorkletNode = function() {
    return new FakeAudioWorkletNode();
  } as unknown as typeof AudioWorkletNode;

  // setup.ts defines navigator.mediaDevices — patch getUserMedia / enumerateDevices
  Object.assign(navigator.mediaDevices, {
    getUserMedia: vi.fn().mockResolvedValue(mockStream),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  });

  // Reset stores
  useVoiceStore.setState({
    micState: 'idle',
    micSticky: false,
    vadActive: false,
    micDeviceId: '',
    micDeviceLabel: '',
    speakerDeviceId: '',
    speakerDeviceLabel: '',
    ttsAutoSpeak: false,
    ttsRatePct: 25,
    ttsPlaying: false,
    ttsSpeakingId: null,
    speakBlockSpoken: false,
  });
  useUIStore.setState({ error: null });
  useConnectionStore.setState({ send: vi.fn() } as unknown as ReturnType<typeof useConnectionStore.getState>);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- Import hook under test ----

import { useMic } from '../hooks/useMic';

// ---- Tests ----

describe('useMic — stopMic discards in-flight live chunk responses', () => {
  it('does NOT call onTranscript after stopMic when a live chunk resolves late', async () => {
    const onTranscript = vi.fn();

    const { result } = renderHook(() => useMic(onTranscript));

    vi.useFakeTimers();

    // Start recording
    await act(async () => {
      const startPromise = result.current.startMic(true, '');
      // addModule is async — flush promises
      await Promise.resolve();
      await Promise.resolve();
      await startPromise;
    });

    expect(useVoiceStore.getState().micState).toBe('recording');

    // Simulate audio arriving via the worklet port so micSamples is non-empty
    // (sendLiveChunk returns early if there are no samples)
    expect(workletPortHandler).not.toBeNull();
    await act(async () => {
      workletPortHandler!({
        data: { samples: new Float32Array(1600), rms: 0.001 },
      });
      await Promise.resolve();
    });

    // Advance timers so the 800 ms initial sendLiveChunk fires
    await act(async () => {
      vi.advanceTimersByTime(900);
      await Promise.resolve();
    });

    // One live chunk fetch should be in-flight
    expect(pendingFetches.length).toBeGreaterThanOrEqual(1);
    const staleChunkResolve = pendingFetches.shift()!;

    // Stop the mic — this should abort in-flight live chunks and fire a final fetch
    const stopPromise = act(async () => {
      await result.current.stopMic(true);
    });

    // Let stop proceed: it needs to await micAudioCtx.close() and the final /stt
    // Resolve the final fetch (if any) with empty text
    await act(async () => {
      await Promise.resolve();
      if (pendingFetches.length > 0) {
        pendingFetches.shift()!(new Response(JSON.stringify({ text: '' }), { status: 200 }));
      }
      await Promise.resolve();
    });

    await stopPromise;

    expect(useVoiceStore.getState().micState).toBe('idle');

    // Record how many times onTranscript has been called so far
    const callCountAfterStop = onTranscript.mock.calls.length;

    // Now the stale live-chunk response arrives with different text.
    // Before the fix: onTranscript would be called again.
    // After the fix: it must be silently dropped.
    await act(async () => {
      staleChunkResolve(
        new Response(JSON.stringify({ text: 'stale text injected after stop' }), { status: 200 }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onTranscript).toHaveBeenCalledTimes(callCountAfterStop);
    const lastCalls = onTranscript.mock.calls;
    for (const [text] of lastCalls.slice(callCountAfterStop)) {
      expect(text).not.toContain('stale text');
    }
  });
});
