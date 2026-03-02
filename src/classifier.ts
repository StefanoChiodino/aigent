/**
 * Tier 3 — cheap-model command classifier.
 *
 * For commands that pass Tier 1 (static deny) and Tier 2 (static allow/deny)
 * without a verdict, this cheap LLM call classifies intent.
 *
 * - Model: AIGENT_CHEAP_MODEL env var (falls back to AIGENT_MODEL)
 * - Uses OpenAI-compatible API (works with Anthropic, OpenRouter, Ollama, etc.)
 * - LRU cache: 200 entries, 30-min TTL
 * - Fails open to { action: 'ask' } on any error
 */

import OpenAI from 'openai';
import { createLogger } from './logger.js';

const log = createLogger('classifier');

export interface ClassifierResult {
  action: 'allow' | 'block' | 'ask';
  reason: string;
  suggestedPatterns?: string[];
}

interface CacheEntry {
  result: ClassifierResult;
  ts: number;
}

const CACHE_MAX = 200;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getModel(): string {
  return process.env['AIGENT_CHEAP_MODEL'] ?? process.env['AIGENT_MODEL'] ?? '';
}

const SYSTEM_PROMPT = `You are a security classifier for an AI coding agent. Evaluate the shell command below.

Respond with ONLY a JSON object: {"action":"allow"|"block"|"ask","reason":"one sentence"}

## Decision rules

**"allow"** — the DEFAULT for standard development work:
- File reads, searches, text processing (cat, grep, sed, awk, jq, sort, wc, diff, etc.)
- HTTP fetches to any public URL (curl, wget, httpie) — downloading content is safe
- curl/wget piped to text processors (python, jq, grep, etc.) — this is standard dev
- Python/Node scripts for data processing, testing, text manipulation
- Build tools, linters, test runners, package managers
- Git operations (including writes like commit, push)
- System info commands (ps, top, df, du, uptime, etc.)
- Any combination of the above in a pipeline

**"block"** — ONLY for clearly malicious patterns:
- curl/wget piped directly to bash/sh (already caught by Tier 1, but defense-in-depth)
- Commands that explicitly target credential files (~/.ssh, ~/.aws, ~/.gnupg)
- Fork bombs, disk wiping (dd of=/dev/), rm -rf /

**"ask"** — ONLY when you genuinely cannot determine safety:
- Unknown/unfamiliar binaries with no clear dev purpose
- Commands that POST sensitive-looking data to external servers (e.g. curl -d "$(cat /etc/passwd)" ...)
- Mass file deletion or permission changes outside a project directory

Be extremely permissive. This classifier is a fallback — Tier 1 already blocks dangerous injection patterns. Most commands reaching you are legitimate dev work. When in doubt, "allow".

When you classify as "allow" or "ask", optionally suggest 1-3 glob patterns:
{"action":"...","reason":"...","suggested_patterns":["pattern1"]}
Rules: "*" matches anything. Suggest "<exe> *" for simple commands. Never suggest just "*". Never suggest patterns for destructive commands.`;

let openaiClient: OpenAI | null = null;
const cache = new Map<string, CacheEntry>();

export function initClassifier(apiKey: string, baseURL?: string): void {
  openaiClient = new OpenAI({
    apiKey: apiKey || 'not-needed',
    baseURL: baseURL ?? undefined,
  });
}

export function isClassifierAvailable(): boolean {
  return openaiClient !== null;
}

/** Test-only: inject a fake client and clear all caches. */
export function _resetForTest(fakeClient?: OpenAI | null): void {
  openaiClient = fakeClient ?? null;
  cache.clear();
  fileAccessCache.clear();
}

