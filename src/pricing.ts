/**
 * Model pricing for cost estimation.
 * Prices in USD per million tokens.
 */

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Live pricing injected at runtime from the provider's model list API. */
const LIVE_PRICING = new Map<string, ModelPricing>();

/**
 * Register pricing for a model reported by the provider API.
 * Takes precedence over the static table below.
 */
export function registerModelPricing(id: string, pricing: ModelPricing): void {
  LIVE_PRICING.set(id, pricing);
}

// Static fallback pricing for providers that don't return pricing in their model list API
// (direct Anthropic, direct OpenAI). For everything else (OpenRouter, etc.) live prices
// from registerModelPricing() take precedence and these are never consulted.
// Prices in USD per million tokens, as of early 2026.
const PRICING: Record<string, ModelPricing> = {
  // Anthropic — cache read = 10% of input, cache write = 125% of input
  'claude-opus-4-6':  { input: 15,   output: 75,  cacheRead: 1.5,   cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3,   output: 15,  cacheRead: 0.3,   cacheWrite: 3.75  },
  'claude-haiku-4-5': { input: 0.8,  output: 4,   cacheRead: 0.08,  cacheWrite: 1     },
  'claude-haiku-3.5': { input: 0.8,  output: 4,   cacheRead: 0.08,  cacheWrite: 1     },
  // OpenAI
  'gpt-4o':      { input: 2.5,  output: 10,  cacheRead: 1.25,  cacheWrite: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 },
  'gpt-4.1':     { input: 2,    output: 8,   cacheRead: 0.5,   cacheWrite: 0 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1,   cacheWrite: 0 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
  'o1':      { input: 15,  output: 60,  cacheRead: 7.5,  cacheWrite: 0 },
  'o1-mini': { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
  'o3':      { input: 10,  output: 40,  cacheRead: 2.5,  cacheWrite: 0 },
  'o3-mini': { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 0 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
};

// Substring patterns for fuzzy fallback matching when no exact/live price is found.
// Only needed for direct-provider calls that return no pricing in their model list.
// Checked in order — more specific patterns must come before broader ones.
const FAMILY_MAP: [string, string][] = [
  ['claude-opus-4',   'claude-opus-4-6'],
  ['claude-sonnet-4', 'claude-sonnet-4-6'],
  ['claude-haiku-4',  'claude-haiku-4-5'],
  ['claude-haiku-3',  'claude-haiku-3.5'],
  ['opus',   'claude-opus-4-6'],
  ['sonnet', 'claude-sonnet-4-6'],
  ['haiku',  'claude-haiku-4-5'],
  ['gpt-4o-mini', 'gpt-4o-mini'],
  ['gpt-4o',      'gpt-4o'],
  ['gpt-4.1-mini', 'gpt-4.1-mini'],
  ['gpt-4.1-nano', 'gpt-4.1-nano'],
  ['gpt-4.1',      'gpt-4.1'],
  ['o4-mini', 'o4-mini'],
  ['o3-mini', 'o3-mini'],
  ['o3',      'o3'],
  ['o1-mini', 'o1-mini'],
  ['o1',      'o1'],
];

/**
 * Find pricing for a model. Checks live provider prices first, then static table.
 */
function findPricing(model: string): ModelPricing | null {
  // Live prices from provider API take precedence
  if (LIVE_PRICING.has(model)) return LIVE_PRICING.get(model)!;

  // Exact match in static table
  if (PRICING[model]) return PRICING[model]!;

  // Prefix match (e.g. "claude-opus-4-6" matches full key)
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (key.startsWith(model) || model.startsWith(key)) return pricing;
  }

  // Family match
  const lower = model.toLowerCase();
  for (const [family, key] of FAMILY_MAP) {
    if (lower.includes(family)) return PRICING[key]!;
  }

  return null;
}

import type { TokenUsage } from './protocol.js';

/**
 * Compute cost in USD from token usage and model.
 * Returns 0 if pricing is unknown.
 */
export function computeCost(model: string, usage: TokenUsage): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;

  // Reasoning tokens are billed at the output rate on all providers that report them
  // (o1/o3: included in completion_tokens; DeepSeek-R1, Gemini thinking: separate field)
  const outputTokens = usage.output + (usage.reasoning ?? 0);

  return (
    (usage.input * pricing.input +
      outputTokens * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) /
    1_000_000
  );
}
