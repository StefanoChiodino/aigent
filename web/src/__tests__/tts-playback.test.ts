/**
 * TTS Audio Playback Tests
 * Tests that audio actually plays in the browser
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

describe('TTS Audio Playback', () => {
  let mockPlay: any;
  let mockPause: any;
  let actualAudioInstance: any = null;

  beforeEach(() => {
    mockPlay = vi.fn().mockResolvedValue(undefined);
    mockPause = vi.fn();
    
    // Create a single Audio instance that we track
    const mockAudioInstance = {
      src: '',
      onended: null,
      onerror: null,
      pause: mockPause,
      play: mockPlay,
      setSinkId: vi.fn(),
    };
    
    actualAudioInstance = mockAudioInstance;

    class MockAudio {
      src = '';
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause = mockPause;
      play = mockPlay;
      setSinkId = vi.fn();
    }
    globalThis.Audio = MockAudio as unknown as typeof Audio;

    // Mock fetch to return audio blob
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(new Blob(['audio-data'], { type: 'audio/mp3' })),
    });
    globalThis.fetch = mockFetch;
    globalThis.URL.createObjectURL = vi.fn().mockReturnValue('blob:mock-url');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
    actualAudioInstance = null;
  });

  it('should play audio when speakText is called', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    act(() => {
      result.current.speakText('Test audio playback');
    });

    // Wait for audio to be created and play called
    await new Promise(resolve => setTimeout(resolve, 100));

    // Check that Audio.play was called
    expect(mockPlay).toHaveBeenCalled();
  });

  it('should handle audio errors gracefully', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    
    // Mock fetch to return error
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    globalThis.fetch = mockFetch;

    const { result } = renderHook(() => useTTS());

    // Should not throw error
    expect(() => {
      act(() => {
        result.current.speakText('Test error handling');
      });
    }).not.toThrow();
  });

  it('should stop audio when stopAll is called', async () => {
    const { useTTS } = await import('../hooks/useTTS');
    const { result } = renderHook(() => useTTS());

    act(() => {
      result.current.speakText('Test stop');
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    act(() => {
      result.current.stopAll();
    });

    // Check that audio was stopped
    expect(mockPause).toHaveBeenCalled();
  });
});
