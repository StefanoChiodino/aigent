/**
 * Minimal smoke tests for Agent configuration helpers.
 *
 * Uses the node:test runner with assert-style expectations to avoid extra
 * dependencies (jest/vitest). This file focuses on pure logic: it doesn't
 * exercise provider calls or tool execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, MAX_AGENT_ITERATIONS, MAX_SPAWN_AGENT_ITERATIONS, DEFAULT_SPAWN_AGENT_ITERATIONS } from './agent.js';
import type { Provider } from './provider.js';

const mockProvider: Provider = {
  sendMessage: async () => ({
    id: 'mock',
    stop_reason: 'end_turn',
    output: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }),
  listModels: async () => [],
  isOAuthToken: false,
};

describe('Agent', () => {
  describe('getEffectiveMaxTokens', () => {
    it('uses model-specific max tokens when available', () => {
      const agent = new Agent({
        provider: mockProvider,
        modelMaxTokens: {
          'claude-sonnet-4-6': 16_384,
          'claude-opus-4-6': 32_768,
        },
      });

      assert.equal(agent['getEffectiveMaxTokens']('claude-sonnet-4-6'), 16_384);
      assert.equal(agent['getEffectiveMaxTokens']('claude-opus-4-6'), 32_768);
    });

    it('falls back to default maxTokens when model not found', () => {
      const agent = new Agent({
        provider: mockProvider,
        maxTokens: 8_192,
        modelMaxTokens: {
          'claude-sonnet-4-6': 16_384,
        },
      });

      assert.equal(agent['getEffectiveMaxTokens']('claude-opus-4-6'), 8_192);
    });

    it('uses provided default maxTokens when model id is empty', () => {
      const agent = new Agent({
        provider: mockProvider,
        maxTokens: 4_096,
      });

      assert.equal(agent['getEffectiveMaxTokens'](''), 4_096);
    });
  });

  describe('constructor', () => {
    it('initializes modelMaxTokens from options', () => {
      const modelMaxTokens = { 'claude-sonnet-4-6': 16_384 };
      const agent = new Agent({
        provider: mockProvider,
        modelMaxTokens,
      });

      assert.deepEqual(agent['modelMaxTokens'], modelMaxTokens);
    });
  });
});

describe('iteration limits', () => {
  it('MAX_AGENT_ITERATIONS is at least 100', () => {
    assert.ok(MAX_AGENT_ITERATIONS >= 100, `Expected >= 100, got ${MAX_AGENT_ITERATIONS}`);
  });

  it('MAX_SPAWN_AGENT_ITERATIONS is at least 100', () => {
    assert.ok(MAX_SPAWN_AGENT_ITERATIONS >= 100, `Expected >= 100, got ${MAX_SPAWN_AGENT_ITERATIONS}`);
  });

  it('DEFAULT_SPAWN_AGENT_ITERATIONS is less than MAX_SPAWN_AGENT_ITERATIONS', () => {
    assert.ok(
      DEFAULT_SPAWN_AGENT_ITERATIONS < MAX_SPAWN_AGENT_ITERATIONS,
      `Default ${DEFAULT_SPAWN_AGENT_ITERATIONS} should be less than max ${MAX_SPAWN_AGENT_ITERATIONS}`,
    );
  });
});