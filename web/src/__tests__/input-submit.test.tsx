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
import { useSettingsStore } from '../stores/settings';
import { InputArea } from '../components/InputArea';

// --- Mock heavy dependencies that InputArea imports but we don't need ---

const mockStartMic = vi.fn();
const mockStopMic = vi.fn().mockResolvedValue(undefined);
const mockAbortMic = vi.fn();
const mockClearTranscript = vi.fn();
const mockCommitBase = vi.fn();

// Capture the onTranscript callback so tests can simulate STT output
let capturedOnTranscript: ((text: string, windowCapped: boolean) => void) | null = null;

vi.mock('../hooks/useMic', () => ({
  useMic: (cb: (text: string, windowCapped: boolean) => void) => {
    capturedOnTranscript = cb;
    return {
      startMic: mockStartMic,
      stopMic: mockStopMic,
      abortMic: mockAbortMic,
      clearTranscript: mockClearTranscript,
      commitBase: mockCommitBase,
    };
  },
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
    mockCommitBase.mockReset();
    capturedOnTranscript = null;
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
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'message', content: 'hello world' }));
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
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'message', content: 'click send' }));
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

  // ── Disconnected WebSocket: preserves input and shows error ────────────────

  it('preserves input and shows error when WebSocket is disconnected', async () => {
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

    // Input is preserved (not cleared) so user doesn't lose their message
    expect((input as HTMLTextAreaElement).value).toBe('lost message');
    // Nothing was sent
    expect(ws.send).not.toHaveBeenCalled();
    // Error is shown to the user
    expect(useUIStore.getState().errorMsg).toMatch(/not connected/i);
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
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'message', content: '/reset' }));
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

  it('hold:Escape (1s) while loading sends cancel', async () => {
    vi.useFakeTimers();
    try {
      useUIStore.setState({ isLoading: true });

      renderInputArea();
      const input = screen.getByRole('textbox');

      // Press and hold Escape
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
      });

      // No cancel yet — not held long enough
      expect(sentPayloads(ws)).not.toContainEqual({ type: 'cancel' });

      // Advance past the 1-second hold threshold
      await act(async () => { vi.advanceTimersByTime(1100); });

      expect(sentPayloads(ws)).toContainEqual({ type: 'cancel' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('plain Escape released early while loading does NOT send cancel (hold:Escape requires 1s hold)', async () => {
    vi.useFakeTimers();
    try {
      useUIStore.setState({ isLoading: true });

      renderInputArea();
      const input = screen.getByRole('textbox');

      // Press Escape
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
      });

      // Release before 1 second
      await act(async () => { vi.advanceTimersByTime(500); });
      await act(async () => {
        fireEvent.keyUp(input, { key: 'Escape', code: 'Escape' });
      });

      // Advance well past 1 second to confirm timer was cancelled
      await act(async () => { vi.advanceTimersByTime(1000); });

      expect(sentPayloads(ws)).not.toContainEqual({ type: 'cancel' });
    } finally {
      vi.useRealTimers();
    }
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

  // ── STT suffix preservation ─────────────────────────────────────────────

  it('onTranscript sets the input value', async () => {
    renderInputArea();
    expect(capturedOnTranscript).not.toBeNull();

    await act(async () => {
      capturedOnTranscript!('hello from stt', false);
    });

    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toBe('hello from stt');
  });

  it('onTranscript preserves user-typed suffix', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    // First STT chunk sets the input
    await act(async () => {
      capturedOnTranscript!('hello', false);
    });
    expect(input.value).toBe('hello');

    // User types additional text at the end
    await act(async () => {
      fireEvent.change(input, { target: { value: 'hello world' } });
    });
    expect(input.value).toBe('hello world');

    // Next STT chunk arrives — should preserve " world" suffix
    await act(async () => {
      capturedOnTranscript!('hello there', false);
    });
    expect(input.value).toBe('hello there world');
  });

  it('clear button resets STT tracking so no ghost suffix appears', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    // STT sets some text
    await act(async () => {
      capturedOnTranscript!('old text', false);
    });
    expect(input.value).toBe('old text');

    // User clears the input via the ✕ button
    const clearBtn = document.getElementById('input-clear')!;
    await act(async () => {
      fireEvent.click(clearBtn);
    });
    expect(input.value).toBe('');

    // New STT arrives — should not carry over "old text" as a ghost suffix
    await act(async () => {
      capturedOnTranscript!('fresh start', false);
    });
    expect(input.value).toBe('fresh start');
  });

  it('submit resets STT tracking', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    // STT sets text, user appends, then submits
    await act(async () => {
      capturedOnTranscript!('dictated', false);
    });
    await act(async () => {
      fireEvent.change(input, { target: { value: 'dictated extra' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });
    expect(input.value).toBe('');

    // New STT after submit — no ghost suffix
    await act(async () => {
      capturedOnTranscript!('new dictation', false);
    });
    expect(input.value).toBe('new dictation');
  });

  it('onTranscript replaces fully when user edited within STT text', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    // STT sets text
    await act(async () => {
      capturedOnTranscript!('the quick brown fox', false);
    });

    // User edits in the middle (no longer starts with old STT)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'a quick brown fox' } });
    });

    // Next STT chunk — can't detect suffix, should just replace
    await act(async () => {
      capturedOnTranscript!('the quick red fox', false);
    });
    expect(input.value).toBe('the quick red fox');
  });

  it('editing during recording calls commitBase so paste is preserved', async () => {
    // Mic is recording (always-on mode)
    useVoiceStore.setState({ micState: 'recording' });

    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    // User pastes text while mic is recording
    await act(async () => {
      fireEvent.change(input, { target: { value: 'pasted code snippet' } });
    });

    // commitBase should have been called with the pasted text
    expect(mockCommitBase).toHaveBeenCalledWith('pasted code snippet');

    // lastSttValueRef should now match the pasted text, so the next
    // STT chunk that includes the paste as base won't overwrite it
    await act(async () => {
      capturedOnTranscript!('pasted code snippet new speech', false);
    });
    expect(input.value).toBe('pasted code snippet new speech');
  });

  it('editing while NOT recording does not call commitBase', async () => {
    useVoiceStore.setState({ micState: 'idle' });

    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'normal typing' } });
    });

    expect(mockCommitBase).not.toHaveBeenCalled();
  });
});

