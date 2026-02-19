import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('workspace');

/**
 * Config files — instruction files that define the agent's behaviour.
 * These live in workspace/config/ and are mounted read-only in the sandbox.
 * Edits require gatekeeper approval (diff shown to user).
 */
const CONFIG_FILES = [
  { name: 'AGENTS.md', label: 'Operating Instructions' },
  { name: 'SOUL.md', label: 'Personality' },
  { name: 'IDENTITY.md', label: 'Identity' },
  { name: 'USER.md', label: 'User Profile' },
  { name: 'TOOLS.md', label: 'Tool Notes' },
] as const;

/**
 * Memory files — freely writable by the agent.
 * These live in the workspace root (not in config/).
 */
const MEMORY_FILES = [
  { name: 'MEMORY.md', label: 'Long-Term Memory' },
] as const;

/** Days of full daily logs to include in the system prompt */
const RECENT_DAYS = 3;

/** File content cache — keyed by path, stores content + mtime to avoid re-reading unchanged files. */
const fileCache = new Map<string, { mtime: number; content: string }>();

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Read a file only if its mtime changed since last read. Returns cached content otherwise. */
function readCached(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const mtime = statSync(path).mtimeMs;
    const cached = fileCache.get(path);
    if (cached && cached.mtime === mtime) return cached.content;
    const content = readFileSync(path, 'utf-8');
    fileCache.set(path, { mtime, content });
    return content;
  } catch {
    return null;
  }
}

function getRecentDates(count: number): string[] {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * List all daily memory files, sorted newest first.
 * Returns { date, path, size } for each.
 */
function listDailyMemoryFiles(memoryDir: string): { date: string; path: string; size: number }[] {
  if (!existsSync(memoryDir)) return [];

  return readdirSync(memoryDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .map((f) => {
      const filePath = join(memoryDir, f);
      const size = statSync(filePath).size;
      return { date: f.replace('.md', ''), path: filePath, size };
    });
}

/**
 * Load all workspace files and compose them into a system prompt section.
 * Returns the workspace context string to be appended to the base system prompt.
 *
 * Memory loading strategy:
 * - Last N days of daily logs: included in full
 * - Older logs: listed as an index (date + first line) so the agent knows they exist
 *   and can read them with tools if needed
 */
export function loadWorkspaceContext(workspacePath: string): string {
  const sections: string[] = [];

  // Ensure memory directory exists
  const memoryDir = join(workspacePath, 'memory');
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Load config files (read-only instruction files) — cached by mtime
  // Look in config/ first, fall back to workspace root for backward compat
  const configDir = join(workspacePath, 'config');
  for (const file of CONFIG_FILES) {
    const content =
      readCached(join(configDir, file.name)) ??
      readCached(join(workspacePath, file.name));
    if (content?.trim()) {
      sections.push(`## ${file.label} (config/${file.name}) [read-only]\n\n${content.trim()}`);
    }
  }

  // Load memory files (freely writable) — cached by mtime
  for (const file of MEMORY_FILES) {
    const content = readCached(join(workspacePath, file.name));
    if (content?.trim()) {
      sections.push(`## ${file.label} (${file.name})\n\n${content.trim()}`);
    }
  }

  // Load daily memory files
  const recentDates = new Set(getRecentDates(RECENT_DAYS));
  const allFiles = listDailyMemoryFiles(memoryDir);

  // Recent files: include full content
  const recentFiles = allFiles.filter((f) => recentDates.has(f.date));
  const olderFiles = allFiles.filter((f) => !recentDates.has(f.date));

  for (const file of recentFiles.reverse()) { // oldest first for chronological order
    const content = readIfExists(file.path);
    if (content?.trim()) {
      const isToday = file.date === getRecentDates(1)[0];
      const label = isToday ? `Today's Log (${file.date})` : `Recent Log (${file.date})`;
      sections.push(`## ${label}\n\n${content.trim()}`);
    }
  }

  // Older files: compact index (last 30 days only, truncated previews)
  if (olderFiles.length > 0) {
    const cappedFiles = olderFiles.slice(0, 30); // newest first, cap at 30 days
    const index = cappedFiles.map((f) => {
      const content = readCached(f.path);
      const firstLine = content?.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
      const preview = firstLine.slice(0, 50);
      return `- ${f.date} (${Math.round(f.size / 1024)}KB)${preview ? `: ${preview}` : ''}`;
    });
    const extra = olderFiles.length > 30 ? `\n(${olderFiles.length - 30} older files omitted)` : '';
    sections.push(
      `## Older Memory Files\n\nUse read_file to access. Path: ${memoryDir}/YYYY-MM-DD.md\n\n${index.join('\n')}${extra}`
    );
  }

  log.debug('Workspace context loaded', { sections: sections.length, recentDays: recentFiles.length, olderFiles: olderFiles.length });

  if (sections.length === 0) {
    return '';
  }

  return `\n\n---\n# Workspace Context\n\nThe following files define who you are and what you know.\n\nConfig files (${configDir}/) are read-only in the sandbox. To edit them, use the\nrequest_config_write tool — the user will see a diff and approve or deny.\n\nMemory files (${workspacePath}/) are freely writable — update them as you learn.\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Get the current date string for memory file naming.
 */
export function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
