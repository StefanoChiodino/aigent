/**
 * Unit tests for src/embeddings.ts — cosine similarity and text utilities.
 * These test pure math functions only — no model download required.
 *
 * Run with: node --import tsx/esm --test src/embeddings.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity } from './embeddings.js';
import { episodeToText } from './episode-index.js';
import type { Episode } from './episodes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: '2026-03-01T10:00:00.000Z_abc123',
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

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = new Float32Array([1, 2, 3, 4]);
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1.0) < 1e-6);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-6);
  });

  it('returns -1.0 for opposite vectors', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    assert.ok(Math.abs(cosineSimilarity(a, b) - (-1.0)) < 1e-6);
  });

  it('returns 0.0 when either vector is zero', () => {
    const a = new Float32Array([1, 2, 3]);
    const zero = new Float32Array([0, 0, 0]);
    assert.equal(cosineSimilarity(a, zero), 0);
    assert.equal(cosineSimilarity(zero, a), 0);
  });

  it('returns value between -1 and 1 for arbitrary vectors', () => {
    const a = new Float32Array([1, 3, -2, 5]);
    const b = new Float32Array([2, -1, 4, 0]);
    const sim = cosineSimilarity(a, b);
    assert.ok(sim >= -1 && sim <= 1);
  });

  it('throws for vectors of different lengths', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    assert.throws(() => cosineSimilarity(a, b), /same length/);
  });
});

// ---------------------------------------------------------------------------
// episodeToText
// ---------------------------------------------------------------------------

describe('episodeToText', () => {
  it('includes task and domain', () => {
    const ep = makeEpisode({ task: 'Fix the bug', domain: 'debugging' });
    const text = episodeToText(ep);
    assert.ok(text.includes('Fix the bug'));
    assert.ok(text.includes('debugging'));
  });

  it('includes friction when present', () => {
    const ep = makeEpisode({ friction: 'Build failed twice' });
    const text = episodeToText(ep);
    assert.ok(text.includes('Build failed twice'));
  });

  it('includes lessons', () => {
    const ep = makeEpisode({ lessons: ['Always run tests first', 'Check types'] });
    const text = episodeToText(ep);
    assert.ok(text.includes('Always run tests first'));
    assert.ok(text.includes('Check types'));
  });

  it('includes tags', () => {
    const ep = makeEpisode({ tags: ['typescript', 'css'] });
    const text = episodeToText(ep);
    assert.ok(text.includes('typescript'));
    assert.ok(text.includes('css'));
  });

  it('omits friction when null', () => {
    const ep = makeEpisode({ friction: null, task: 'Simple task', domain: 'general' });
    const text = episodeToText(ep);
    // Should not contain "null" as a string
    assert.ok(!text.includes('null'));
  });
});
