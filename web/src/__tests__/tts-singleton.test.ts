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
import * as markdownLib from '../lib/markdown';

// Mock demo mode off
vi.mock('../demo/useDemoMode', () => ({
  isDemo: () => false,
  getDemoWebSocket: () => null,
  useDemoMode: () => {},
}));

// Mock markdown helpers — extractSpeakContent is overridden per-test below
vi.mock('../lib/markdown', () => ({
  stripMarkdownForTTS: (t: string) => t,
  extractSpeakContent: vi.fn((_t: string) => null),
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

describe('flushStream — <speak> block handling (short mode)', () => {
  const extractSpeakMock = vi.mocked(markdownLib.extractSpeakContent);

  beforeEach(() => {
    vi.clearAllMocks();
    extractSpeakMock.mockReturnValue(null);
    useVoiceStore.setState({
      ttsAutoSpeak: true,
      ttsPlaying: false,
      ttsRatePct: 0,
      speakBlockSpoken: false,
    });
    // Reset streaming text
    useChatStore.setState(s => ({ streaming: { ...s.streaming, text: '', active: true } }));
  });

  it('speaks only the <speak> content when the block is complete', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    // Reset the stream pointer
    act(() => { hook.result.current.stopStream(); });

    // Set streaming text with a complete <speak> block
    const speakText = 'This is the spoken summary.';
    useChatStore.getState().setStreamText(`<speak>${speakText}</speak>\n\nFull markdown body here.`);
    extractSpeakMock.mockReturnValue(speakText);

    // Flush should POST to /tts with the speak content (not the raw tags)
    mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) });
    act(() => { hook.result.current.flushStream(); });

    await vi.waitFor(() => { expect(mockFetch).toHaveBeenCalledTimes(1); });

    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/tts');
    expect(opts.body).toBe(speakText);
    // speakBlockSpoken should now be true
    expect(useVoiceStore.getState().speakBlockSpoken).toBe(true);
  });

  it('does not speak when <speak> is open but </speak> has not arrived yet', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Partial: opening tag present but closing tag missing
    useChatStore.getState().setStreamText('<speak>Still streaming...');
    // extractSpeakContent returns null (no closing tag yet)
    extractSpeakMock.mockReturnValue(null);

    act(() => { hook.result.current.flushStream(); });

    // Nothing should have been sent to TTS
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not speak a second time if speakBlockSpoken is already true', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    useVoiceStore.setState({ speakBlockSpoken: true });
    useChatStore.getState().setStreamText('<speak>Summary.</speak>\n\nMore text.');
    extractSpeakMock.mockReturnValue('Summary.');

    act(() => { hook.result.current.flushStream(); });
    act(() => { hook.result.current.flushStream(); });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to normal sentence chunking when no <speak> tag is present', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const hook = renderHook(() => useTTS());
    act(() => { hook.result.current.stopStream(); });

    // Plain response — no short mode tags
    useChatStore.getState().setStreamText('Hello there. How can I help you today? ');
    extractSpeakMock.mockReturnValue(null);

    mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(new Blob(['audio'])) });
    act(() => { hook.result.current.flushStream(); });

    await vi.waitFor(() => { expect(mockFetch).toHaveBeenCalledTimes(1); });
    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Should have spoken the text up to a sentence boundary
    expect(typeof opts.body).toBe('string');
    expect((opts.body as string).length).toBeGreaterThan(0);
    // Should NOT contain any <speak> tag
    expect(opts.body as string).not.toContain('<speak>');
  });
});
