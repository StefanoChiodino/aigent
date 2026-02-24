/**
 * Regression test for the StrictMode WebSocket race condition.
 *
 * In React StrictMode (used in dev), effects run twice:
 *   mount → cleanup → remount
 *
 * The useWebSocket hook creates a WebSocket in its effect. When cleanup
 * closes the old WebSocket, its `onclose` fires asynchronously — AFTER
 * the remount has already created and stored a new WebSocket. If the
 * onclose handler unconditionally calls setWs(null), it wipes the new
 * connection, causing all subsequent send() calls to silently drop.
 *
 * This test verifies the guard: onclose only clears the store if the
 * closing WebSocket is still the current one.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useConnectionStore } from '../stores/connection';
import { useChatStore } from '../stores/chat';

// --- Mock WebSocket ---

type WsHandler = ((ev: { data: string }) => void) | (() => void) | null;

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: WsHandler = null;
  onmessage: WsHandler = null;
  onclose: WsHandler = null;
  onerror: WsHandler = null;
  send = vi.fn();

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  /** Simulate server accepting the connection. */
  _open() {
    this.readyState = FakeWebSocket.OPEN;
    if (this.onopen) (this.onopen as () => void)();
  }

  /** Simulate connection closing (fires onclose synchronously). */
  _close() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) (this.onclose as () => void)();
  }

  close() {
    this.readyState = FakeWebSocket.CLOSING;
    // Real WebSocket fires onclose asynchronously — use a microtask.
    // Tests that need synchronous control should call _close() directly.
    queueMicrotask(() => this._close());
  }
}

// Install the fake WebSocket globally
const OriginalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  FakeWebSocket.instances = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  // Reset stores
  useConnectionStore.setState({ status: 'connecting', ws: null, reconnectAttempt: 0 });
  useChatStore.setState({
    messages: [],
    streaming: {
      active: false, text: '', isThinking: false, thinkingText: '',
      currentToolOutput: '', traces: [], turnStartCtx: 0,
    },
  });
});

afterEach(() => {
  cleanup();
  (globalThis as Record<string, unknown>).WebSocket = OriginalWebSocket;
});

describe('useWebSocket StrictMode race condition', () => {
  /**
   * Simulates the exact StrictMode race:
   *   1. Mount hook → creates ws1
   *   2. Unmount (cleanup) → calls ws1.close()
   *   3. Remount hook → creates ws2, stores it
   *   4. ws1 onclose fires (async) → must NOT wipe ws2
   */
  it('old WebSocket onclose does NOT wipe new connection', async () => {
    const { useWebSocket } = await import('../hooks/useWebSocket');

    // Step 1+2: Mount then unmount — simulates StrictMode's first mount/cleanup cycle
    const { unmount } = renderHook(() => useWebSocket());
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws1 = FakeWebSocket.instances[0]!;

    // Hold a reference to ws1's onclose so we can fire it later (after unmount)
    unmount();
    const ws1OnClose = ws1.onclose;

    // Step 3: Remount — simulates StrictMode's second mount
    renderHook(() => useWebSocket());

    // Wait for ws1's async close to potentially fire
    await act(async () => {
      await new Promise(r => setTimeout(r, 20));
    });

    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const ws2 = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

    // Open ws2 — this is the "real" connection
    act(() => ws2._open());

    expect(useConnectionStore.getState().ws).toBe(ws2);
    expect(useConnectionStore.getState().status).toBe('connected');

    // Step 4: Fire ws1's onclose AGAIN (simulating the async delay where
    // the old WS close event arrives after the new connection is established).
    // In the real bug, this would call setWs(null) and wipe ws2.
    if (ws1OnClose) {
      act(() => (ws1OnClose as () => void)());
    }

    // CRITICAL ASSERTION: ws2 must still be in the store
    expect(useConnectionStore.getState().ws).toBe(ws2);
    expect(useConnectionStore.getState().status).toBe('connected');

    // Verify messages can still be sent
    act(() => {
      useConnectionStore.getState().send({ type: 'message', content: 'test after race' });
    });

    expect(ws2.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(ws2.send.mock.calls[0]![0] as string);
    expect(payload).toEqual({ type: 'message', content: 'test after race' });
  });

  it('current WebSocket onclose DOES clear the store (normal disconnect)', async () => {
    const { useWebSocket } = await import('../hooks/useWebSocket');

    renderHook(() => useWebSocket());

    const currentWs = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

    // Open the connection
    act(() => currentWs._open());
    expect(useConnectionStore.getState().ws).toBe(currentWs);

    // Simulate server-side disconnect
    act(() => currentWs._close());

    // Store should be cleared for reconnect
    expect(useConnectionStore.getState().ws).toBeNull();
  });

  it('messages work after normal connect', async () => {
    const { useWebSocket } = await import('../hooks/useWebSocket');

    renderHook(() => useWebSocket());

    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    act(() => ws._open());

    act(() => {
      useConnectionStore.getState().send({ type: 'message', content: 'hello' });
    });

    expect(ws.send).toHaveBeenCalled();
    const calls = ws.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string)
    );
    expect(calls).toContainEqual({ type: 'message', content: 'hello' });
  });
});
