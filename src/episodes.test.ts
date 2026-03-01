/**
 * Unit tests for src/episodes.ts — structured episode logging.
 * Run with: node --import tsx/esm --test src/episodes.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendEpisode, queryEpisodes, autoLogEpisode, generateEpisodeId,
  markSessionLogged, wasSessionLogged, inferDomain, _resetForTest,
  type Episode, type AutoEpisodeContext,
} from './episodes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-episodes-test-'));
  _resetForTest();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: generateEpisodeId(),
    startedAt: '2026-02-28T10:00:00.000Z',
    endedAt: '2026-02-28T10:30:00.000Z',
    domain: 'testing',
    task: 'Test episode',
    outcome: 'completed',
    friction: null,
    lessons: [],
    tags: [],
    userRating: null,
    toolsUsed: ['exec', 'read_file'],
    turns: 5,
    model: 'claude-opus-4-6',
    cost: {
      inputTokens: 10000,
      outputTokens: 500,
      cacheReadTokens: 8000,
      cacheWriteTokens: 2000,
      estimatedUSD: 0.05,
    },
    source: 'agent',
    profile: 'default',
    sessionId: 'sess_001',
    ...overrides,
  };
}

function readLines(workspacePath: string): string[] {
  return readFileSync(join(workspacePath, 'episodes.ndjson'), 'utf-8').trim().split('\n');
}

// ---------------------------------------------------------------------------
// appendEpisode
// ---------------------------------------------------------------------------

describe('appendEpisode', () => {
  it('creates the file and writes one NDJSON line', () => {
    const ep = makeEpisode();
    appendEpisode(tmpDir, ep);
    const lines = readLines(tmpDir);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.domain, 'testing');
    assert.equal(parsed.task, 'Test episode');
  });

  it('appends multiple episodes as separate lines', () => {
    appendEpisode(tmpDir, makeEpisode({ domain: 'a' }));
    appendEpisode(tmpDir, makeEpisode({ domain: 'b' }));
    appendEpisode(tmpDir, makeEpisode({ domain: 'c' }));
    const lines = readLines(tmpDir);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]!).domain, 'a');
    assert.equal(JSON.parse(lines[2]!).domain, 'c');
  });

  it('each line is valid JSON', () => {
    appendEpisode(tmpDir, makeEpisode());
    appendEpisode(tmpDir, makeEpisode());
    const lines = readLines(tmpDir);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  it('does not throw on write failure', () => {
    assert.doesNotThrow(() => {
      appendEpisode('/nonexistent/deeply/nested/path', makeEpisode());
    });
  });

  it('preserves all Episode fields', () => {
    const ep = makeEpisode({
      friction: 'CSS was tricky',
      lessons: ['Use flexbox', 'Check mobile'],
      tags: ['css', 'responsive'],
      userRating: 4,
    });
    appendEpisode(tmpDir, ep);
    const parsed = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(parsed.friction, 'CSS was tricky');
    assert.deepEqual(parsed.lessons, ['Use flexbox', 'Check mobile']);
    assert.deepEqual(parsed.tags, ['css', 'responsive']);
    assert.equal(parsed.userRating, 4);
    assert.equal(parsed.cost.estimatedUSD, 0.05);
  });
});

// ---------------------------------------------------------------------------
// queryEpisodes
// ---------------------------------------------------------------------------

describe('queryEpisodes', () => {
  it('returns empty array when no file exists', () => {
    const result = queryEpisodes(tmpDir, {});
    assert.deepEqual(result, []);
  });

  it('returns all episodes when no filters set', () => {
    appendEpisode(tmpDir, makeEpisode({ domain: 'a' }));
    appendEpisode(tmpDir, makeEpisode({ domain: 'b' }));
    const result = queryEpisodes(tmpDir, {});
    assert.equal(result.length, 2);
  });

  it('returns most recent first', () => {
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-02-01T00:00:00Z', task: 'first' }));
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-02-28T00:00:00Z', task: 'second' }));
    const result = queryEpisodes(tmpDir, {});
    assert.equal(result[0]!.task, 'second');
    assert.equal(result[1]!.task, 'first');
  });

  it('filters by domain (exact match)', () => {
    appendEpisode(tmpDir, makeEpisode({ domain: 'debugging' }));
    appendEpisode(tmpDir, makeEpisode({ domain: 'writing' }));
    appendEpisode(tmpDir, makeEpisode({ domain: 'debugging' }));
    const result = queryEpisodes(tmpDir, { domain: 'debugging' });
    assert.equal(result.length, 2);
    assert.ok(result.every(ep => ep.domain === 'debugging'));
  });

  it('filters by outcome', () => {
    appendEpisode(tmpDir, makeEpisode({ outcome: 'completed' }));
    appendEpisode(tmpDir, makeEpisode({ outcome: 'failed' }));
    appendEpisode(tmpDir, makeEpisode({ outcome: 'completed' }));
    const result = queryEpisodes(tmpDir, { outcome: 'failed' });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.outcome, 'failed');
  });

  it('filters by tags (ANY match)', () => {
    appendEpisode(tmpDir, makeEpisode({ tags: ['css', 'ui'] }));
    appendEpisode(tmpDir, makeEpisode({ tags: ['typescript'] }));
    appendEpisode(tmpDir, makeEpisode({ tags: ['css', 'performance'] }));
    const result = queryEpisodes(tmpDir, { tags: ['css'] });
    assert.equal(result.length, 2);
  });

  it('filters by date range (since)', () => {
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-01-15T00:00:00Z' }));
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-02-15T00:00:00Z' }));
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-03-15T00:00:00Z' }));
    const result = queryEpisodes(tmpDir, { since: '2026-02-01' });
    assert.equal(result.length, 2);
  });

  it('filters by date range (until)', () => {
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-01-15T00:00:00Z' }));
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-02-15T00:00:00Z' }));
    appendEpisode(tmpDir, makeEpisode({ endedAt: '2026-03-15T00:00:00Z' }));
    const result = queryEpisodes(tmpDir, { until: '2026-02-28' });
    assert.equal(result.length, 2);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      appendEpisode(tmpDir, makeEpisode({ task: `task ${i}` }));
    }
    const result = queryEpisodes(tmpDir, { limit: 3 });
    assert.equal(result.length, 3);
  });

  it('caps limit at 200', () => {
    const result = queryEpisodes(tmpDir, { limit: 999 });
    // Just verify it doesn't error — with 0 episodes, returns 0
    assert.equal(result.length, 0);
  });

  it('skips malformed NDJSON lines without crashing', () => {
    const path = join(tmpDir, 'episodes.ndjson');
    appendEpisode(tmpDir, makeEpisode({ domain: 'good' }));
    // Append a malformed line
    writeFileSync(path,
      readFileSync(path, 'utf-8') + 'this is not json\n' + JSON.stringify(makeEpisode({ domain: 'also-good' })) + '\n',
    );
    const result = queryEpisodes(tmpDir, {});
    assert.equal(result.length, 2);
    // Newest first (also-good was appended last)
    assert.equal(result[0]!.domain, 'also-good');
    assert.equal(result[1]!.domain, 'good');
  });

  it('filters by source', () => {
    appendEpisode(tmpDir, makeEpisode({ source: 'agent' }));
    appendEpisode(tmpDir, makeEpisode({ source: 'auto-reset' }));
    appendEpisode(tmpDir, makeEpisode({ source: 'auto-shutdown' }));
    const result = queryEpisodes(tmpDir, { source: 'agent' });
    assert.equal(result.length, 1);
    assert.equal(result[0]!.source, 'agent');
  });

  it('filters by auto-compact source', () => {
    appendEpisode(tmpDir, makeEpisode({ source: 'auto-compact' }));
    appendEpisode(tmpDir, makeEpisode({ source: 'agent' }));
    appendEpisode(tmpDir, makeEpisode({ source: 'auto-compact' }));
    const result = queryEpisodes(tmpDir, { source: 'auto-compact' });
    assert.equal(result.length, 2);
    assert.ok(result.every(ep => ep.source === 'auto-compact'));
  });
});

// ---------------------------------------------------------------------------
// autoLogEpisode
// ---------------------------------------------------------------------------

describe('autoLogEpisode', () => {
  function makeCtx(overrides: Partial<AutoEpisodeContext> = {}): AutoEpisodeContext {
    return {
      messages: [
        { role: 'user', content: 'Fix the login bug in auth.ts', timestamp: '2026-02-28T10:00:00Z' },
        { role: 'assistant', content: 'I found the issue.', timestamp: '2026-02-28T10:01:00Z' },
        { role: 'user', content: 'Great, apply the fix.', timestamp: '2026-02-28T10:02:00Z' },
        { role: 'assistant', content: 'Done.', timestamp: '2026-02-28T10:03:00Z' },
      ],
      usage: { input: 5000, output: 300, cacheRead: 4000, cacheWrite: 1000, cost: 0.03 },
      model: 'claude-opus-4-6',
      profile: 'default',
      sessionId: 'sess_auto_001',
      workspacePath: tmpDir,
      toolsUsed: ['read_file', 'edit_file', 'exec', 'read_file'],
      sessionStartedAt: '2026-02-28T09:59:00Z',
      source: 'auto-shutdown',
      ...overrides,
    };
  }

  it('generates an episode from session context', () => {
    autoLogEpisode(makeCtx());
    const lines = readLines(tmpDir);
    assert.equal(lines.length, 1);
    const ep = JSON.parse(lines[0]!) as Episode;
    assert.equal(ep.source, 'auto-shutdown');
    assert.equal(ep.turns, 2); // 2 user messages
    assert.equal(ep.model, 'claude-opus-4-6');
    assert.equal(ep.sessionId, 'sess_auto_001');
  });

  it('skips sessions with fewer than 2 user messages', () => {
    autoLogEpisode(makeCtx({
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-02-28T10:00:00Z' },
        { role: 'assistant', content: 'hi', timestamp: '2026-02-28T10:01:00Z' },
      ],
    }));
    const path = join(tmpDir, 'episodes.ndjson');
    // File should not exist or be empty
    try {
      const content = readFileSync(path, 'utf-8').trim();
      assert.equal(content, '');
    } catch {
      // File doesn't exist — also fine
    }
  });

  it('infers domain from first user message', () => {
    autoLogEpisode(makeCtx({
      messages: [
        { role: 'user', content: 'Fix the login bug in auth.ts', timestamp: '2026-02-28T10:00:00Z' },
        { role: 'assistant', content: 'Fixed.', timestamp: '2026-02-28T10:01:00Z' },
        { role: 'user', content: 'Thanks', timestamp: '2026-02-28T10:02:00Z' },
      ],
    }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.domain, 'debugging'); // "bug" and "fix" trigger debugging
  });

  it('deduplicates tools used', () => {
    autoLogEpisode(makeCtx({ toolsUsed: ['exec', 'exec', 'read_file', 'exec'] }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.deepEqual(ep.toolsUsed.sort(), ['exec', 'read_file']);
  });

  it('records cost from usage', () => {
    autoLogEpisode(makeCtx());
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.cost.inputTokens, 5000);
    assert.equal(ep.cost.estimatedUSD, 0.03);
  });

  it('uses sessionStartedAt for startedAt', () => {
    autoLogEpisode(makeCtx({ sessionStartedAt: '2026-02-28T09:00:00Z' }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.startedAt, '2026-02-28T09:00:00Z');
  });

  it('uses source from context', () => {
    autoLogEpisode(makeCtx({ source: 'auto-reset' }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.source, 'auto-reset');
  });

  it('accepts auto-compact source', () => {
    autoLogEpisode(makeCtx({ source: 'auto-compact' }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.source, 'auto-compact');
  });

  it('computes average userRating from per-message ratings', () => {
    autoLogEpisode(makeCtx({
      ratings: { 'msg1': 5, 'msg2': 3, 'msg3': 4 },
    }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.userRating, 4); // Math.round((5+3+4)/3) = 4
  });

  it('sets userRating to null when no ratings provided', () => {
    autoLogEpisode(makeCtx());
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.userRating, null);
  });

  it('sets userRating to null when ratings is empty', () => {
    autoLogEpisode(makeCtx({ ratings: {} }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.userRating, null);
  });

  it('joins friction signals into friction field', () => {
    autoLogEpisode(makeCtx({
      frictionSignals: ['exec failed', 'API error: rate limited'],
    }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.friction, 'exec failed; API error: rate limited');
  });

  it('sets friction to null when no friction signals', () => {
    autoLogEpisode(makeCtx());
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.friction, null);
  });

  it('sets friction to null when frictionSignals is empty array', () => {
    autoLogEpisode(makeCtx({ frictionSignals: [] }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.friction, null);
  });

  it('handles single rating correctly', () => {
    autoLogEpisode(makeCtx({ ratings: { 'msg1': 2 } }));
    const ep = JSON.parse(readLines(tmpDir)[0]!) as Episode;
    assert.equal(ep.userRating, 2);
  });
});

// ---------------------------------------------------------------------------
// inferDomain
// ---------------------------------------------------------------------------

describe('inferDomain', () => {
  it('maps debugging keywords', () => {
    assert.equal(inferDomain('Fix the bug in auth.ts'), 'debugging');
    assert.equal(inferDomain('There is an error in production'), 'debugging');
    assert.equal(inferDomain('The app is crashing on startup'), 'debugging');
  });

  it('maps web-ui keywords', () => {
    assert.equal(inferDomain('Update the CSS layout'), 'web-ui');
    assert.equal(inferDomain('Add a sidebar component'), 'web-ui');
  });

  it('maps writing keywords', () => {
    assert.equal(inferDomain('Draft chapter 3 of the book'), 'writing');
    assert.equal(inferDomain('Write an article about testing'), 'writing');
  });

  it('maps agent-dev keywords', () => {
    assert.equal(inferDomain('Add a new tool to the agent'), 'agent-dev');
    assert.equal(inferDomain('Update the gatekeeper startup'), 'agent-dev');
  });

  it('returns general for unrecognized content', () => {
    assert.equal(inferDomain('Hello, how are you?'), 'general');
    assert.equal(inferDomain('What is the weather like?'), 'general');
  });

  it('is case-insensitive', () => {
    assert.equal(inferDomain('FIX THE BUG'), 'debugging');
    assert.equal(inferDomain('WRITE a CHAPTER'), 'writing');
  });
});

// ---------------------------------------------------------------------------
// markSessionLogged / wasSessionLogged
// ---------------------------------------------------------------------------

describe('session logging tracking', () => {
  it('returns false before any logging', () => {
    assert.equal(wasSessionLogged('sess_001'), false);
  });

  it('returns true after marking', () => {
    markSessionLogged('sess_001');
    assert.equal(wasSessionLogged('sess_001'), true);
  });

  it('different session IDs are independent', () => {
    markSessionLogged('sess_001');
    assert.equal(wasSessionLogged('sess_002'), false);
  });

  it('_resetForTest clears state', () => {
    markSessionLogged('sess_001');
    _resetForTest();
    assert.equal(wasSessionLogged('sess_001'), false);
  });
});

// ---------------------------------------------------------------------------
// generateEpisodeId
// ---------------------------------------------------------------------------

describe('generateEpisodeId', () => {
  it('produces unique IDs', () => {
    const a = generateEpisodeId();
    const b = generateEpisodeId();
    assert.notEqual(a, b);
  });

  it('contains an ISO timestamp', () => {
    const id = generateEpisodeId();
    // Should start with something like 2026-02-28T
    assert.match(id, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('contains a random suffix after underscore', () => {
    const id = generateEpisodeId();
    assert.match(id, /_[a-z0-9]+$/);
  });
});
