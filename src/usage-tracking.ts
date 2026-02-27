/**
 * Persistent lifetime usage tracking — load, save, and format
 * cumulative token usage across sessions.
 *
 * Extracted from server.ts to keep it focused on orchestration.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from './protocol.js';

export interface LifetimeUsage {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  sessions: number;
  firstUsed: string;
  lastUsed: string;
}

export function getUsagePath(workspacePath: string): string {
  return join(workspacePath, 'usage.json');
}

export function loadLifetimeUsage(workspacePath: string): LifetimeUsage {
  try {
    const raw = readFileSync(getUsagePath(workspacePath), 'utf-8');
    return JSON.parse(raw) as LifetimeUsage;
  } catch {
    return {
      totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
      sessions: 0, firstUsed: new Date().toISOString(), lastUsed: new Date().toISOString(),
    };
  }
}

export function saveLifetimeUsage(workspacePath: string, sessionUsage: TokenUsage): void {
  const lifetime = loadLifetimeUsage(workspacePath);
  lifetime.totalInput += sessionUsage.input;
  lifetime.totalOutput += sessionUsage.output;
  lifetime.totalCacheRead += sessionUsage.cacheRead;
  lifetime.totalCacheWrite += sessionUsage.cacheWrite;
  lifetime.sessions++;
  lifetime.lastUsed = new Date().toISOString();
  try {
    writeFileSync(getUsagePath(workspacePath), JSON.stringify(lifetime, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-critical
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

  const sessionTotal = sessionUsage.input + sessionUsage.output;
  const lines = [
    `This session:  ${fmt(sessionTotal)} tokens (${fmt(sessionUsage.input)} in, ${fmt(sessionUsage.output)} out)`,
    `Lifetime:      ${fmt(total + sessionTotal)} tokens across ${lt.sessions + 1} session(s)`,
    `  Input:       ${fmt(lt.totalInput + sessionUsage.input)}`,
    `  Output:      ${fmt(lt.totalOutput + sessionUsage.output)}`,
    `  Cache read:  ${fmt(lt.totalCacheRead + sessionUsage.cacheRead)}`,
    `  Cache write: ${fmt(lt.totalCacheWrite + sessionUsage.cacheWrite)}`,
    `First used:    ${lt.firstUsed.slice(0, 10)}`,
  ];
  return lines.join('\n');
}
