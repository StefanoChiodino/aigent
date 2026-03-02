import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequests, type PermCtx } from './gk-perm-utils.js';

function makeCtx(): PermCtx {
  return {
    client: { send: mock.fn(), emit: mock.fn() },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() } as unknown as PermCtx['log'],
    injectSystemMessage: mock.fn(),
    broadcastUpdatedPermissions: mock.fn(),
    auditLog: mock.fn(),
    classifierDecisions: new Map(),
    getRecentContext: () => undefined,
  };
}

describe('PendingRequests', () => {
  let pending: PendingRequests<{ value: string }>;

  beforeEach(() => {
    pending = new PendingRequests('test');
  });

  it('add, get, delete lifecycle', () => {
    pending.add('a', { value: 'hello' });
    assert.equal(pending.size, 1);
    assert.deepEqual(pending.get('a'), { value: 'hello' });
    assert.equal(pending.delete('a'), true);
    assert.equal(pending.size, 0);
    assert.equal(pending.get('a'), undefined);
  });

  it('getSingleId returns undefined when empty or multiple', () => {
    assert.equal(pending.getSingleId(), undefined);
    pending.add('a', { value: '1' });
    pending.add('b', { value: '2' });
    assert.equal(pending.getSingleId(), undefined);
  });

  it('getSingleId returns the ID when exactly one', () => {
    pending.add('only', { value: 'one' });
    assert.equal(pending.getSingleId(), 'only');
  });

  it('autoHandled tracking', () => {
    pending.markAutoHandled('x');
    assert.equal(pending.isAutoHandled('x'), true);
    assert.equal(pending.isAutoHandled('y'), false);
    assert.equal(pending.consumeAutoHandled('x'), true);
    assert.equal(pending.isAutoHandled('x'), false);
    assert.equal(pending.consumeAutoHandled('x'), false);
  });

  it('autoHandledIds exposes the raw set', () => {
    pending.markAutoHandled('a');
    pending.markAutoHandled('b');
    assert.equal(pending.autoHandledIds.size, 2);
    assert.ok(pending.autoHandledIds.has('a'));
  });

  it('recentlyResolved tracks with TTL', () => {
    pending.markResolved('r1');
    assert.equal(pending.isRecentlyResolved('r1'), true);
    assert.equal(pending.isRecentlyResolved('unknown'), false);
  });

  it('resolve removes from pending and marks resolved', () => {
    const ctx = makeCtx();
    pending.add('a', { value: 'data' });
    const result = pending.resolve('a', ctx);
    assert.deepEqual(result, { value: 'data' });
    assert.equal(pending.size, 0);
    assert.equal(pending.isRecentlyResolved('a'), true);
  });

  it('resolve returns undefined for missing ID', () => {
    const ctx = makeCtx();
    assert.equal(pending.resolve('nope', ctx), undefined);
  });

  it('flush auto-resolves matching entries', () => {
    const ctx = makeCtx();
    pending.add('a', { value: 'allow' });
    pending.add('b', { value: 'deny' });
    pending.add('c', { value: 'allow' });

    const resolved: string[] = [];
    const dismissed = pending.flush(
      (_id, data) => data.value === 'allow',
      (id, _data) => { resolved.push(id); },
    );

    assert.deepEqual(dismissed.sort(), ['a', 'c']);
    assert.deepEqual(resolved.sort(), ['a', 'c']);
    assert.equal(pending.size, 1);
    assert.deepEqual(pending.get('b'), { value: 'deny' });
    // Flushed IDs should be marked as recently resolved
    assert.equal(pending.isRecentlyResolved('a'), true);
    assert.equal(pending.isRecentlyResolved('c'), true);
  });

  it('broadcastDismissed emits perm_dismissed', () => {
    const ctx = makeCtx();
    pending.broadcastDismissed(ctx, ['x', 'y']);
    assert.equal((ctx.client!.emit as ReturnType<typeof mock.fn>).mock.calls.length, 1);
    assert.deepEqual((ctx.client!.emit as ReturnType<typeof mock.fn>).mock.calls[0]?.arguments, ['perm_dismissed', ['x', 'y']]);
  });

  it('broadcastDismissed does nothing for empty list', () => {
    const ctx = makeCtx();
    pending.broadcastDismissed(ctx, []);
    assert.equal((ctx.client!.emit as ReturnType<typeof mock.fn>).mock.calls.length, 0);
  });

  it('broadcastDismissed does nothing when client is null', () => {
    const ctx = makeCtx();
    ctx.client = null;
    // Should not throw
    pending.broadcastDismissed(ctx, ['a']);
  });
});
