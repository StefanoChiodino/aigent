/**
 * Unit tests for src/pricing.ts — model cost computation.
 * Run with: node --import tsx/esm --test src/pricing.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost } from './pricing.js';
import type { TokenUsage } from './protocol.js';

// ---------------------------------------------------------------------------
// Helper to build a TokenUsage object
// ---------------------------------------------------------------------------

function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0): TokenUsage {
  return { input, output, cacheRead, cacheWrite };
}

// ---------------------------------------------------------------------------
// computeCost
// ---------------------------------------------------------------------------

describe('computeCost', () => {
  // -- Exact model matches --

  it('computes correct cost for claude-opus-4-6', () => {
    // 1M input tokens @ $15, 1M output @ $75
    const cost = computeCost('claude-opus-4-6', usage(1_000_000, 1_000_000));
    assert.equal(cost, 15 + 75);
  });

  it('computes correct cost for claude-sonnet-4-6', () => {
    const cost = computeCost('claude-sonnet-4-6', usage(1_000_000, 1_000_000));
    assert.equal(cost, 3 + 15);
  });

  it('computes correct cost for gpt-4o', () => {
    const cost = computeCost('gpt-4o', usage(1_000_000, 1_000_000));
    assert.equal(cost, 2.5 + 10);
  });

  it('computes correct cost for gpt-4o-mini', () => {
    const cost = computeCost('gpt-4o-mini', usage(1_000_000, 1_000_000));
    assert.equal(cost, 0.15 + 0.6);
  });

  // -- Cache pricing --

  it('includes cache read and write costs', () => {
    // Opus: cacheRead=$1.5/M, cacheWrite=$18.75/M
    const cost = computeCost('claude-opus-4-6', usage(0, 0, 1_000_000, 1_000_000));
    assert.equal(cost, 1.5 + 18.75);
  });

  it('combines all four token types', () => {
    // Sonnet: input=3, output=15, cacheRead=0.3, cacheWrite=3.75 per million
    const cost = computeCost('claude-sonnet-4-6', usage(500_000, 200_000, 100_000, 50_000));
    const expected =
      (500_000 * 3 + 200_000 * 15 + 100_000 * 0.3 + 50_000 * 3.75) / 1_000_000;
    assert.equal(cost, expected);
  });

  // -- Prefix matching --

  it('matches model by prefix (model starts with known key)', () => {
    // A dated version like 'claude-opus-4-6-20260301' starts with 'claude-opus-4-6'
    const cost = computeCost('claude-opus-4-6-20260301', usage(1_000_000));
    assert.equal(cost, 15); // input only
  });

  // -- Family matching --

  it('matches "opus" family name', () => {
    const cost = computeCost('some-opus-variant', usage(1_000_000));
    assert.equal(cost, 15);
  });

  it('matches "sonnet" family name', () => {
    const cost = computeCost('my-sonnet-model', usage(1_000_000));
    assert.equal(cost, 3);
  });

  it('matches "haiku" family name', () => {
    const cost = computeCost('claude-haiku-custom', usage(1_000_000));
    assert.equal(cost, 0.8);
  });

  // -- Unknown / edge cases --

  it('returns 0 for unknown model', () => {
    assert.equal(computeCost('totally-unknown-model', usage(1_000_000, 1_000_000)), 0);
  });

  it('empty model string matches first entry via startsWith (quirk)', () => {
    // ''.startsWith('') is true for every key, so it matches the first entry
    // This documents actual behavior — not necessarily ideal, but harmless
    const cost = computeCost('', usage(1_000_000));
    assert.ok(cost > 0, 'empty string matches something via prefix');
  });

  it('returns 0 for zero usage', () => {
    assert.equal(computeCost('claude-opus-4-6', usage()), 0);
  });

  it('handles realistic usage numbers', () => {
    // Typical conversation: ~50k input, ~2k output, ~40k cache read
    const cost = computeCost('claude-opus-4-6', usage(50_000, 2_000, 40_000, 0));
    const expected = (50_000 * 15 + 2_000 * 75 + 40_000 * 1.5) / 1_000_000;
    assert.equal(cost, expected);
  });
});
