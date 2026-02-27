/**
 * Unit tests for src/auth.ts — OAuth detection and system prompt building.
 * Run with: node --import tsx/esm --test src/auth.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isOAuthToken, createClient, buildSystemPrompt } from './auth.js';

// ---------------------------------------------------------------------------
// isOAuthToken
// ---------------------------------------------------------------------------

describe('isOAuthToken', () => {
  it('returns true for OAT token', () => {
    assert.equal(isOAuthToken('sk-ant-oat-abc123-def456'), true);
  });

  it('returns false for standard Anthropic API key', () => {
    assert.equal(isOAuthToken('sk-ant-api03-abcdef1234567890'), false);
  });

  it('returns false for OpenAI key', () => {
    assert.equal(isOAuthToken('sk-proj-abc123'), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isOAuthToken(''), false);
  });
});

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

describe('createClient', () => {
  it('returns isOAuth=true for OAT token', () => {
    const { isOAuth } = createClient('sk-ant-oat-test-token-123');
    assert.equal(isOAuth, true);
  });

  it('returns isOAuth=false for standard key', () => {
    const { isOAuth } = createClient('sk-ant-api03-test-key-123');
    assert.equal(isOAuth, false);
  });

  it('returns a client object', () => {
    const { client } = createClient('sk-ant-api03-test-key-123');
    assert.ok(client, 'client should be truthy');
    assert.equal(typeof client.messages, 'object', 'client should have messages namespace');
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('produces 1 block for non-OAuth string input', () => {
    const blocks = buildSystemPrompt('Hello world', false);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.text, 'Hello world');
  });

  it('first block has cache_control for non-OAuth', () => {
    const blocks = buildSystemPrompt('Hello world', false);
    assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' });
  });

  it('produces 2 blocks for OAuth string input (identity prefix + content)', () => {
    const blocks = buildSystemPrompt('Hello world', true);
    assert.equal(blocks.length, 2);
    assert.ok(blocks[0]!.text.includes('Claude Code'), 'first block should be CC identity');
    assert.equal(blocks[1]!.text, 'Hello world');
  });

  it('OAuth identity block has cache_control', () => {
    const blocks = buildSystemPrompt('Hello world', true);
    assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' });
  });

  it('handles string[] input — first block cached, rest uncached', () => {
    const blocks = buildSystemPrompt(['base instructions', 'workspace context'], false);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' });
    assert.equal(blocks[1]!.cache_control, undefined);
  });

  it('skips empty parts in string[] input', () => {
    const blocks = buildSystemPrompt(['', 'only this'], false);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.text, 'only this');
  });

  it('skips empty parts between non-empty parts', () => {
    const blocks = buildSystemPrompt(['first', '', 'third'], false);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.text, 'first');
    assert.equal(blocks[1]!.text, 'third');
  });

  it('all blocks have type "text"', () => {
    const blocks = buildSystemPrompt(['a', 'b', 'c'], true);
    for (const block of blocks) {
      assert.equal(block.type, 'text');
    }
  });
});
