/**
 * Episode logging — structured records of task outcomes.
 *
 * Phase 1 of the continuous learning system. Episodes capture what was attempted,
 * whether it succeeded, what went wrong, and what was learned. The data feeds
 * future phases: reflection agent, self-play benchmarks, semantic retrieval.
 *
 * Storage: NDJSON (one JSON object per line) at workspace/episodes.ndjson.
 * Pattern: fire-and-forget writes (appendFileSync), same as audit.ts.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rotateIfNeeded } from './log-rotate.js';
import type { TokenUsage, DisplayMessage } from './protocol.js';
import { computeCost } from './pricing.js';

// ---------------------------------------------------------------------------
// Episode interface
// ---------------------------------------------------------------------------

export interface EpisodeCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUSD: number;
}

export interface Episode {
  /** Unique identifier: ISO timestamp + 6-char random suffix */
  id: string;
  /** When the episode started (ISO 8601) */
  startedAt: string;
  /** When the episode ended (ISO 8601) */
  endedAt: string;
  /** Freeform domain tag — e.g. "debugging", "writing", "agent-dev" */
  domain: string;
  /** Short description of what was attempted */
  task: string;
  /** How the task ended */
  outcome: 'completed' | 'partial' | 'abandoned' | 'failed';
  /** What was hard, what went wrong, what the user corrected */
  friction: string | null;
  /** Extracted insights reusable across future tasks */
  lessons: string[];
  /** Freeform tags for retrieval */
  tags: string[];
  /** Optional 1–5 score from the user */
  userRating: number | null;
  /** Deduplicated tool names used during the episode */
  toolsUsed: string[];
  /** Number of user messages (turns) */
  turns: number;
  /** Primary model used */
  model: string;
  /** Token usage and estimated cost */
  cost: EpisodeCost;
  /** How this episode was recorded */
  source: 'agent' | 'auto-reset' | 'auto-shutdown' | 'auto-compact';
  /** Profile name (for multi-profile support) */
  profile: string;
  /** Session ID for correlation */
  sessionId: string;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const EPISODES_FILE = 'episodes.ndjson';
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB rotation threshold

