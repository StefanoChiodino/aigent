/**
 * Unit tests for src/reflection.ts — reflection agent.
 *
 * Uses a mock provider (no real LLM calls).
 * Run with: node --import tsx/esm --test src/reflection.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEpisode, generateEpisodeId, type Episode } from './episodes.js';
import { runReflection } from './reflection.js';
import type { Provider, ProviderResponse } from './provider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-reflection-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: generateEpisodeId(),
    startedAt: '2026-03-01T10:00:00.000Z',
    endedAt: '2026-03-01T10:30:00.000Z',
    domain: 'testing',
    task: 'Test episode',
    outcome: 'completed',
    friction: null,
    lessons: [],
    tags: [],
    userRating: null,
    toolsUsed: [],
    turns: 3,
    model: 'claude-sonnet-4-6',
    cost: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUSD: 0.01 },
    source: 'agent',
    profile: 'default',
    sessionId: 'test-session',
    ...overrides,
  };
}

interface MockCall {
  systemPrompt: string | string[];
  messages: unknown[];
  options: { model: string; maxTokens: number; thinking: string };
}

function mockProvider(responseText: string): { provider: Provider; calls: MockCall[] } {
  const calls: MockCall[] = [];
  const provider = {
    sendMessage: async (
      systemPrompt: string | string[],
      messages: unknown[],
      _tools: unknown[],
      options: { model: string; maxTokens: number; thinking: string },
    ): Promise<ProviderResponse> => {
      calls.push({ systemPrompt, messages, options });
      return {
        text: responseText,
        toolCalls: [],
        stopReason: 'end_turn' as const,
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      };
    },
  } as unknown as Provider;
  return { provider, calls };
}

function appendEpisodes(count: number, overrides: Partial<Episode> = {}): void {
  for (let i = 0; i < count; i++) {
    appendEpisode(tmpDir, makeEpisode({
      id: `ep-${i}`,
      task: `Task ${i}`,
      endedAt: `2026-03-0${Math.min(i + 1, 9)}T10:00:00.000Z`,
      ...overrides,
    }));
  }
}

const VALID_RESPONSE = JSON.stringify({
  patterns: [
    { description: 'Build failures after web UI changes', frequency: 3, episodeIds: ['ep-1', 'ep-2', 'ep-3'], severity: 'high' },
  ],
  memoryLessons: ['Always run make check before committing web/src changes'],
  todoItems: ['- [ ] Add pre-commit hook for web build'],
});

const EMPTY_RESPONSE = JSON.stringify({ patterns: [], memoryLessons: [], todoItems: [] });

// ---------------------------------------------------------------------------
// Skips when not enough episodes
// ---------------------------------------------------------------------------

describe('reflection: minimum episode threshold', () => {
  it('returns no-op when fewer than 5 episodes', async () => {
    appendEpisodes(3);
    const { provider, calls } = mockProvider(VALID_RESPONSE);
    const result = await runReflection(provider, tmpDir);
    assert.equal(result.patternsFound, 0);
    assert.equal(result.memoryUpdated, false);
    assert.equal(result.todoUpdated, false);
    assert.equal(calls.length, 0, 'should not call provider');
  });

  it('returns no-op when no episodes file exists', async () => {
    const { provider, calls } = mockProvider(VALID_RESPONSE);
    const result = await runReflection(provider, tmpDir);
    assert.equal(result.patternsFound, 0);
    assert.equal(calls.length, 0);
  });

  it('runs when exactly 5 episodes exist', async () => {
    appendEpisodes(5);
    const { provider, calls } = mockProvider(EMPTY_RESPONSE);
    await runReflection(provider, tmpDir);
    assert.equal(calls.length, 1, 'should call provider with 5 episodes');
  });
});

// ---------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------

describe('reflection: provider call', () => {
  it('calls provider with episode data in the prompt', async () => {
    appendEpisodes(6, { friction: 'Build failed', domain: 'web-ui' });
    const { provider, calls } = mockProvider(EMPTY_RESPONSE);
    await runReflection(provider, tmpDir);

    assert.equal(calls.length, 1);
    const userMsg = calls[0]!.messages[0] as { content: string };
    assert.ok(userMsg.content.includes('Task 0'), 'prompt should include episode tasks');
    assert.ok(userMsg.content.includes('web-ui'), 'prompt should include domain');
    assert.ok(userMsg.content.includes('Build failed'), 'prompt should include friction');
  });

  it('uses Haiku model', async () => {
    appendEpisodes(6);
    const { provider, calls } = mockProvider(EMPTY_RESPONSE);
    await runReflection(provider, tmpDir);

    assert.equal(calls[0]!.options.model, 'claude-haiku-4-5-20251001');
  });

  it('includes existing MEMORY.md in prompt', async () => {
    appendEpisodes(6);
    writeFileSync(join(tmpDir, 'MEMORY.md'), '# Existing Memory\n\nSome knowledge here\n');
    const { provider, calls } = mockProvider(EMPTY_RESPONSE);
    await runReflection(provider, tmpDir);

    const userMsg = calls[0]!.messages[0] as { content: string };
    assert.ok(userMsg.content.includes('Existing Memory'), 'prompt should include existing MEMORY.md');
    assert.ok(userMsg.content.includes('Some knowledge here'));
  });
});

// ---------------------------------------------------------------------------
// MEMORY.md updates
// ---------------------------------------------------------------------------

describe('reflection: MEMORY.md updates', () => {
  it('appends Reflection Insights section to MEMORY.md', async () => {
    appendEpisodes(6);
    writeFileSync(join(tmpDir, 'MEMORY.md'), '# Memory\n\nExisting content\n');
    const { provider } = mockProvider(VALID_RESPONSE);
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.memoryUpdated, true);
    const memory = readFileSync(join(tmpDir, 'MEMORY.md'), 'utf-8');
    assert.ok(memory.includes('# Memory'), 'should preserve existing header');
    assert.ok(memory.includes('Existing content'), 'should preserve existing content');
    assert.ok(memory.includes('## Reflection Insights (auto-generated)'));
    assert.ok(memory.includes('Always run make check'));
  });

  it('creates MEMORY.md if it does not exist', async () => {
    appendEpisodes(6);
    const { provider } = mockProvider(VALID_RESPONSE);
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.memoryUpdated, true);
    assert.ok(existsSync(join(tmpDir, 'MEMORY.md')));
    const memory = readFileSync(join(tmpDir, 'MEMORY.md'), 'utf-8');
    assert.ok(memory.includes('## Reflection Insights (auto-generated)'));
    assert.ok(memory.includes('Always run make check'));
  });

  it('appends to existing Reflection Insights section', async () => {
    appendEpisodes(6);
    writeFileSync(
      join(tmpDir, 'MEMORY.md'),
      '# Memory\n\n## Reflection Insights (auto-generated)\n\n- Previous insight\n',
    );
    const { provider } = mockProvider(VALID_RESPONSE);
    await runReflection(provider, tmpDir);

    const memory = readFileSync(join(tmpDir, 'MEMORY.md'), 'utf-8');
    assert.ok(memory.includes('- Previous insight'), 'should keep existing insights');
    assert.ok(memory.includes('Always run make check'), 'should add new insight');
  });

  it('does not modify MEMORY.md when no lessons found', async () => {
    appendEpisodes(6);
    writeFileSync(join(tmpDir, 'MEMORY.md'), '# Original\n');
    const { provider } = mockProvider(EMPTY_RESPONSE);
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.memoryUpdated, false);
    const memory = readFileSync(join(tmpDir, 'MEMORY.md'), 'utf-8');
    assert.equal(memory, '# Original\n', 'MEMORY.md should be untouched');
  });
});

// ---------------------------------------------------------------------------
// TODO.md updates
// ---------------------------------------------------------------------------

describe('reflection: TODO.md updates', () => {
  it('appends Reflection-Suggested section to TODO.md', async () => {
    appendEpisodes(6);
    // TODO.md is at parent dir (workspacePath/../TODO.md)
    const todoPath = join(tmpDir, '..', 'TODO.md');
    writeFileSync(todoPath, '# TODO\n\n- [ ] Existing item\n');
    const { provider } = mockProvider(VALID_RESPONSE);
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.todoUpdated, true);
    const todo = readFileSync(todoPath, 'utf-8');
    assert.ok(todo.includes('- [ ] Existing item'), 'should preserve existing items');
    assert.ok(todo.includes('## Reflection-Suggested'));
    assert.ok(todo.includes('pre-commit hook'));
  });

  it('does not modify TODO.md when no items found', async () => {
    appendEpisodes(6);
    const todoPath = join(tmpDir, '..', 'TODO.md');
    writeFileSync(todoPath, '# TODO\n');
    const { provider } = mockProvider(EMPTY_RESPONSE);
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.todoUpdated, false);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('reflection: error handling', () => {
  it('handles malformed JSON response gracefully', async () => {
    appendEpisodes(6);
    const { provider } = mockProvider('this is not valid json at all');
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.patternsFound, 0);
    assert.equal(result.memoryUpdated, false);
    assert.equal(result.todoUpdated, false);
  });

  it('handles invalid structure gracefully', async () => {
    appendEpisodes(6);
    const { provider } = mockProvider(JSON.stringify({ patterns: 'not an array' }));
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.patternsFound, 0);
  });

  it('handles provider error gracefully', async () => {
    appendEpisodes(6);
    const provider = {
      sendMessage: async () => { throw new Error('API down'); },
    } as unknown as Provider;
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.patternsFound, 0);
    assert.equal(result.memoryUpdated, false);
  });
});

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

describe('reflection: audit log', () => {
  it('writes reflection record to reflections.ndjson', async () => {
    appendEpisodes(6);
    const { provider } = mockProvider(VALID_RESPONSE);
    await runReflection(provider, tmpDir);

    const logPath = join(tmpDir, 'reflections.ndjson');
    assert.ok(existsSync(logPath), 'reflections.ndjson should be created');
    const line = readFileSync(logPath, 'utf-8').trim();
    const record = JSON.parse(line) as { episodesAnalyzed: number; patternsFound: number; model: string };
    assert.equal(record.episodesAnalyzed, 6);
    assert.equal(record.patternsFound, 1);
    assert.equal(record.model, 'claude-haiku-4-5-20251001');
  });
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

describe('reflection: result', () => {
  it('returns pattern descriptions as insights', async () => {
    appendEpisodes(6);
    const { provider } = mockProvider(VALID_RESPONSE);
    const result = await runReflection(provider, tmpDir);

    assert.equal(result.patternsFound, 1);
    assert.ok(result.insights.includes('Build failures after web UI changes'));
  });
});
