/**
 * Unit tests for src/req-context.ts — request correlation ID context.
 * Run with: node --import tsx/esm --test src/req-context.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reqContext, getReqId } from './req-context.js';

describe('reqContext', () => {
  it('getReqId() returns undefined outside a context', () => {
    assert.equal(getReqId(), undefined);
  });

  it('getReqId() returns the reqId inside a context', async () => {
    await reqContext.run({ reqId: 'abc123' }, () => {
      assert.equal(getReqId(), 'abc123');
    });
  });

  it('nested context overrides parent reqId', async () => {
    await reqContext.run({ reqId: 'outer' }, async () => {
      assert.equal(getReqId(), 'outer');
      await reqContext.run({ reqId: 'inner' }, () => {
        assert.equal(getReqId(), 'inner');
      });
      // Outer context is restored after inner exits
      assert.equal(getReqId(), 'outer');
    });
  });

  it('getReqId() returns undefined after context exits', async () => {
    await reqContext.run({ reqId: 'temp' }, () => {
      assert.equal(getReqId(), 'temp');
    });
    assert.equal(getReqId(), undefined);
  });
});
