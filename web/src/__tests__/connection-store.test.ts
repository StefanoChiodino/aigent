/**
 * Connection store — verifies WebSocket send/drop behaviour.
 *
 * These tests don't need Docker, a gatekeeper, or even a browser.
 * They run in jsdom via vitest in ~200ms.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConnectionStore } from '../stores/connection';

/** Create a minimal fake WebSocket with the bits the store uses. */
function fakeWs(readyState: number = WebSocket.OPEN) {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
}

describe('Connection store', () => {
  beforeEach(() => {
    // Reset store between tests
    useConnectionStore.setState({
      status: 'connecting',
      ws: null,
      reconnectAttempt: 0,
    });
  });

  it('send() delivers JSON when WebSocket is OPEN', () => {
    const ws = fakeWs(WebSocket.OPEN);
    useConnectionStore.getState().setWs(ws);

    useConnectionStore.getState().send({ type: 'message', content: 'hello' });

    expect(ws.send).toHaveBeenCalledOnce();
    const payload = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(payload).toEqual({ type: 'message', content: 'hello' });
  });

  it('send() silently drops when WebSocket is null', () => {
    useConnectionStore.getState().send({ type: 'message', content: 'hello' });
    // No error thrown, message just lost
  });

  it('send() silently drops when WebSocket is CONNECTING', () => {
    const ws = fakeWs(WebSocket.CONNECTING);
    useConnectionStore.getState().setWs(ws);

    useConnectionStore.getState().send({ type: 'message', content: 'hello' });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('send() silently drops when WebSocket is CLOSING', () => {
    const ws = fakeWs(WebSocket.CLOSING);
    useConnectionStore.getState().setWs(ws);

    useConnectionStore.getState().send({ type: 'message', content: 'hello' });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('send() silently drops when WebSocket is CLOSED', () => {
    const ws = fakeWs(WebSocket.CLOSED);
    useConnectionStore.getState().setWs(ws);

    useConnectionStore.getState().send({ type: 'message', content: 'hello' });

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('send() serialises message with attachments correctly', () => {
    const ws = fakeWs(WebSocket.OPEN);
    useConnectionStore.getState().setWs(ws);

    const msg = {
      type: 'message',
      content: 'look at this',
      attachments: [{ name: 'pic.png', mediaType: 'image/png', data: 'abc123' }],
    };
    useConnectionStore.getState().send(msg);

    const payload = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(payload.type).toBe('message');
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].name).toBe('pic.png');
  });

  it('send() serialises command messages (permission approval)', () => {
    const ws = fakeWs(WebSocket.OPEN);
    useConnectionStore.getState().setWs(ws);

    useConnectionStore.getState().send({ type: 'command', cmd: '/approve-exec abc123' });

    const payload = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(payload).toEqual({ type: 'command', cmd: '/approve-exec abc123' });
  });

  it('send() serialises cancel messages', () => {
    const ws = fakeWs(WebSocket.OPEN);
    useConnectionStore.getState().setWs(ws);

    useConnectionStore.getState().send({ type: 'cancel' });

    const payload = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string);
    expect(payload).toEqual({ type: 'cancel' });
  });
});
