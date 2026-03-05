import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('workspace');

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

/** Assembled context string cache — avoids re-concatenation when no files changed. */
let contextCache: { fingerprint: string; result: string } | null = null;

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
 *
 * By default, daily session logs are NOT included in the prompt — only an index
 * listing what files exist. The agent can read them on demand via read_file.
 * Set AIGENT_FULL_LOGS=1 to restore the old behaviour of including recent logs in full.
 *
 * Set AIGENT_SLIM_PROMPT=1 to also skip MEMORY.md (useful for small context windows).
 */
export function loadWorkspaceContext(workspacePath: string): string {
  const slimPrompt = process.env['AIGENT_SLIM_PROMPT'] === '1' || process.env['AIGENT_SLIM_PROMPT'] === 'true';
  const fullLogs = process.env['AIGENT_FULL_LOGS'] === '1' || process.env['AIGENT_FULL_LOGS'] === 'true';

  // Build a fingerprint from all source file mtimes to detect changes
  const mtimes: string[] = [];
  const configDir = join(workspacePath, 'config');
  const memoryDir = join(workspacePath, 'memory');
  try {
    if (existsSync(configDir)) {
      for (const f of readdirSync(configDir).filter((f) => f.endsWith('.md')).sort()) {
        const st = statSync(join(configDir, f));
        mtimes.push(`${f}:${st.mtimeMs}`);
      }
    }
    if (!slimPrompt) {
      for (const file of MEMORY_FILES) {
        const p = join(workspacePath, file.name);
        if (existsSync(p)) mtimes.push(`${file.name}:${statSync(p).mtimeMs}`);
      }
    }
    if (existsSync(memoryDir)) {
      for (const f of readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort()) {
        const st = statSync(join(memoryDir, f));
        mtimes.push(`${f}:${st.mtimeMs}`);
      }
    }
  } catch { /* stat errors are non-fatal */ }
  const fingerprint = `${slimPrompt}:${fullLogs}:${mtimes.join(',')}`;
  if (contextCache && contextCache.fingerprint === fingerprint) {
    return contextCache.result;
  }

  const sections: string[] = [];

  // Ensure memory directory exists
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }

  // Load config files (read-only instruction files) — all .md files in config/
  if (existsSync(configDir)) {
    const configFiles = readdirSync(configDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    for (const name of configFiles) {
      const content = readCached(join(configDir, name));
      if (content?.trim()) {
        const label = name.replace(/\.md$/, '').replace(/[-_]/g, ' ');
        sections.push(`## ${label} (config/${name}) [read-only]\n\n${content.trim()}`);
      }
    }
  }

  // Load memory files (freely writable) — skip in slim mode
  if (!slimPrompt) {
    for (const file of MEMORY_FILES) {
      const content = readCached(join(workspacePath, file.name));
      if (content?.trim()) {
        sections.push(`## ${file.label} (${file.name})\n\n${content.trim()}`);
      }
    }
  }

  // Daily memory files
  const allFiles = listDailyMemoryFiles(memoryDir);

  if (fullLogs) {
    // Full mode: include recent logs in full (original behaviour)
    const recentDates = new Set(getRecentDates(RECENT_DAYS));
    const recentFiles = allFiles.filter((f) => recentDates.has(f.date));
    const olderFiles = allFiles.filter((f) => !recentDates.has(f.date));

    for (const file of recentFiles.reverse()) {
      const content = readIfExists(file.path);
      if (content?.trim()) {
        const isToday = file.date === getRecentDates(1)[0];
        const label = isToday ? `Today's Log (${file.date})` : `Recent Log (${file.date})`;
        sections.push(`## ${label}\n\n${content.trim()}`);
      }
    }

    if (olderFiles.length > 0) {
      const cappedFiles = olderFiles.slice(0, 30);
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
  } else {
    // Default: index only — agent reads files on demand
    if (allFiles.length > 0) {
      const cappedFiles = allFiles.slice(0, 30);
      const index = cappedFiles.map((f) => {
        return `- ${f.date} (${Math.round(f.size / 1024)}KB): ${memoryDir}/${f.date}.md`;
      });
      const extra = allFiles.length > 30 ? `\n(${allFiles.length - 30} older files omitted)` : '';
      sections.push(
        `## Session Logs\n\nUse read_file to access any log. Path pattern: ${memoryDir}/YYYY-MM-DD.md\n\n${index.join('\n')}${extra}`
      );
    }
  }

  log.debug('Workspace context loaded', { sections: sections.length, slimPrompt, fullLogs, totalFiles: allFiles.length });

  if (sections.length === 0) {
    contextCache = { fingerprint, result: '' };
    return '';
  }

  const result = `\n\n---\n# Workspace Context\n\nThe following files define who you are and what you know.\n\nConfig files (${configDir}/) are read-only in the sandbox. To edit them, use the\nrequest_config_write tool — the user will see a diff and approve or deny.\n\nMemory files (${workspacePath}/) are freely writable — update them as you learn.\n\n${sections.join('\n\n---\n\n')}`;
  contextCache = { fingerprint, result };
  return result;
}

/** Reset the file cache — for test isolation only. */
export function _clearCacheForTest(): void {
  fileCache.clear();
  contextCache = null;
}

/** Invalidate the assembled context cache (e.g. on /refresh). */
export function clearContextCache(): void {
  contextCache = null;
}

/**
 * Get the current date string for memory file naming.
 */
export function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
