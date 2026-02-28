/**
 * Unit tests for src/tasks.ts — TaskQueue state machine.
 * Run with: node --import tsx/esm --test src/tasks.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from './tasks.js';
import type { BackgroundTaskInfo } from './protocol.js';

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

describe('TaskQueue', () => {
  let queue: TaskQueue;
  let updates: BackgroundTaskInfo[];
  let readyCalls: number;

  beforeEach(() => {
    updates = [];
    readyCalls = 0;
    queue = new TaskQueue({
      onTaskUpdate: (task) => updates.push(structuredClone(task)),
      onResultReady: () => readyCalls++,
    });
  });

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('returns a unique task ID', () => {
      const id1 = queue.register('task one');
      const id2 = queue.register('task two');
      assert.notEqual(id1, id2);
      assert.ok(id1.startsWith('task-'));
      assert.ok(id2.startsWith('task-'));
    });

    it('increments runningCount', () => {
      assert.equal(queue.runningCount, 0);
      queue.register('a');
      assert.equal(queue.runningCount, 1);
      queue.register('b');
      assert.equal(queue.runningCount, 2);
    });

    it('fires onTaskUpdate with status=running', () => {
      queue.register('my task');
      assert.equal(updates.length, 1);
      assert.equal(updates[0]!.status, 'running');
      assert.equal(updates[0]!.description, 'my task');
    });

    it('preserves full description', () => {
      const long = 'x'.repeat(100);
      queue.register(long);
      assert.equal(updates[0]!.description, long);
    });

    it('defaults delivery to agent-batch', () => {
      queue.register('task');
      assert.equal(updates[0]!.delivery, 'agent-batch');
    });

    it('accepts agent-review delivery', () => {
      queue.register('task', 'agent-review');
      assert.equal(updates[0]!.delivery, 'agent-review');
    });

    it('accepts user-pull delivery', () => {
      queue.register('task', 'user-pull');
      assert.equal(updates[0]!.delivery, 'user-pull');
    });
  });

  // -------------------------------------------------------------------------
  // complete
  // -------------------------------------------------------------------------

  describe('complete', () => {
    it('adds result to completion queue', () => {
      const id = queue.register('task');
      queue.complete(id, 'done!');
      assert.equal(queue.hasPendingResults(), true);
      assert.equal(queue.pendingCount, 1);
    });

    it('fires onTaskUpdate with status=completed', () => {
      const id = queue.register('task');
      queue.complete(id, 'result');
      // 2 updates: register + complete
      assert.equal(updates.length, 2);
      assert.equal(updates[1]!.status, 'completed');
      assert.ok(updates[1]!.completedAt);
    });

    it('fires onResultReady', () => {
      const id = queue.register('task');
      queue.complete(id, 'result');
      assert.equal(readyCalls, 1);
    });

    it('decrements runningCount', () => {
      const id = queue.register('task');
      assert.equal(queue.runningCount, 1);
      queue.complete(id, 'done');
      assert.equal(queue.runningCount, 0);
    });

    it('includes meta when provided', () => {
      const id = queue.register('task');
      queue.complete(id, 'done', { model: 'haiku', inputTokens: 100, outputTokens: 50, cost: 0.01 });
      const info = queue.getInfos().find((t) => t.id === id)!;
      assert.equal(info.model, 'haiku');
      assert.equal(info.inputTokens, 100);
      assert.equal(info.outputTokens, 50);
      assert.equal(info.cost, 0.01);
    });

    it('includes result in update for user-pull tasks', () => {
      const id = queue.register('task', 'user-pull');
      queue.complete(id, 'the result');
      const completeUpdate = updates.find((u) => u.status === 'completed')!;
      assert.equal(completeUpdate.result, 'the result');
    });

    it('includes result in update for agent-review tasks', () => {
      const id = queue.register('task', 'agent-review');
      queue.complete(id, 'the result');
      const completeUpdate = updates.find((u) => u.status === 'completed')!;
      assert.equal(completeUpdate.result, 'the result');
    });

    it('is a no-op for unknown task ID', () => {
      queue.complete('nonexistent', 'result');
      assert.equal(queue.pendingCount, 0);
      assert.equal(readyCalls, 0);
    });
  });

  // -------------------------------------------------------------------------
  // fail
  // -------------------------------------------------------------------------

  describe('fail', () => {
    it('marks task as failed and queues error', () => {
      const id = queue.register('task');
      queue.fail(id, 'something broke');
      assert.equal(queue.pendingCount, 1);
      const result = queue.drainNext()!;
      assert.equal(result.status, 'failed');
      assert.equal(result.result, 'something broke');
    });

    it('fires onTaskUpdate with status=failed', () => {
      const id = queue.register('task');
      queue.fail(id, 'err');
      const failUpdate = updates.find((u) => u.status === 'failed')!;
      assert.ok(failUpdate);
      assert.ok(failUpdate.completedAt);
    });

    it('fires onResultReady', () => {
      const id = queue.register('task');
      queue.fail(id, 'err');
      assert.equal(readyCalls, 1);
    });

    it('decrements runningCount', () => {
      const id = queue.register('task');
      assert.equal(queue.runningCount, 1);
      queue.fail(id, 'err');
      assert.equal(queue.runningCount, 0);
    });

    it('is a no-op for unknown task ID', () => {
      queue.fail('nonexistent', 'err');
      assert.equal(queue.pendingCount, 0);
    });
  });

  // -------------------------------------------------------------------------
  // cancelAll
  // -------------------------------------------------------------------------

  describe('cancelAll', () => {
    it('marks all running tasks as cancelled', () => {
      queue.register('a');
      queue.register('b');
      queue.cancelAll();
      assert.equal(queue.runningCount, 0);
      const cancelled = updates.filter((u) => u.status === 'cancelled');
      assert.equal(cancelled.length, 2);
    });

    it('empties the completion queue', () => {
      const id = queue.register('a');
      queue.complete(id, 'result');
      assert.equal(queue.pendingCount, 1);
      queue.cancelAll();
      assert.equal(queue.pendingCount, 0);
    });

    it('does not affect already completed tasks', () => {
      const id1 = queue.register('done one');
      queue.complete(id1, 'result');
      const id2 = queue.register('still running');
      queue.cancelAll();
      // Only id2 should get a cancelled update
      const cancelled = updates.filter((u) => u.status === 'cancelled');
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0]!.id, id2);
    });
  });

  // -------------------------------------------------------------------------
  // drainNext
  // -------------------------------------------------------------------------

  describe('drainNext', () => {
    it('returns null when queue is empty', () => {
      assert.equal(queue.drainNext(), null);
    });

    it('returns completed results in FIFO order', () => {
      const id1 = queue.register('first');
      const id2 = queue.register('second');
      queue.complete(id1, 'result 1');
      queue.complete(id2, 'result 2');
      assert.equal(queue.drainNext()!.result, 'result 1');
      assert.equal(queue.drainNext()!.result, 'result 2');
    });

    it('removes the result from the queue after draining', () => {
      const id = queue.register('task');
      queue.complete(id, 'result');
      assert.equal(queue.pendingCount, 1);
      queue.drainNext();
      assert.equal(queue.pendingCount, 0);
      assert.equal(queue.drainNext(), null);
    });
  });

  // -------------------------------------------------------------------------
  // hasPendingResults / pendingCount
  // -------------------------------------------------------------------------

  describe('hasPendingResults / pendingCount', () => {
    it('false/0 when empty', () => {
      assert.equal(queue.hasPendingResults(), false);
      assert.equal(queue.pendingCount, 0);
    });

    it('true/N after N completions', () => {
      const id1 = queue.register('a');
      const id2 = queue.register('b');
      queue.complete(id1, 'r1');
      queue.complete(id2, 'r2');
      assert.equal(queue.hasPendingResults(), true);
      assert.equal(queue.pendingCount, 2);
    });

    it('decrements after drain', () => {
      const id = queue.register('a');
      queue.complete(id, 'r');
      assert.equal(queue.pendingCount, 1);
      queue.drainNext();
      assert.equal(queue.pendingCount, 0);
    });
  });

  // -------------------------------------------------------------------------
  // getInfos / getRunning
  // -------------------------------------------------------------------------

  describe('getInfos', () => {
    it('returns all tasks with correct fields', () => {
      const id = queue.register('task');
      queue.complete(id, 'result');
      const infos = queue.getInfos();
      assert.equal(infos.length, 1);
      assert.equal(infos[0]!.id, id);
      assert.equal(infos[0]!.status, 'completed');
      assert.ok(infos[0]!.startedAt);
      assert.ok(infos[0]!.completedAt);
    });

    it('includes result for user-pull tasks', () => {
      const id = queue.register('task', 'user-pull');
      queue.complete(id, 'the answer');
      const info = queue.getInfos().find((t) => t.id === id)!;
      assert.equal(info.result, 'the answer');
    });
  });

  describe('getRunning', () => {
    it('returns only running tasks', () => {
      const id1 = queue.register('running');
      const id2 = queue.register('will complete');
      queue.complete(id2, 'done');
      const running = queue.getRunning();
      assert.equal(running.length, 1);
      assert.equal(running[0]!.id, id1);
    });
  });

  // -------------------------------------------------------------------------
  // peekNext
  // -------------------------------------------------------------------------

  describe('peekNext', () => {
    it('returns null when queue is empty', () => {
      assert.equal(queue.peekNext(), null);
    });

    it('returns next result without removing it', () => {
      const id = queue.register('task');
      queue.complete(id, 'result');
      assert.equal(queue.peekNext()!.result, 'result');
      assert.equal(queue.peekNext()!.result, 'result'); // still there
      assert.equal(queue.pendingCount, 1);
    });
  });

  // -------------------------------------------------------------------------
  // hasBatchPending / drainBatch / readyForBatchDelivery
  // -------------------------------------------------------------------------

  describe('batch helpers', () => {
    it('hasBatchPending returns false when no batch results', () => {
      const id = queue.register('task', 'agent-review');
      queue.complete(id, 'result');
      assert.equal(queue.hasBatchPending(), false);
    });

    it('hasBatchPending returns true for agent-batch results', () => {
      const id = queue.register('task', 'agent-batch');
      queue.complete(id, 'result');
      assert.equal(queue.hasBatchPending(), true);
    });

    it('drainBatch returns only agent-batch results', () => {
      const id1 = queue.register('review task', 'agent-review');
      const id2 = queue.register('batch task 1', 'agent-batch');
      const id3 = queue.register('batch task 2', 'agent-batch');
      queue.complete(id1, 'review result');
      queue.complete(id2, 'batch result 1');
      queue.complete(id3, 'batch result 2');

      const batch = queue.drainBatch();
      assert.equal(batch.length, 2);
      assert.equal(batch[0]!.description, 'batch task 1');
      assert.equal(batch[1]!.description, 'batch task 2');

      // agent-review result is still in the queue
      assert.equal(queue.pendingCount, 1);
      assert.equal(queue.drainNext()!.description, 'review task');
    });

    it('drainBatch returns empty array when no batch results', () => {
      const id = queue.register('task', 'agent-review');
      queue.complete(id, 'result');
      assert.deepEqual(queue.drainBatch(), []);
      assert.equal(queue.pendingCount, 1); // agent-review still there
    });

    it('readyForBatchDelivery returns false while tasks still running', () => {
      const id1 = queue.register('done', 'agent-batch');
      queue.register('still running', 'agent-batch'); // registered but not completed
      queue.complete(id1, 'result');
      assert.equal(queue.readyForBatchDelivery(), false);
    });

    it('readyForBatchDelivery returns true when all tasks done', () => {
      const id1 = queue.register('task 1', 'agent-batch');
      const id2 = queue.register('task 2', 'agent-batch');
      queue.complete(id1, 'result 1');
      queue.complete(id2, 'result 2');
      assert.equal(queue.readyForBatchDelivery(), true);
    });

    it('readyForBatchDelivery returns false when no batch results', () => {
      assert.equal(queue.readyForBatchDelivery(), false);
    });
  });

  // -------------------------------------------------------------------------
  // prune
  // -------------------------------------------------------------------------

  describe('prune', () => {
    it('removes old completed tasks beyond keepLast', () => {
      // Create and complete 5 tasks
      for (let i = 0; i < 5; i++) {
        const id = queue.register(`task ${i}`);
        queue.complete(id, `result ${i}`);
      }
      queue.prune(2);
      assert.equal(queue.getInfos().length, 2);
    });

    it('keeps running tasks during prune', () => {
      for (let i = 0; i < 5; i++) {
        const id = queue.register(`done ${i}`);
        queue.complete(id, 'r');
      }
      queue.register('still running');
      queue.prune(1);
      // 1 kept completed + 1 running = 2
      assert.equal(queue.getInfos().length, 2);
      assert.equal(queue.runningCount, 1);
    });

    it('default keepLast is 20', () => {
      for (let i = 0; i < 25; i++) {
        const id = queue.register(`task ${i}`);
        queue.complete(id, 'r');
      }
      queue.prune();
      assert.equal(queue.getInfos().length, 20);
    });
  });
});
