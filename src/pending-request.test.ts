import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PendingRequestBroker } from './pending-request.js';

const ABORT_RESPONSE = { ok: false, message: 'Aborted' };
const TIMEOUT_RESPONSE = { ok: false, message: 'Timed out' };

function makeBroker(timeoutMs = 60_000) {
  return new PendingRequestBroker<{ command: string }, { ok: boolean; message: string }>({
    prefix: 'test',
    timeoutMs,
    abortResponse: ABORT_RESPONSE,
    timeoutResponse: TIMEOUT_RESPONSE,
  });
}

describe('PendingRequestBroker', () => {
  it('request and resolve', async () => {
    const broker = makeBroker();
    const [id, promise] = broker.request({ command: 'ls' });
    assert.match(id, /^test_\d+$/);
    assert.equal(broker.size, 1);

    broker.resolve(id, { ok: true, message: 'allowed' });
    const result = await promise;
    assert.deepEqual(result, { ok: true, message: 'allowed' });
    assert.equal(broker.size, 0);
  });

  it('resolve unknown id is a no-op', () => {
    const broker = makeBroker();
    broker.resolve('nonexistent', { ok: false, message: 'nope' });
    assert.equal(broker.size, 0);
  });

  it('abort signal already aborted returns immediately', async () => {
    const broker = makeBroker();
    const ac = new AbortController();
    ac.abort();
    const [, promise] = broker.request({ command: 'rm' }, ac.signal);
    const result = await promise;
    assert.deepEqual(result, ABORT_RESPONSE);
    assert.equal(broker.size, 0);
  });

  it('abort signal fires after request', async () => {
    const broker = makeBroker();
    const ac = new AbortController();
    const [, promise] = broker.request({ command: 'rm' }, ac.signal);
    assert.equal(broker.size, 1);
    ac.abort();
    const result = await promise;
    assert.deepEqual(result, ABORT_RESPONSE);
    assert.equal(broker.size, 0);
  });

  it('timeout fires if not resolved', async () => {
    const broker = makeBroker(50); // 50ms timeout
    const [, promise] = broker.request({ command: 'slow' });
    const result = await promise;
    assert.deepEqual(result, TIMEOUT_RESPONSE);
    assert.equal(broker.size, 0);
  });

  it('entries() iterates pending requests', () => {
    const broker = makeBroker();
    broker.request({ command: 'a' });
    broker.request({ command: 'b' });
    const entries = [...broker.entries()];
    assert.equal(entries.length, 2);
    assert.equal(entries[0]![1].command, 'a');
    assert.equal(entries[1]![1].command, 'b');
  });

  it('entries() empty when no pending', () => {
    const broker = makeBroker();
    assert.deepEqual([...broker.entries()], []);
  });

  it('IDs are unique and incrementing', () => {
    const broker = makeBroker();
    const [id1] = broker.request({ command: 'a' });
    const [id2] = broker.request({ command: 'b' });
    assert.notEqual(id1, id2);
    const num1 = Number(id1.split('_')[1]);
    const num2 = Number(id2.split('_')[1]);
    assert.ok(num2 > num1);
  });

  it('replayTo sends events for all pending', () => {
    const broker = makeBroker();
    broker.request({ command: 'a' });
    broker.request({ command: 'b' });
    const replayed: Array<{ id: string; command: string }> = [];
    broker.replayTo((id, meta) => replayed.push({ id, command: meta.command }));
    assert.equal(replayed.length, 2);
    assert.equal(replayed[0]!.command, 'a');
    assert.equal(replayed[1]!.command, 'b');
  });

  it('double resolve is a no-op', async () => {
    const broker = makeBroker();
    const [id, promise] = broker.request({ command: 'x' });
    broker.resolve(id, { ok: true, message: 'first' });
    broker.resolve(id, { ok: false, message: 'second' });
    const result = await promise;
    assert.deepEqual(result, { ok: true, message: 'first' });
  });
});
