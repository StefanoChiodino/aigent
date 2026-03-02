/**
 * Unit tests for src/classifier.ts — Tier 3 Haiku command classifier.
 * Run with: node --import tsx/esm --test src/classifier.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type OpenAI from 'openai';

import {
  classifyCommand,
  isClassifierAvailable,
  initClassifier,
  parseClassifierResponse,
  _resetForTest,
  _backdateCacheEntryForTest,
} from './classifier.js';

afterEach(() => {
  _resetForTest(null);
});

// ---------------------------------------------------------------------------
// parseClassifierResponse (exported for direct testing)
// ---------------------------------------------------------------------------

describe('parseClassifierResponse', () => {
  it('parses valid allow response', () => {
    const result = parseClassifierResponse('{"action":"allow","reason":"safe command"}');
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'safe command');
  });

  it('parses valid block response', () => {
    const result = parseClassifierResponse('{"action":"block","reason":"dangerous"}');
    assert.equal(result.action, 'block');
    assert.equal(result.reason, 'dangerous');
  });

  it('parses valid ask response', () => {
    const result = parseClassifierResponse('{"action":"ask","reason":"ambiguous"}');
    assert.equal(result.action, 'ask');
    assert.equal(result.reason, 'ambiguous');
  });

  it('extracts JSON from surrounding text', () => {
    const result = parseClassifierResponse(
      'Here is my analysis:\n{"action":"allow","reason":"standard dev command"}\nHope that helps!',
    );
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'standard dev command');
  });

  it('returns ask for malformed JSON', () => {
    const result = parseClassifierResponse('this is not json at all');
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.includes('parse'));
  });

  it('returns ask for missing action field', () => {
    const result = parseClassifierResponse('{"reason":"no action here"}');
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.includes('parse'));
  });

  it('returns ask for invalid action value', () => {
    const result = parseClassifierResponse('{"action":"destroy","reason":"bad action"}');
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.length > 0);
  });

  it('returns ask for empty string', () => {
    const result = parseClassifierResponse('');
    assert.equal(result.action, 'ask');
  });

  it('parses suggested_patterns when present', () => {
    const result = parseClassifierResponse(
      '{"action":"allow","reason":"safe","suggested_patterns":["cd *","wc *"]}',
    );
    assert.equal(result.action, 'allow');
    assert.deepEqual(result.suggestedPatterns, ['cd *', 'wc *']);
  });

  it('omits suggestedPatterns for block actions', () => {
    const result = parseClassifierResponse(
      '{"action":"block","reason":"dangerous","suggested_patterns":["rm *"]}',
    );
    assert.equal(result.action, 'block');
    assert.equal(result.suggestedPatterns, undefined);
  });

  it('filters out empty strings and catch-all "*"', () => {
    const result = parseClassifierResponse(
      '{"action":"allow","reason":"safe","suggested_patterns":["cd *","","*"]}',
    );
    assert.deepEqual(result.suggestedPatterns, ['cd *']);
  });

  it('omits suggestedPatterns when not in response', () => {
    const result = parseClassifierResponse('{"action":"allow","reason":"safe"}');
    assert.equal(result.suggestedPatterns, undefined);
  });
});

// ---------------------------------------------------------------------------
// classifyCommand without init
// ---------------------------------------------------------------------------

describe('classifyCommand without init', () => {
  it('returns ask with "not initialized" reason', async () => {
    const result = await classifyCommand('ls -la');
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.includes('not initialized'));
  });

  it('returns ask regardless of context', async () => {
    const result = await classifyCommand('rm -rf /', { cwd: '/tmp', project: 'test' });
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.includes('not initialized'));
  });
});

// ---------------------------------------------------------------------------
// isClassifierAvailable
// ---------------------------------------------------------------------------

describe('isClassifierAvailable', () => {
  it('returns false before init', () => {
    assert.equal(isClassifierAvailable(), false);
  });

  it('returns true after init', () => {
    initClassifier('sk-ant-fake-key-for-test');
    assert.equal(isClassifierAvailable(), true);
  });
});

// ---------------------------------------------------------------------------
// Helper: create a fake Anthropic client for testing
// ---------------------------------------------------------------------------

function fakeClient(createFn: (...args: unknown[]) => Promise<unknown>): OpenAI {
  return { chat: { completions: { create: createFn } } } as unknown as OpenAI;
}

function fakeTextResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

// ---------------------------------------------------------------------------
// classifyCommand with fake client
// ---------------------------------------------------------------------------

describe('classifyCommand with fake client', () => {
  it('returns parsed allow result', async () => {
    let callCount = 0;
    _resetForTest(fakeClient(() => {
      callCount++;
      return Promise.resolve(fakeTextResponse('{"action":"allow","reason":"safe"}'));
    }));

    const result = await classifyCommand('ls -la');
    assert.equal(result.action, 'allow');
    assert.equal(result.reason, 'safe');
    assert.equal(callCount, 1);
  });

  it('returns parsed block result', async () => {
    _resetForTest(fakeClient(() =>
      Promise.resolve(fakeTextResponse('{"action":"block","reason":"dangerous"}')),
    ));

    const result = await classifyCommand('rm -rf /');
    assert.equal(result.action, 'block');
    assert.equal(result.reason, 'dangerous');
  });

  it('returns ask on malformed response', async () => {
    _resetForTest(fakeClient(() =>
      Promise.resolve(fakeTextResponse('not json')),
    ));

    const result = await classifyCommand('weird command');
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.includes('parse'));
  });

  it('returns ask on empty choices', async () => {
    _resetForTest(fakeClient(() =>
      Promise.resolve({ choices: [] }),
    ));

    const result = await classifyCommand('ls');
    assert.equal(result.action, 'ask');
  });

  it('returns suggestedPatterns from classifier', async () => {
    _resetForTest(fakeClient(() =>
      Promise.resolve(fakeTextResponse(
        '{"action":"ask","reason":"ambiguous","suggested_patterns":["cd *"]}',
      )),
    ));

    const result = await classifyCommand('cd /some/path && do-something');
    assert.equal(result.action, 'ask');
    assert.deepEqual(result.suggestedPatterns, ['cd *']);
  });
});

// ---------------------------------------------------------------------------
// Cache behavior
// ---------------------------------------------------------------------------

describe('cache behavior', () => {
  it('does not call API twice for the same command', async () => {
    let callCount = 0;
    _resetForTest(fakeClient(() => {
      callCount++;
      return Promise.resolve(fakeTextResponse('{"action":"allow","reason":"cached"}'));
    }));

    const r1 = await classifyCommand('ls -la');
    const r2 = await classifyCommand('ls -la');

    assert.equal(r1.action, 'allow');
    assert.equal(r2.action, 'allow');
    assert.equal(callCount, 1, 'API should only be called once due to cache');
  });

  it('calls API for different commands', async () => {
    let callCount = 0;
    _resetForTest(fakeClient(() => {
      callCount++;
      return Promise.resolve(fakeTextResponse('{"action":"allow","reason":"ok"}'));
    }));

    await classifyCommand('ls -la');
    await classifyCommand('git status');

    assert.equal(callCount, 2);
  });

  it('treats same command with different cwd as different cache entries', async () => {
    let callCount = 0;
    _resetForTest(fakeClient(() => {
      callCount++;
      return Promise.resolve(fakeTextResponse('{"action":"allow","reason":"ok"}'));
    }));

    await classifyCommand('ls', { cwd: '/home' });
    await classifyCommand('ls', { cwd: '/tmp' });

    assert.equal(callCount, 2);
  });

  it('re-calls API after TTL expires', async () => {
    let callCount = 0;
    _resetForTest(fakeClient(() => {
      callCount++;
      return Promise.resolve(fakeTextResponse('{"action":"allow","reason":"ok"}'));
    }));

    // First call — populates cache
    const r1 = await classifyCommand('ls -la');
    assert.equal(r1.action, 'allow');
    assert.equal(callCount, 1);

    // Backdate the cache entry so it appears stale
    _backdateCacheEntryForTest('ls -la');

    // Second call — cache entry is expired, should call API again
    const r2 = await classifyCommand('ls -la');
    assert.equal(r2.action, 'allow');
    assert.equal(callCount, 2, 'API should be called again after TTL expiry');
  });

  it('serves from cache when entry is still within TTL', async () => {
    let callCount = 0;
    _resetForTest(fakeClient(() => {
      callCount++;
      return Promise.resolve(fakeTextResponse('{"action":"allow","reason":"ok"}'));
    }));

    await classifyCommand('git status');
    // Backdate by less than TTL (1 minute old — still valid)
    _backdateCacheEntryForTest('git status', undefined, 60_000);

    await classifyCommand('git status');
    assert.equal(callCount, 1, 'API should NOT be called — entry still within TTL');
  });
});

// ---------------------------------------------------------------------------
// Error fallback
// ---------------------------------------------------------------------------

describe('error fallback', () => {
  it('returns ask when API throws (fail-open)', async () => {
    _resetForTest(fakeClient(() =>
      Promise.reject(new Error('API connection failed')),
    ));

    const result = await classifyCommand('ls -la');
    assert.equal(result.action, 'ask');
    assert.ok(result.reason.includes('unavailable'));
  });
});
