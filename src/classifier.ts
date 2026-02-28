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
import { createClient } from './auth.js';
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
const MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are a security classifier for an AI coding agent. Your job is to evaluate shell commands the agent wants to run.

Evaluate the raw command below. You may also receive recent conversation context showing what the user and agent were discussing — use it to understand WHY the command is being run, but still judge the command on its own merits.

Respond with ONLY a JSON object: {"action":"allow"|"block"|"ask","reason":"..."}

Guidelines:
- "allow": Safe development commands — builds, tests, linters, file reads, git operations, package installs from known registries, text processing
- "block": Commands that could damage the system, exfiltrate data, or access sensitive resources
- "ask": Ambiguous commands that need human judgment — unusual network access, unfamiliar tools, commands that could be legitimate or malicious

Be practical: developers run many commands. Err toward "allow" for standard dev workflows. Err toward "ask" (not "block") when uncertain.

When you classify a command as "allow" or "ask", also suggest 1-3 glob patterns for an always-allow list. These patterns let the user auto-approve similar commands in the future.

Pattern rules:
- Use "*" as a wildcard (matches anything including paths and spaces)
- For simple commands: suggest "<executable> *" (e.g. "wc *", "cat *")
- For pipelines (cmd1 && cmd2): suggest a pattern for each safe segment (e.g. "cd *", "wc *")
- NEVER suggest patterns for destructive commands (rm, mv, chmod, kill, sudo, etc.)
- NEVER suggest overly broad patterns (e.g. just "*")

Include them as: {"action":"...","reason":"...","suggested_patterns":["pattern1","pattern2"]}
The suggested_patterns field is optional — omit it if no safe patterns apply.`;

let anthropicClient: Anthropic | null = null;
const cache = new Map<string, CacheEntry>();

export function initClassifier(apiKey: string): void {
  const { client } = createClient(apiKey);
  anthropicClient = client;
}

export function isClassifierAvailable(): boolean {
  return anthropicClient !== null;
}

/** Test-only: inject a fake client and clear all caches. */
export function _resetForTest(fakeClient?: Anthropic | null): void {
  anthropicClient = fakeClient ?? null;
  cache.clear();
  fileAccessCache.clear();
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

  if (!anthropicClient) {
    return { action: 'ask', reason: 'Classifier not initialized' };
  }

  try {
    let userMessage = context?.cwd
      ? `Working directory: ${context.cwd}\nCommand: ${command}`
      : `Command: ${command}`;
    if (context?.recentContext) {
      userMessage += `\n\nRecent conversation context:\n${context.recentContext}`;
    }

    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 256,
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

  if (!anthropicClient) {
    return { action: 'ask', reason: 'Classifier not initialized' };
  }

  try {
    let userMessage = `Operation: ${operation}\nPath: ${path}`;
    if (context?.cwd) userMessage += `\nWorking directory: ${context.cwd}`;
    if (context?.recentContext) {
      userMessage += `\n\nRecent conversation context:\n${context.recentContext}`;
    }

    const response = await anthropicClient.messages.create({
      model: MODEL,
      max_tokens: 256,
      system: FILE_ACCESS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

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
