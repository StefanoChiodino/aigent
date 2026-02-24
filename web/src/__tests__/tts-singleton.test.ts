/**
 * TTS singleton — verifies that useTTS() shares state across hook instances.
 *
 * The bug: App.tsx calls useTTS().flushStream to start TTS playback,
 * but InputArea.tsx calls useTTS().stopAll to stop it. Before the fix,
 * each hook instance had its own refs, so stopAll couldn't stop audio
 * started by a different instance.
 *
 * Runs in jsdom via vitest — no Docker, no gatekeeper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceStore } from '../stores/voice';

// Mock demo mode off
vi.mock('../demo/useDemoMode', () => ({
  isDemo: () => false,
  getDemoWebSocket: () => null,
  useDemoMode: () => {},
}));

// Mock markdown helpers
vi.mock('../lib/markdown', () => ({
  stripMarkdownForTTS: (t: string) => t,
  extractSpeakContent: (t: string) => null,
}));

// Mock fetch for TTS requests
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Mock Audio
class MockAudio {
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn().mockResolvedValue(undefined);
}
globalThis.Audio = MockAudio as unknown as typeof Audio;

// URL.createObjectURL / revokeObjectURL
globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
globalThis.URL.revokeObjectURL = vi.fn();

describe('TTS singleton state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVoiceStore.setState({ ttsPlaying: false, ttsAutoSpeak: false, ttsRatePct: 0 });
  });

  it('stopAll from instance B stops audio started by instance A', async () => {
    // Dynamically import so mocks are in place
    const { useTTS } = await import('../hooks/useTTS');

    // Instance A (like App.tsx)
    const hookA = renderHook(() => useTTS());
    // Instance B (like InputArea.tsx)
    const hookB = renderHook(() => useTTS());

    // Simulate TTS playback started via instance A's speakText
    const mockBlob = new Blob(['audio'], { type: 'audio/mpeg' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      blob: () => Promise.resolve(mockBlob),
    });

    act(() => {
      hookA.result.current.speakText('Hello world');
    });

    // Wait for the fetch to resolve
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // Now instance B calls stopAll (like cancel button in InputArea)
    act(() => {
      hookB.result.current.stopAll();
    });

    // ttsPlaying should be false (stopAll cleared it)
    expect(useVoiceStore.getState().ttsPlaying).toBe(false);
  });

  it('stopStream from instance B clears queue started by instance A', async () => {
    const { useTTS } = await import('../hooks/useTTS');

    const hookA = renderHook(() => useTTS());
    const hookB = renderHook(() => useTTS());

    // ttsStreamLastLen should be shared
    hookA.result.current.ttsStreamLastLen.current = 42;
    expect(hookB.result.current.ttsStreamLastLen.current).toBe(42);

    // stopStream resets it
    act(() => {
      hookB.result.current.stopStream();
    });
    expect(hookA.result.current.ttsStreamLastLen.current).toBe(0);
  });

  it('ttsStreamLastLen is the same object across instances', async () => {
    const { useTTS } = await import('../hooks/useTTS');

    const hookA = renderHook(() => useTTS());
    const hookB = renderHook(() => useTTS());

    expect(hookA.result.current.ttsStreamLastLen).toBe(hookB.result.current.ttsStreamLastLen);
  });
});
