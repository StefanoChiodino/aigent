/**
 * Tier 3 — Haiku command classifier.
 *
 * For commands that pass Tier 1 (static deny) and Tier 2 (static allow/deny)
 * without a verdict, this cheap LLM call classifies intent.
 *
 * - Model: claude-haiku-4-5-20251001 (~200ms, ~$0.001/call)
 * - LRU cache: 200 entries, 5-min TTL
 * - Fails open to { action: 'ask' } on any error
 */

import Anthropic from '@anthropic-ai/sdk';

export interface ClassifierResult {
  action: 'allow' | 'block' | 'ask';
  reason: string;
}

interface CacheEntry {
  result: ClassifierResult;
  ts: number;
}

const CACHE_MAX = 200;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are a security classifier for an AI coding agent. Your job is to evaluate shell commands the agent wants to run.

Evaluate the raw command below. Do NOT consider any explanation the agent may have given — judge the command itself.

Respond with ONLY a JSON object: {"action":"allow"|"block"|"ask","reason":"..."}

Guidelines:
- "allow": Safe development commands — builds, tests, linters, file reads, git operations, package installs from known registries, text processing
- "block": Commands that could damage the system, exfiltrate data, or access sensitive resources
- "ask": Ambiguous commands that need human judgment — unusual network access, unfamiliar tools, commands that could be legitimate or malicious

Be practical: developers run many commands. Err toward "allow" for standard dev workflows. Err toward "ask" (not "block") when uncertain.`;

let anthropicClient: Anthropic | null = null;
const cache = new Map<string, CacheEntry>();

export function initClassifier(apiKey: string): void {
  anthropicClient = new Anthropic({ apiKey });
}

export function isClassifierAvailable(): boolean {
  return anthropicClient !== null;
}

/** Test-only: inject a fake client and clear cache. */
export function _resetForTest(fakeClient?: Anthropic | null): void {
  anthropicClient = fakeClient ?? null;
  cache.clear();
}

function cacheKey(command: string, cwd?: string): string {
  return `${cwd ?? '.'}::${command}`;
}

function pruneCache(): void {
  if (cache.size <= CACHE_MAX) return;
  // Evict oldest entries
  const entries = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toRemove = entries.slice(0, entries.length - CACHE_MAX);
  for (const [key] of toRemove) cache.delete(key);
}

export async function classifyCommand(
  command: string,
  context?: { cwd?: string; project?: string },
): Promise<ClassifierResult> {
  // Check cache first
  const key = cacheKey(command, context?.cwd);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  if (!anthropicClient) {
    return { action: 'ask', reason: 'Classifier not initialized' };
  }

  try {
    const userMessage = context?.cwd
      ? `Working directory: ${context.cwd}\nCommand: ${command}`
      : `Command: ${command}`;

    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const result = parseClassifierResponse(text);

    // Cache the result
    cache.set(key, { result, ts: Date.now() });
    pruneCache();

    return result;
  } catch {
    // Fail open — let the user decide
    return { action: 'ask', reason: 'Classifier unavailable — please review manually' };
  }
}

/** Exported for testing. */
export function parseClassifierResponse(text: string): ClassifierResult {
  try {
    // Extract JSON from response (may have surrounding text)
    const match = text.match(/\{[^}]*"action"\s*:\s*"[^"]*"[^}]*\}/);
    if (!match) {
      return { action: 'ask', reason: 'Could not parse classifier response' };
    }
    const parsed = JSON.parse(match[0]) as { action?: string; reason?: string };
    const action = parsed.action;
    if (action !== 'allow' && action !== 'block' && action !== 'ask') {
      return { action: 'ask', reason: parsed.reason ?? 'Unknown classifier action' };
    }
    return { action, reason: parsed.reason ?? '' };
  } catch {
    return { action: 'ask', reason: 'Could not parse classifier response' };
  }
}
