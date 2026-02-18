import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_FILES = [
  { name: 'AGENTS.md', label: 'Operating Instructions' },
  { name: 'SOUL.md', label: 'Personality' },
  { name: 'IDENTITY.md', label: 'Identity' },
  { name: 'USER.md', label: 'User Profile' },
  { name: 'MEMORY.md', label: 'Long-Term Memory' },
  { name: 'TOOLS.md', label: 'Tool Notes' },
] as const;

/** Days of full daily logs to include in the system prompt */
const RECENT_DAYS = 3;

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
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

  // Load core workspace files
  for (const file of WORKSPACE_FILES) {
    const content = readIfExists(join(workspacePath, file.name));
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

  // Older files: just an index so the agent knows they exist
  if (olderFiles.length > 0) {
    const index = olderFiles.map((f) => {
      const content = readIfExists(f.path);
      const firstLine = content?.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() ?? '';
      const preview = firstLine.slice(0, 80);
      return `- ${f.date} (${Math.round(f.size / 1024)}KB)${preview ? `: ${preview}` : ''}`;
    });
    sections.push(
      `## Older Memory Files\n\nThese daily logs exist but aren't loaded. Use read_file to access them if needed.\nPath: ${memoryDir}/YYYY-MM-DD.md\n\n${index.join('\n')}`
    );
  }

  if (sections.length === 0) {
    return '';
  }

  return `\n\n---\n# Workspace Context\n\nThe following files define who you are and what you know.\nYou can update these files at any time using your tools.\nWorkspace path: ${workspacePath}\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Get the current date string for memory file naming.
 */
export function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}
