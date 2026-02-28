/**
 * Permission approval flow — verifies that resolving exec/fetch/mount
 * requests sends the correct commands over WebSocket.
 *
 * Tests the UI store's resolvePermRequest + connection store's send,
 * which together form the critical path for tool approval.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import type { PermRequest } from '../types';

function fakeWs() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
}

function sentPayloads(ws: WebSocket): Record<string, unknown>[] {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
  );
}

describe('Permission approval flow', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    useUIStore.setState({ permQueue: [], permShowing: false });
  });

  function enqueue(req: Partial<PermRequest> & { type: PermRequest['type']; id: string }) {
    useUIStore.getState().enqueuePermRequest({
      title: 'Test',
      detail: 'test detail',
      approveCmd: `/approve ${req.id}`,
      denyCmd: `/deny ${req.id}`,
      ...req,
    } as PermRequest);
  }

  it('approving an exec request sends the approve command', () => {
    enqueue({
      type: 'exec',
      id: 'exec-1',
      approveCmd: '/approve-exec exec-1',
      denyCmd: '/deny-exec exec-1',
    });

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true);

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'command', cmd: '/approve-exec exec-1' });
  });

  it('denying an exec request sends the deny command', () => {
    enqueue({
      type: 'exec',
      id: 'exec-2',
      approveCmd: '/approve-exec exec-2',
      denyCmd: '/deny-exec exec-2',
    });

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, false);

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'command', cmd: '/deny-exec exec-2' });
  });

  it('always-allow sends the alwaysAllowCmd', () => {
    enqueue({
      type: 'exec',
      id: 'exec-3',
      approveCmd: '/approve-exec exec-3',
      denyCmd: '/deny-exec exec-3',
      alwaysAllowCmd: '/approve-exec exec-3 --always',
    });

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true, true, false);

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'command', cmd: '/approve-exec exec-3 --always' });
  });

  it('always-allow-domain sends the alwaysAllowDomainCmd for fetch', () => {
    enqueue({
      type: 'fetch',
      id: 'fetch-1',
      approveCmd: '/approve-fetch fetch-1',
      denyCmd: '/deny-fetch fetch-1',
      alwaysAllowCmd: '/approve-fetch fetch-1 --always',
      alwaysAllowDomainCmd: '/approve-fetch fetch-1 --always-domain',
    });

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true, false, true);

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'command', cmd: '/approve-fetch fetch-1 --always-domain' });
  });

  it('resolving removes the request from the queue', () => {
    enqueue({ type: 'exec', id: 'exec-a' });
    enqueue({ type: 'exec', id: 'exec-b' });

    expect(useUIStore.getState().permQueue).toHaveLength(2);

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true);

    expect(useUIStore.getState().permQueue).toHaveLength(1);
    expect(useUIStore.getState().permQueue[0]!.id).toBe('exec-b');
  });

  it('resolving the last request hides the modal', () => {
    enqueue({ type: 'exec', id: 'exec-only' });
    expect(useUIStore.getState().permShowing).toBe(true);

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true);

    expect(useUIStore.getState().permShowing).toBe(false);
  });

  it('resolving with empty queue is a no-op', () => {
    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('dismissPermRequests removes matching entries from the queue', () => {
    enqueue({ type: 'fetch', id: 'fetch-a' });
    enqueue({ type: 'fetch', id: 'fetch-b' });
    enqueue({ type: 'exec', id: 'exec-c' });

    expect(useUIStore.getState().permQueue).toHaveLength(3);

    useUIStore.getState().dismissPermRequests(['fetch-a', 'exec-c']);

    const queue = useUIStore.getState().permQueue;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.id).toBe('fetch-b');
  });

  it('dismissPermRequests hides modal when all requests are dismissed', () => {
    enqueue({ type: 'fetch', id: 'fetch-only' });
    expect(useUIStore.getState().permShowing).toBe(true);

    useUIStore.getState().dismissPermRequests(['fetch-only']);

    expect(useUIStore.getState().permQueue).toHaveLength(0);
    expect(useUIStore.getState().permShowing).toBe(false);
  });

  it('dismissPermRequests is a no-op for unknown IDs', () => {
    enqueue({ type: 'fetch', id: 'fetch-x' });

    useUIStore.getState().dismissPermRequests(['nonexistent']);

    expect(useUIStore.getState().permQueue).toHaveLength(1);
    expect(useUIStore.getState().permShowing).toBe(true);
  });

  // ── Race: perm_dismissed then resolvePermRequest ───────────────────────
  //
  // Simulates the race condition that caused "No pending X request" errors:
  // 1. A request is queued (modal shows)
  // 2. Server auto-resolves it → dismissPermRequests removes it from the queue
  // 3. User had already clicked Approve → resolvePermRequest fires on the
  //    now-empty queue
  //
  // Expected: no command sent (empty queue is a no-op), no crash.

  it('resolvePermRequest after dismissPermRequests sends no command', () => {
    enqueue({
      type: 'fetch',
      id: 'race-f1',
      approveCmd: '/approve-fetch race-f1',
      denyCmd: '/deny-fetch race-f1',
    });

    // Server auto-resolves — dismiss the request from the queue
    useUIStore.getState().dismissPermRequests(['race-f1']);
    expect(useUIStore.getState().permQueue).toHaveLength(0);

    // User clicks Approve just after the dismiss arrived
    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true);

    // Queue was already empty — no command should be sent
    expect(ws.send).not.toHaveBeenCalled();
    expect(useUIStore.getState().permShowing).toBe(false);
  });

  it('resolvePermRequest deny after dismissPermRequests sends no command', () => {
    enqueue({
      type: 'exec',
      id: 'race-e1',
      approveCmd: '/approve-exec race-e1',
      denyCmd: '/deny-exec race-e1',
    });

    useUIStore.getState().dismissPermRequests(['race-e1']);

    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, false);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('dismissing first of two queued requests then resolving acts on the second', () => {
    enqueue({
      type: 'fetch',
      id: 'race-f2',
      approveCmd: '/approve-fetch race-f2',
      denyCmd: '/deny-fetch race-f2',
    });
    enqueue({
      type: 'exec',
      id: 'race-e2',
      approveCmd: '/approve-exec race-e2',
      denyCmd: '/deny-exec race-e2',
    });

    // First request is auto-resolved before user clicks
    useUIStore.getState().dismissPermRequests(['race-f2']);

    // User clicks Approve — now the second request is at the front
    const send = useConnectionStore.getState().send;
    useUIStore.getState().resolvePermRequest(send, true);

    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({ type: 'command', cmd: '/approve-exec race-e2' });
    expect(useUIStore.getState().permQueue).toHaveLength(0);
  });
});
