/**
 * Unit tests for src/compact.ts — context compaction.
 * Run with: node --import tsx/esm --test src/compact.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compactConversation } from './compact.js';
import type { Provider, ProviderMessage, ProviderResponse } from './provider.js';

/** Minimal mock provider that returns a canned summary. */
function mockProvider(summary = 'Summary of earlier work.'): Provider {
  return {
    async sendMessage(): Promise<ProviderResponse> {
      return {
        text: summary,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, contextTokens: 150 },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// compactConversation
// ---------------------------------------------------------------------------

describe('compactConversation', () => {
  it('does not compact a short conversation', async () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const { messages: result, summary } = await compactConversation(mockProvider(), 'test', messages);
    assert.equal(summary, '');
    assert.deepEqual(result, messages);
  });

  it('compacts a long multi-turn conversation', async () => {
    // 6 user turns — should keep 4, summarize 2
    const messages: ProviderMessage[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ role: 'user', content: `question ${i}` });
      messages.push({ role: 'assistant', content: `answer ${i}` });
    }
    const { messages: result, summary } = await compactConversation(mockProvider(), 'test', messages);
    assert.ok(summary.length > 0, 'should produce a summary');
    // Should reduce overall message count
    assert.ok(result.length < messages.length, `should reduce messages (was ${messages.length}, now ${result.length})`);
    assert.equal(result[0]!.role, 'user');
    assert.ok((result[0]! as { content: string }).content.includes('Context from earlier'));
  });

  it('compacts a tool-heavy single-turn conversation (the mid-loop bug)', async () => {
    // Simulate a single user message followed by many assistant+tool_result pairs.
    // This is the scenario where the old code failed — only 1 user message meant
    // compaction would bail out with an empty summary.
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Build me a web app' },
    ];
    // 10 tool iterations
    for (let i = 0; i < 10; i++) {
      messages.push({
        role: 'assistant',
        content: `Working on step ${i}`,
        toolCalls: [{ id: `call_${i}`, name: 'write_file', input: { path: `file${i}.ts` } }],
      });
      messages.push({
        role: 'tool_result',
        results: [{ id: `call_${i}`, content: `File file${i}.ts written.` }],
      });
    }
    // Total: 1 user + 10 assistant + 10 tool_result = 21 messages

    const { messages: result, summary } = await compactConversation(mockProvider(), 'test', messages);
    assert.ok(summary.length > 0, 'should produce a summary for tool-heavy conversations');
    // Should have compacted old messages and kept recent turns
    assert.ok(result.length < messages.length, `should reduce message count (was ${messages.length}, now ${result.length})`);
    // First two messages should be the summary exchange
    assert.equal(result[0]!.role, 'user');
    assert.ok((result[0]! as { content: string }).content.includes('Context from earlier'));
    assert.equal(result[1]!.role, 'assistant');
  });

  it('keeps recent tool_result turns intact after compaction', async () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'Do stuff' },
    ];
    for (let i = 0; i < 8; i++) {
      messages.push({
        role: 'assistant',
        content: `step ${i}`,
        toolCalls: [{ id: `c${i}`, name: 'exec', input: { cmd: `cmd${i}` } }],
      });
      messages.push({
        role: 'tool_result',
        results: [{ id: `c${i}`, content: `output ${i}` }],
      });
    }

    const { messages: result, summary } = await compactConversation(
      mockProvider(), 'test', messages, undefined, 4,
    );
    assert.ok(summary.length > 0);

    // The kept recent messages should have intact assistant+tool_result pairs
    // (no orphaned tool_use blocks)
    for (let i = 2; i < result.length; i++) {
      const msg = result[i]!;
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const next = result[i + 1];
        assert.ok(next && next.role === 'tool_result', `tool_use at index ${i} should be followed by tool_result`);
      }
    }
  });
});
