/**
 * TTS Browser Integration Tests - TDD approach
 * Tests the actual browser TTS functionality
 */

import { beforeAll, describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useVoiceStore } from '../stores/voice';
import { useChatStore } from '../stores/chat';
import { useUIStore } from '../stores/ui';

// Setup jsdom environment
beforeAll(() => {
  // Mock Audio API
  class MockAudio {
    src = '';
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn().mockResolvedValue(undefined);
    setSinkId = vi.fn();
  }
  globalThis.Audio = MockAudio as unknown as typeof Audio;

  // Mock fetch
  const mockFetch = vi.fn();
  globalThis.fetch = mockFetch;
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock');
  globalThis.URL.revokeObjectURL = vi.fn();
});

// Mock demo mode
vi.mock('../demo/useDemoMode', () => ({
  isDemo: () => false,
  getDemoWebSocket: () => null,
  useDemoMode: () => {},
}));

// Mock markdown
vi.mock('../lib/markdown', () => ({
  stripMarkdownForTTS: (t: string) => t,
}));

describe('TTS Browser Integration', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'])),
    });
    globalThis.fetch = mockFetch;
    
    useVoiceStore.setState({
      ttsAutoSpeak: true,
      ttsRatePct: 25,
      ttsPlaying: false,
      micState: 'idle',
      speakBlockSpoken: false,
    });
    useChatStore.setState({
      streaming: { text: '', spokenText: null, active: false },
    });
    useUIStore.setState({ shortMode: true });
  });

  it('should call TTS endpoint with correct rate parameter', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    const mockResponse = {
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'])),
    };
    mockFetch.mockResolvedValueOnce(mockResponse);

    act(() => {
      result.current.speakText('Hello world');
    });

    // Wait for fetch to be called
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    // Check that fetch was called with correct parameters
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/synthesize');
    expect(url).toContain('%2B25%25');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('Hello world');
  });

  it('should handle negative rate parameters', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    useVoiceStore.getState().setTtsRatePct(-10);

    const mockResponse = {
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'])),
    };
    mockFetch.mockResolvedValueOnce(mockResponse);

    act(() => {
      result.current.speakText('Test');
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('rate=-10%25');
  });

  it('should handle rate parameter with spaces', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    useVoiceStore.getState().setTtsRatePct(25);

    act(() => {
      result.current.speakText('Test');
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
    // Rate should be properly formatted as +25% (URL-encoded as %2B25%25)
    expect(url).toContain('%2B25%25');
  });

  it('should stop all TTS when stopAll is called', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    const mockResponse = {
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'])),
    };
    mockFetch.mockResolvedValueOnce(mockResponse);

    act(() => {
      result.current.speakText('Hello');
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    act(() => {
      result.current.stopAll();
    });

    expect(useVoiceStore.getState().ttsPlaying).toBe(false);
  });

  it('should handle empty text gracefully', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    act(() => {
      result.current.speakText('');
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should handle text with special characters', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    const mockResponse = {
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio'])),
    };
    mockFetch.mockResolvedValueOnce(mockResponse);

    act(() => {
      result.current.speakText('Hello, world! How are you?');
    });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalled();
    });

    const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(typeof opts.body).toBe('string');
    expect((opts.body as string).length).toBeGreaterThan(0);
  });
});
