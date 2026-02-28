/**
 * Unit tests for src/logger.ts — structured logging.
 * Run with: node --import tsx/esm --test src/logger.test.ts
 *
 * Note: MIN_LEVEL is set at module load time. These tests run at the default
 * INFO level, so debug() is expected to be suppressed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from './logger.js';
import { reqContext } from './req-context.js';

// ---------------------------------------------------------------------------
// createLogger
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  let captured: string[];
  let origError: typeof console.error;

  beforeEach(() => {
    captured = [];
    origError = console.error;
    console.error = (...args: unknown[]) => captured.push(String(args[0]));
  });

  afterEach(() => {
    console.error = origError;
  });

  it('returns an object with debug, info, warn, error, time methods', () => {
    const log = createLogger('test');
    assert.equal(typeof log.debug, 'function');
    assert.equal(typeof log.info, 'function');
    assert.equal(typeof log.warn, 'function');
    assert.equal(typeof log.error, 'function');
    assert.equal(typeof log.time, 'function');
  });

  it('info() outputs in expected format', () => {
    const log = createLogger('mycomp');
    log.info('Hello');
    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /^\d{4}-\d{2}-\d{2}T.+ \[INFO\] \[mycomp\] Hello$/);
  });

  it('includes key=value pairs from data', () => {
    const log = createLogger('test');
    log.info('Event', { port: 3000, count: 5 });
    assert.ok(captured[0]!.includes('port=3000'));
    assert.ok(captured[0]!.includes('count=5'));
  });

  it('quotes string values with spaces', () => {
    const log = createLogger('test');
    log.info('Msg', { label: 'hello world' });
    assert.ok(captured[0]!.includes('label="hello world"'));
  });

  it('skips undefined values in data', () => {
    const log = createLogger('test');
    log.info('Msg', { a: 1, b: undefined });
    assert.ok(captured[0]!.includes('a=1'));
    assert.ok(!captured[0]!.includes('b='));
  });

  it('debug() is suppressed at default INFO level', () => {
    const log = createLogger('test');
    log.debug('should not appear');
    assert.equal(captured.length, 0);
  });

  it('warn() emits at default level', () => {
    const log = createLogger('test');
    log.warn('Warning');
    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /\[WARN\]/);
  });

  it('error() emits at default level', () => {
    const log = createLogger('test');
    log.error('Error');
    assert.equal(captured.length, 1);
    assert.match(captured[0]!, /\[ERROR\]/);
  });

  it('time() logs duration on success', async () => {
    const log = createLogger('test');
    const result = await log.time('operation', () => 42);
    assert.equal(result, 42);
    assert.equal(captured.length, 1);
    assert.ok(captured[0]!.includes('operation'));
    assert.ok(captured[0]!.includes('ms='));
  });

  it('time() logs error and rethrows on failure', async () => {
    const log = createLogger('test');
    await assert.rejects(
      () => log.time('failing', () => { throw new Error('boom'); }),
      { message: 'boom' },
    );
    assert.equal(captured.length, 1);
    assert.ok(captured[0]!.includes('failing failed'));
    assert.ok(captured[0]!.includes('error=boom'));
  });

  it('time() works with async functions', async () => {
    const log = createLogger('test');
    const result = await log.time('async-op', async () => {
      return 'async-result';
    });
    assert.equal(result, 'async-result');
    assert.equal(captured.length, 1);
    assert.ok(captured[0]!.includes('async-op'));
  });

  it('includes [reqId] when inside a request context', async () => {
    const log = createLogger('test');
    await reqContext.run({ reqId: 'abc123' }, () => {
      log.info('Hello');
    });
    assert.equal(captured.length, 1);
    assert.ok(captured[0]!.includes('[abc123]'));
    assert.match(captured[0]!, /\[test\] \[abc123\] Hello$/);
  });

  it('omits reqId when outside a request context', () => {
    const log = createLogger('test');
    log.info('Hello');
    assert.equal(captured.length, 1);
    assert.ok(!captured[0]!.includes('[abc123]'));
    assert.match(captured[0]!, /\[test\] Hello$/);
  });
});
