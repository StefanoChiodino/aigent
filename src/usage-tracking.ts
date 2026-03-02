/**
 * Persistent lifetime usage tracking — load, save, and format
 * cumulative token usage across sessions.
 *
 * Extracted from server.ts to keep it focused on orchestration.
 */

import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage, ModelUsage } from './protocol.js';

export interface LifetimeUsage {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  sessions: number;
  firstUsed: string;
  lastUsed: string;
  /** Cumulative usage broken down by model ID. */
  byModel?: Record<string, import('./protocol.js').ModelUsage>;
}

/** One record per session, appended to usage-log.ndjson for time-series reporting. */
export interface SessionUsageRecord {
  /** ISO timestamp of session start. */
  startedAt: string;
  /** ISO timestamp of session end (when saveLifetimeUsage was called). */
  endedAt: string;
  /** Tokens used this session. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Estimated cost in USD. */
  cost: number;
  /** Per-model breakdown. */
  byModel: Record<string, ModelUsage>;
}

export function getUsagePath(workspacePath: string): string {
  return join(workspacePath, 'usage.json');
}

export function getUsageLogPath(workspacePath: string): string {
  return join(workspacePath, 'usage-log.ndjson');
}

export function loadLifetimeUsage(workspacePath: string): LifetimeUsage {
  try {
    const raw = readFileSync(getUsagePath(workspacePath), 'utf-8');
    return JSON.parse(raw) as LifetimeUsage;
  } catch {
    return {
      totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0, totalCost: 0,
      sessions: 0, firstUsed: new Date().toISOString(), lastUsed: new Date().toISOString(),
    };
  }
}

export function saveLifetimeUsage(workspacePath: string, sessionUsage: TokenUsage, sessionStartedAt?: string): void {
  const lifetime = loadLifetimeUsage(workspacePath);
  lifetime.totalInput += sessionUsage.input;
  lifetime.totalOutput += sessionUsage.output;
  lifetime.totalCacheRead += sessionUsage.cacheRead;
  lifetime.totalCacheWrite += sessionUsage.cacheWrite;
  lifetime.totalCost = (lifetime.totalCost ?? 0) + (sessionUsage.cost ?? 0);
  lifetime.sessions++;
  lifetime.lastUsed = new Date().toISOString();

  // Merge per-model breakdown
  if (sessionUsage.byModel) {
    lifetime.byModel ??= {};
    for (const [modelId, m] of Object.entries(sessionUsage.byModel)) {
      const existing = lifetime.byModel[modelId] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      lifetime.byModel[modelId] = {
        input: existing.input + m.input,
        output: existing.output + m.output,
        cacheRead: existing.cacheRead + m.cacheRead,
        cacheWrite: existing.cacheWrite + m.cacheWrite,
        cost: existing.cost + m.cost,
      };
    }
  }

  try {
    writeFileSync(getUsagePath(workspacePath), JSON.stringify(lifetime, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-critical
  }

  // Append one record to the time-series log (only if there was actual usage)
  if (sessionUsage.input > 0 || sessionUsage.output > 0) {
    const record: SessionUsageRecord = {
      startedAt: sessionStartedAt ?? lifetime.lastUsed,
      endedAt: new Date().toISOString(),
      input: sessionUsage.input,
      output: sessionUsage.output,
      cacheRead: sessionUsage.cacheRead,
      cacheWrite: sessionUsage.cacheWrite,
      cost: sessionUsage.cost ?? 0,
      byModel: sessionUsage.byModel ?? {},
    };
    try {
      appendFileSync(getUsageLogPath(workspacePath), JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // Non-critical
    }
  }
}

export function formatLifetimeUsage(workspacePath: string, sessionUsage: TokenUsage): string {
  const lt = loadLifetimeUsage(workspacePath);
  const total = lt.totalInput + lt.totalOutput;
  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
  };
  const fmtCost = (c: number): string =>
    c === 0 ? 'n/a' : c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`;

  const sessionTotal = sessionUsage.input + sessionUsage.output;
  const sessionCost = sessionUsage.cost ?? 0;
  const lifetimeCost = (lt.totalCost ?? 0) + sessionCost;

  const lines = [
    `This session:  ${fmt(sessionTotal)} tokens (${fmt(sessionUsage.input)} in, ${fmt(sessionUsage.output)} out)  ${fmtCost(sessionCost)}`,
    `Lifetime:      ${fmt(total + sessionTotal)} tokens across ${lt.sessions + 1} session(s)  ${fmtCost(lifetimeCost)}`,
    `  Input:       ${fmt(lt.totalInput + sessionUsage.input)}`,
    `  Output:      ${fmt(lt.totalOutput + sessionUsage.output)}`,
    `  Cache read:  ${fmt(lt.totalCacheRead + sessionUsage.cacheRead)}`,
    `  Cache write: ${fmt(lt.totalCacheWrite + sessionUsage.cacheWrite)}`,
    `First used:    ${lt.firstUsed.slice(0, 10)}`,
  ];

  // Per-model breakdown for this session
  if (sessionUsage.byModel && Object.keys(sessionUsage.byModel).length > 1) {
    lines.push('', 'This session by model:');
    for (const [id, m] of Object.entries(sessionUsage.byModel).sort((a, b) => b[1].cost - a[1].cost)) {
      const tok = m.input + m.output;
      lines.push(`  ${id.padEnd(40)} ${fmt(tok).padStart(6)} tok  ${fmtCost(m.cost)}`);
    }
  }

  return lines.join('\n');
}
