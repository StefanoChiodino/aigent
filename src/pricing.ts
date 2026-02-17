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

// Prices as of early 2026 — update as needed
const PRICING: Record<string, ModelPricing> = {
  // Anthropic — cache read = 10% of input, cache write = 125% of input
  'claude-opus-4-6-20250514': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-20250514': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-3.5-20241022': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  'o1': { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 15 },
  'o3-mini': { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
};

// Map common model family names to their full keys
const FAMILY_MAP: [string, string][] = [
  ['opus', 'claude-opus-4-6-20250514'],
  ['sonnet', 'claude-sonnet-4-20250514'],
  ['haiku', 'claude-haiku-3.5-20241022'],
  ['gpt-4o-mini', 'gpt-4o-mini'],
  ['gpt-4o', 'gpt-4o'],
  ['o3-mini', 'o3-mini'],
  ['o1', 'o1'],
];

/**
 * Find pricing for a model. Tries exact match, then prefix/contains match.
 */
function findPricing(model: string): ModelPricing | null {
  // Exact match
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

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Compute cost in USD from token usage and model.
 * Returns 0 if pricing is unknown.
 */
export function computeCost(model: string, usage: TokenUsage): number {
  const pricing = findPricing(model);
  if (!pricing) return 0;

  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) /
    1_000_000
  );
}
