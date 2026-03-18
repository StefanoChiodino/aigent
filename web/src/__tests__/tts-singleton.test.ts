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
import { useChatStore } from '../stores/chat';

// Mock demo mode off
vi.mock('../demo/useDemoMode', () => ({
  isDemo: () => false,
  getDemoWebSocket: () => null,
  useDemoMode: () => {},
}));

// Mock markdown helpers
vi.mock('../lib/markdown', () => ({
  stripMarkdownForTTS: (t: string) => t,
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
    useVoiceStore.setState({ ttsPlaying: false, ttsSpeakingId: null, ttsAutoSpeak: false, ttsRatePct: 0 });
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

describe('flushStream — spokenText handling (short mode)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useVoiceStore.setState({
      ttsAutoSpeak: true,
      ttsPlaying: false,
      ttsSpeakingId: null,
      ttsRatePct: 0,
      speakBlockSpoken: false,
    });
    // Reset streaming state — text is clean (no speak tags), spokenText is structured
    useChatStore.setState(s => ({
      streaming: { ...s.streaming, text: '', spokenText: null, active: true },
    }));
    // These tests assume short mode is on (spokenText only matters in short mode)
    const { useUIStore } = await import('../stores/ui');
    useUIStore.setState({ shortMode: true });
  });

  it('speaks the spokenText when present', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Server sends clean text + structured spokenText
    useChatStore.getState().setStreamText('Full markdown body here.');
    useChatStore.getState().setStreamSpokenText('This is the spoken summary.');

    mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) });
    act(() => { hook.result.current.flushStream(); });

    await vi.waitFor(() => { expect(mockFetch).toHaveBeenCalledTimes(1); });

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/synthesize');
    expect(opts.body).toBe('This is the spoken summary.');
    expect(useVoiceStore.getState().speakBlockSpoken).toBe(true);
  });

  it('does not speak when spokenText is null (waiting for server)', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Text is streaming but no spokenText event yet
    useChatStore.getState().setStreamText('Still streaming...');
    // spokenText remains null from beforeEach

    act(() => { hook.result.current.flushStream(); });

    // Nothing sent — waiting for spokenText or sentence boundary
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not speak a second time if speakBlockSpoken is already true', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    useVoiceStore.setState({ speakBlockSpoken: true });
    useChatStore.getState().setStreamText('More text.');
    useChatStore.getState().setStreamSpokenText('Summary.');

    act(() => { hook.result.current.flushStream(); });
    act(() => { hook.result.current.flushStream(); });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not speak post-tool text when speakBlockSpoken is true', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Simulate: spokenText was spoken, then tool ran, new text arrives
    useVoiceStore.setState({ speakBlockSpoken: true });
    useChatStore.getState().setStreamText('Here are the results of the search. Found 5 files. ');

    act(() => { hook.result.current.flushStream(); });
    act(() => { hook.result.current.flushStream(true); });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to normal sentence chunking in non-short mode', async () => {
    const { useUIStore } = await import('../stores/ui');
    useUIStore.setState({ shortMode: false });

    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Plain response — not in short mode, no spokenText
    useChatStore.getState().setStreamText('Hello there. How can I help you today? ');

    mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) });
    act(() => { hook.result.current.flushStream(); });

    await vi.waitFor(() => { expect(mockFetch).toHaveBeenCalledTimes(1); });
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(typeof opts.body).toBe('string');
    expect((opts.body as string).length).toBeGreaterThan(0);
  });

  it('non-short mode ignores spokenText and speaks full text', async () => {
    const { useUIStore } = await import('../stores/ui');
    useUIStore.setState({ shortMode: false });

    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // speak_text tool fired, setting spokenText — but we're in "on" mode
    useChatStore.getState().setStreamSpokenText('Short summary.');
    useChatStore.getState().setStreamText('Full detailed response here. More sentences follow. ');

    mockFetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) });
    act(() => { hook.result.current.flushStream(); });

    await vi.waitFor(() => { expect(mockFetch).toHaveBeenCalled(); });
    // Should speak the full text, NOT the spokenText summary
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toContain('Full detailed response');
    // speakBlockSpoken should NOT be set in non-short mode
    expect(useVoiceStore.getState().speakBlockSpoken).toBe(false);
  });

  it('speaks new spokenText even if speakBlockSpoken was true from previous turn', async () => {
    const { useUIStore } = await import('../stores/ui');
    useUIStore.setState({ shortMode: true });

    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Simulate: previous turn spoke, speakBlockSpoken is true
    useVoiceStore.setState({ speakBlockSpoken: true });
    
    // New turn: server sends new spokenText (should be spoken despite speakBlockSpoken=true)
    useChatStore.getState().setStreamSpokenText('New summary for new turn.');
    
    mockFetch.mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) });
    act(() => { hook.result.current.flushStream(); });

    await vi.waitFor(() => { expect(mockFetch).toHaveBeenCalledTimes(1); });
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toBe('New summary for new turn.');
  });
});