// ── Multiline Enter mode ────────────────────────────────────────────────────

describe('InputArea multiline-enter mode', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    useUIStore.setState({
      isLoading: false,
      errorMsg: null,
      thinkingLevel: 'off',
      permQueue: [],
      pendingAttachments: [],
    });
    useVoiceStore.setState({
      micState: 'idle',
      vadActive: false,
      ttsPlaying: false,
      micSticky: false,
    });
    // Enable multiline-enter mode
    useSettingsStore.setState({
      clientSettings: { AIGENT_MULTILINE_ENTER: true },
    });
  });

  afterEach(() => {
    cleanup();
    // Reset settings
    useSettingsStore.setState({ clientSettings: {} });
  });

  it('plain Enter does NOT send in multiline mode', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'hello' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
    });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('Ctrl+Enter sends the message in multiline mode', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'multiline send' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', ctrlKey: true });
    });

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual(expect.objectContaining({ type: 'message', content: 'multiline send' }));
  });

  it('Shift+Enter sends with thinkingOverride in multiline mode', async () => {
    useUIStore.setState({ thinkingLevel: 'off' });

    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'think multiline' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
    });

    const payloads = sentPayloads(ws);
    const thinkMsg = payloads.find(p => p.type === 'message' && p.thinkingOverride);
    expect(thinkMsg).toBeDefined();
    expect(thinkMsg!.content).toBe('think multiline');
    expect(thinkMsg!.thinkingOverride).toBe('high');
  });

  it('Shift+Enter does NOT insert newline in multiline mode (it sends)', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox');

    await act(async () => {
      fireEvent.change(input, { target: { value: 'test' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', shiftKey: true });
    });

    // Message was sent (thinking override), input cleared
    expect((input as HTMLTextAreaElement).value).toBe('');
  });
});

// ── Undo Escape clear ──────────────────────────────────────────────────────

describe('InputArea undo Escape clear', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    useUIStore.setState({
      isLoading: false,
      errorMsg: null,
      thinkingLevel: 'off',
      permQueue: [],
      pendingAttachments: [],
    });
    useVoiceStore.setState({
      micState: 'idle',
      vadActive: false,
      ttsPlaying: false,
      micSticky: false,
    });
    useSettingsStore.setState({ clientSettings: {} });
    sessionStorage.removeItem('aigent-draft');
  });

  afterEach(() => {
    cleanup();
  });

  it('Escape clears the input', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: 'draft text' } });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });

    expect(input.value).toBe('');
  });

  it('second Escape restores the cleared draft', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: 'important draft' } });
    });
    // First Escape: clear
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('');

    // Second Escape: undo — restore the draft
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('important draft');
  });

  it('third Escape clears again (toggle behavior)', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: 'toggle text' } });
    });
    // Escape 1: clear
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('');

    // Escape 2: undo
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('toggle text');

    // Escape 3: clear again
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('');
  });

  it('✕ button clear can be undone with Escape', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    await act(async () => {
      fireEvent.change(input, { target: { value: 'button draft' } });
    });

    // Clear via ✕ button
    const clearBtn = document.getElementById('input-clear')!;
    await act(async () => {
      fireEvent.click(clearBtn);
    });
    expect(input.value).toBe('');

    // Escape restores it
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('button draft');
  });

  it('Escape on empty input with no previous draft does nothing', async () => {
    renderInputArea();
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;

    expect(input.value).toBe('');

    // Escape on empty — should not crash or change anything
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' });
    });
    expect(input.value).toBe('');
  });
});
