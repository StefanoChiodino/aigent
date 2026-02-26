/**
 * InputArea submission — verifies the message-sending flow works end to end.
 *
 * Renders the real InputArea component with a mock WebSocket,
 * then simulates user actions and asserts that the correct messages
 * are sent (or not sent) over the wire.
 *
 * Runs in jsdom via vitest — no Docker, no gatekeeper, ~500ms.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { InputArea } from '../components/InputArea';

// --- Mock heavy dependencies that InputArea imports but we don't need ---

const mockStartMic = vi.fn();
const mockStopMic = vi.fn().mockResolvedValue(undefined);
const mockAbortMic = vi.fn();
const mockClearTranscript = vi.fn();

vi.mock('../hooks/useMic', () => ({
  useMic: () => ({
    startMic: mockStartMic,
    stopMic: mockStopMic,
    abortMic: mockAbortMic,
    clearTranscript: mockClearTranscript,
  }),
}));

vi.mock('../hooks/useTTS', () => ({
  useTTS: () => ({
    speakText: vi.fn(),
    stopAll: vi.fn(),
    stopStream: vi.fn(),
    enqueueChunk: vi.fn(),
    flushStream: vi.fn(),
    ttsStreamLastLen: { current: 0 },
  }),
}));

vi.mock('../lib/screen', () => ({
  captureScreenshot: () => null,
  registerScreenCapCallback: vi.fn(),
  startScreenShare: vi.fn().mockResolvedValue(undefined),
}));

// --- Helpers ---

function fakeWs() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
}

/** Return all payloads sent via WebSocket so far. */
function sentPayloads(ws: WebSocket): Record<string, unknown>[] {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
  );
}

function renderInputArea() {
  return render(<InputArea />);
}

describe('InputArea submission', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    // Wire up connection store with the fake WS
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    // Reset UI store to idle state
    useUIStore.setState({
      isLoading: false,
      errorMsg: null,
      thinkingLevel: 'off',
      permQueue: [],
      pendingAttachments: [],
      mountsList: [],
    });
    // Reset voice store
    useVoiceStore.setState({
      micState: 'idle',
      vadActive: false,
      ttsPlaying: false,
      micSticky: false,
    });
    // Reset mic mocks
    mockStartMic.mockReset();
    mockStopMic.mockReset().mockResolvedValue(undefined);
    mockAbortMic.mockReset();
    mockClearTranscript.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Core: pressing Enter sends the message ─────────────────────────────────

  it('Enter sends {type:"message", content} over WebSocket', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'hello world' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'message', content: 'hello world' });
  });

  it('input clears after Enter', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: 'test message' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    expect(input.value).toBe('');
  });

  it('clicking send button sends the message', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'click send' } });
    });

    const sendBtn = document.getElementById('send')!;
    await act(async () => {
      fireEvent.click(sendBtn);
    });

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'message', content: 'click send' });
  });

  // ── Guards: things that should NOT send ────────────────────────────────────

  it('empty input does not send on Enter', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('whitespace-only input does not send on Enter', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: '   \n  ' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('Shift+Enter does not send (inserts newline)', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'line one' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  // ── Disconnected WebSocket: silent failure ─────────────────────────────────

  it('message is silently lost when WebSocket is disconnected', async () => {
    // Set WS to null (disconnected)
    useConnectionStore.setState({ ws: null });

    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'lost message' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    // Input still clears (the component doesn't know the WS is dead)
    expect((input as HTMLTextAreaElement).value).toBe('');
    // But nothing was sent
    expect(ws.send).not.toHaveBeenCalled();
  });

  // ── Slash commands go through the same path ────────────────────────────────

  it('slash commands are sent as type:message', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: '/reset' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'message', content: '/reset' });
  });

  // ── Thinking override with Ctrl+Enter ──────────────────────────────────────

  it('Ctrl+Enter sends with thinkingOverride', async () => {
    // thinkingLevel 'off' means Ctrl+Enter should send thinkingOverride:'high'
    useUIStore.setState({ thinkingLevel: 'off' });

    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'think about this' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ctrlKey: true });
    });

    const payloads = sentPayloads(ws);
    const thinkMsg = payloads.find(p => p.type === 'message' && p.thinkingOverride);
    expect(thinkMsg).toBeDefined();
    expect(thinkMsg!.content).toBe('think about this');
    expect(thinkMsg!.thinkingOverride).toBe('high');
  });

  // ── Cancel button ──────────────────────────────────────────────────────────

  it('cancel button sends {type:"cancel"} when loading', async () => {
    useUIStore.setState({ isLoading: true });

    renderInputArea();
    const cancelBtn = document.getElementById('cancel')!;

    await act(async () => {
      fireEvent.click(cancelBtn);
    });

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'cancel' });
  });

  // ── Escape when loading sends cancel ───────────────────────────────────────

  it('Escape while loading sends cancel', async () => {
    useUIStore.setState({ isLoading: true });

    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'cancel' });
  });

  // ── Cancel button visible when TTS is playing (not loading) ───────────────

  it('cancel button is visible when ttsPlaying is true even if not loading', async () => {
    useUIStore.setState({ isLoading: false });
    useVoiceStore.setState({ ttsPlaying: true });

    renderInputArea();
    const cancelBtn = document.getElementById('cancel')!;
    expect(cancelBtn.classList.contains('hidden')).toBe(false);
  });

  it('cancel button is hidden when neither loading nor ttsPlaying', async () => {
    useUIStore.setState({ isLoading: false });
    useVoiceStore.setState({ ttsPlaying: false });

    renderInputArea();
    const cancelBtn = document.getElementById('cancel')!;
    expect(cancelBtn.classList.contains('hidden')).toBe(true);
  });

  // ── Mic sticky + empty submit restarts mic ────────────────────────────────

  it('empty submit with mic recording + sticky restarts mic via send button', async () => {
    vi.useFakeTimers();
    try {
      // Mic is recording and sticky mode is on
      useVoiceStore.setState({ micState: 'recording', micSticky: true });

      renderInputArea();

      // Click the send button with empty input (bypasses the "while dictating" Enter path)
      const sendBtn = document.getElementById('send')!;
      await act(async () => {
        fireEvent.click(sendBtn);
      });

      // abortMic should have been called (mic was recording)
      expect(mockAbortMic).toHaveBeenCalled();
      // No message should have been sent (empty input)
      expect(ws.send).not.toHaveBeenCalled();
      // startMic should be called after the 100ms timeout to restart in sticky mode
      await act(async () => { vi.advanceTimersByTime(150); });
      expect(mockStartMic).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
