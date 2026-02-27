/**
 * Unit tests for src/classifier.ts — Tier 3 Haiku command classifier.
 * Run with: node --import tsx/esm --test src/classifier.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';

import {
  classifyCommand,
  isClassifierAvailable,
  initClassifier,
  parseClassifierResponse,
  _resetForTest,
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

function fakeClient(createFn: (...args: unknown[]) => Promise<unknown>): Anthropic {
  return { messages: { create: createFn } } as unknown as Anthropic;
}

function fakeTextResponse(text: string) {
  return { content: [{ type: 'text' as const, text }] };
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

  it('returns ask on empty content array', async () => {
    _resetForTest(fakeClient(() =>
      Promise.resolve({ content: [] }),
    ));

    const result = await classifyCommand('ls');
    assert.equal(result.action, 'ask');
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