export function getEpisodesPath(workspacePath: string): string {
  return join(workspacePath, EPISODES_FILE);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateEpisodeId(): string {
  const ts = new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}_${rand}`;
}

// ---------------------------------------------------------------------------
// Append (fire-and-forget)
// ---------------------------------------------------------------------------

export function appendEpisode(workspacePath: string, episode: Episode): void {
  try {
    const dir = workspacePath;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(getEpisodesPath(workspacePath), JSON.stringify(episode) + '\n', 'utf-8');
  } catch {
    // Fire-and-forget — never block the main flow
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface EpisodeQuery {
  domain?: string | undefined;
  outcome?: Episode['outcome'] | undefined;
  tags?: string[] | undefined;       // match ANY of these tags
  since?: string | undefined;        // ISO date or YYYY-MM-DD
  until?: string | undefined;        // ISO date or YYYY-MM-DD
  source?: Episode['source'] | undefined;  // 'agent' | 'auto-reset' | 'auto-shutdown' | 'auto-compact'
  limit?: number | undefined;        // max results (default 50, cap 200)
}

export function queryEpisodes(workspacePath: string, query: EpisodeQuery): Episode[] {
  const path = getEpisodesPath(workspacePath);
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.trim().split('\n').filter(Boolean);
  const episodes: Episode[] = [];
  const limit = Math.min(query.limit ?? 50, 200);

  for (const line of lines) {
    let ep: Episode;
    try {
      ep = JSON.parse(line) as Episode;
    } catch {
      continue; // skip malformed lines
    }

    if (query.domain && ep.domain !== query.domain) continue;
    if (query.outcome && ep.outcome !== query.outcome) continue;
    if (query.source && ep.source !== query.source) continue;
    if (query.since && ep.endedAt < query.since) continue;
    if (query.until && ep.endedAt > query.until) continue;
    if (query.tags && query.tags.length > 0) {
      if (!query.tags.some(t => ep.tags.includes(t))) continue;
    }

    episodes.push(ep);
  }

  // Most recent first, capped at limit
  return episodes.reverse().slice(0, limit);
}

// ---------------------------------------------------------------------------
// Auto-logging from session context
// ---------------------------------------------------------------------------

export interface AutoEpisodeContext {
  messages: DisplayMessage[];
  usage: TokenUsage;
  model: string;
  profile: string;
  sessionId: string;
  workspacePath: string;
  toolsUsed?: string[] | undefined;
  sessionStartedAt?: string | undefined;
  source: 'auto-reset' | 'auto-shutdown' | 'auto-compact';
  /** Per-message ratings from the UI (messageTimestamp → 1-5) */
  ratings?: Record<string, number> | undefined;
  /** Automated friction signals (tool failures, errors) */
  frictionSignals?: string[] | undefined;
}

/**
 * Generate a minimal episode record from session context.
 * Called at reset/shutdown when the agent didn't explicitly log.
 * Skips trivially short sessions (< 2 user messages).
 */
export function autoLogEpisode(ctx: AutoEpisodeContext): void {
  const userMessages = ctx.messages.filter(m => m.role === 'user');

  // Don't log trivially short sessions
  if (userMessages.length < 2) return;

  const firstUserMsg = userMessages[0]?.content ?? '';
  const task = firstUserMsg.slice(0, 200).replace(/\n/g, ' ').trim() || 'Unknown task';
  const domain = inferDomain(firstUserMsg);
  const startedAt = ctx.sessionStartedAt ?? ctx.messages[0]?.timestamp ?? new Date().toISOString();
  const endedAt = ctx.messages[ctx.messages.length - 1]?.timestamp ?? new Date().toISOString();
  const toolsUsed = ctx.toolsUsed ? [...new Set(ctx.toolsUsed)] : [];

  // Compute average rating from per-message UI ratings
  const ratingValues = Object.values(ctx.ratings ?? {});
  const avgRating = ratingValues.length > 0
    ? Math.round(ratingValues.reduce((a, b) => a + b, 0) / ratingValues.length)
    : null;

  // Combine automated friction signals into a string
  const friction = ctx.frictionSignals && ctx.frictionSignals.length > 0
    ? ctx.frictionSignals.join('; ')
    : null;

  const episode: Episode = {
    id: generateEpisodeId(),
    startedAt,
    endedAt,
    domain,
    task,
    outcome: 'completed',
    friction,
    lessons: [],
    tags: [],
    userRating: avgRating,
    toolsUsed,
    turns: userMessages.length,
    model: ctx.model,
    cost: {
      inputTokens: ctx.usage.input,
      outputTokens: ctx.usage.output,
      cacheReadTokens: ctx.usage.cacheRead,
      cacheWriteTokens: ctx.usage.cacheWrite,
      estimatedUSD: ctx.usage.cost ?? computeCost(ctx.model, ctx.usage),
    },
    source: ctx.source,
    profile: ctx.profile,
    sessionId: ctx.sessionId,
  };

  appendEpisode(ctx.workspacePath, episode);
}

// ---------------------------------------------------------------------------
// Domain inference (simple keyword heuristics)
// ---------------------------------------------------------------------------

const DOMAIN_KEYWORDS: [string, string[]][] = [
  ['debugging', ['bug', 'fix', 'error', 'broken', 'crash', 'debug', 'issue', 'failing', 'stacktrace']],
  ['agent-dev', ['agent', 'tool', 'server.ts', 'gatekeeper', 'provider', 'aigent', 'episode', 'self-mod']],
  ['web-ui', ['css', 'html', 'component', 'ui', 'layout', 'style', 'frontend', 'vite', 'sidebar', 'modal']],
  ['writing', ['write', 'draft', 'chapter', 'book', 'essay', 'article', 'blog', 'story', 'document']],
  ['code-review', ['review', 'refactor', 'clean up', 'improve', 'optimize', 'audit']],
  ['testing', ['test', 'spec', 'assertion', 'coverage', 'playwright', 'vitest']],
  ['devops', ['deploy', 'docker', 'ci', 'pipeline', 'build', 'make', 'infrastructure']],
  ['research', ['research', 'explore', 'investigate', 'compare', 'evaluate', 'analyze']],
];

export function inferDomain(text: string): string {
  const lower = text.toLowerCase();
  for (const [domain, keywords] of DOMAIN_KEYWORDS) {
    if (keywords.some(k => lower.includes(k))) return domain;
  }
  return 'general';
}

// ---------------------------------------------------------------------------
// Session tracking (prevent duplicate auto-logs)
// ---------------------------------------------------------------------------

let lastLoggedSessionId: string | null = null;

export function markSessionLogged(sessionId: string): void {
  lastLoggedSessionId = sessionId;
}

export function wasSessionLogged(sessionId: string): boolean {
  return lastLoggedSessionId === sessionId;
}

/** Reset for tests only. */
export function _resetForTest(): void {
  lastLoggedSessionId = null;
}

// ---------------------------------------------------------------------------
// Rotation (called at startup)
// ---------------------------------------------------------------------------

export function rotateEpisodesIfNeeded(workspacePath: string): void {
  try {
    rotateIfNeeded(getEpisodesPath(workspacePath), MAX_BYTES, 2);
  } catch {
    // Non-critical
  }
}