/** Test-only: backdating a cache entry's timestamp so TTL expiration can be tested. */
export function _backdateCacheEntryForTest(command: string, cwd?: string, ageMs = CACHE_TTL_MS + 1): void {
  const key = cacheKey(command, cwd);
  const entry = cache.get(key);
  if (entry) {
    entry.ts = Date.now() - ageMs;
  }
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
  context?: { cwd?: string; project?: string; recentContext?: string },
): Promise<ClassifierResult> {
  // Check cache first
  const key = cacheKey(command, context?.cwd);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  if (!openaiClient) {
    return { action: 'ask', reason: 'Classifier not initialized' };
  }

  try {
    let userMessage = context?.cwd
      ? `Working directory: ${context.cwd}\nCommand: ${command}`
      : `Command: ${command}`;
    if (context?.recentContext) {
      userMessage += `\n\nRecent conversation context:\n${context.recentContext}`;
    }

    const response = await openaiClient.chat.completions.create({
      model: getModel(),
      max_tokens: 256,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';

    const result = parseClassifierResponse(text);

    // Cache the result
    cache.set(key, { result, ts: Date.now() });
    pruneCache();

    return result;
  } catch (err) {
    // Fail open — let the user decide
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Classifier API error', { error: msg, command });
    return { action: 'ask', reason: 'Classifier unavailable — please review manually' };
  }
}

// --- File access classifier ---

const FILE_ACCESS_SYSTEM_PROMPT = `You are a security classifier for an AI coding agent. Your job is to evaluate file access requests the agent makes.

Evaluate the file path and operation below. You may also receive recent conversation context — use it to understand WHY the access is requested, but still judge the path on its own merits.

Respond with ONLY a JSON object: {"action":"allow"|"block"|"ask","reason":"..."}

Guidelines:
- "allow": Source code, config files, docs, project files, temp files, package manifests, build outputs, log files
- "block": Credential files (private keys, tokens, passwords), sensitive dot-directories (~/.ssh, ~/.gnupg, ~/.aws), database files with credentials
- "ask": Ambiguous — home directory files outside the project, system configs (/etc), unfamiliar paths

For reads: err toward "allow" — reading files is rarely dangerous.
For writes: be more cautious — err toward "ask" when uncertain.

When you classify as "allow" or "ask", also suggest 1-2 glob patterns for an auto-allow list.
Pattern rules:
- Use "**" to match directory trees (e.g. "~/project/**")
- Use "*" to match filenames (e.g. "/tmp/*")
- "~" expands to the user's home directory
- NEVER suggest patterns for credential paths
- NEVER suggest overly broad patterns (e.g. just "*" or "~/**")

Include them as: {"action":"...","reason":"...","suggested_patterns":["pattern1"]}
The suggested_patterns field is optional — omit it if no safe patterns apply.`;

const fileAccessCache = new Map<string, CacheEntry>();

function fileAccessCacheKey(path: string, operation: string): string {
  return `file::${operation}::${path}`;
}

function pruneFileAccessCache(): void {
  if (fileAccessCache.size <= CACHE_MAX) return;
  const entries = [...fileAccessCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  const toRemove = entries.slice(0, entries.length - CACHE_MAX);
  for (const [key] of toRemove) fileAccessCache.delete(key);
}

export async function classifyFileAccess(
  path: string,
  operation: 'read' | 'write',
  context?: { cwd?: string; recentContext?: string },
): Promise<ClassifierResult> {
  const key = fileAccessCacheKey(path, operation);
  const cached = fileAccessCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  if (!openaiClient) {
    return { action: 'ask', reason: 'Classifier not initialized' };
  }

  try {
    let userMessage = `Operation: ${operation}\nPath: ${path}`;
    if (context?.cwd) userMessage += `\nWorking directory: ${context.cwd}`;
    if (context?.recentContext) {
      userMessage += `\n\nRecent conversation context:\n${context.recentContext}`;
    }

    const response = await openaiClient.chat.completions.create({
      model: getModel(),
      max_tokens: 256,
      messages: [
        { role: 'system', content: FILE_ACCESS_SYSTEM_PROMPT },
        { role: 'user', content: userMessage },
      ],
    });

    const text = response.choices[0]?.message?.content ?? '';

    const result = parseClassifierResponse(text);
    fileAccessCache.set(key, { result, ts: Date.now() });
    pruneFileAccessCache();
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('File access classifier API error', { error: msg, path, operation });
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
    const parsed = JSON.parse(match[0]) as {
      action?: string;
      reason?: string;
      suggested_patterns?: string[];
    };
    const action = parsed.action;
    if (action !== 'allow' && action !== 'block' && action !== 'ask') {
      return { action: 'ask', reason: parsed.reason ?? 'Unknown classifier action' };
    }
    const result: ClassifierResult = { action, reason: parsed.reason ?? '' };
    // Only attach patterns for non-block actions
    if (action !== 'block' && Array.isArray(parsed.suggested_patterns)) {
      const filtered = parsed.suggested_patterns.filter(
        (p): p is string => typeof p === 'string' && p.length > 0 && p !== '*',
      );
      if (filtered.length > 0) result.suggestedPatterns = filtered;
    }
    return result;
  } catch {
    return { action: 'ask', reason: 'Could not parse classifier response' };
  }
}
