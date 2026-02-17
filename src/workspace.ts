import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_FILES = [
  { name: 'AGENTS.md', label: 'Operating Instructions' },
  { name: 'SOUL.md', label: 'Personality' },
  { name: 'IDENTITY.md', label: 'Identity' },
  { name: 'USER.md', label: 'User Profile' },
  { name: 'MEMORY.md', label: 'Long-Term Memory' },
  { name: 'TOOLS.md', label: 'Tool Notes' },
] as const;

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

function getTodayAndYesterday(): [string, string] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  return [today, yesterday];
}

/**
 * Load all workspace files and compose them into a system prompt section.
 * Returns the workspace context string to be appended to the base system prompt.
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

  // Load today's and yesterday's memory
  const [today, yesterday] = getTodayAndYesterday();

  const yesterdayMemory = readIfExists(join(memoryDir, `${yesterday}.md`));
  if (yesterdayMemory?.trim()) {
    sections.push(`## Yesterday's Log (${yesterday})\n\n${yesterdayMemory.trim()}`);
  }

  const todayMemory = readIfExists(join(memoryDir, `${today}.md`));
  if (todayMemory?.trim()) {
    sections.push(`## Today's Log (${today})\n\n${todayMemory.trim()}`);
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
