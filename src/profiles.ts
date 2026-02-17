import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Profile {
  name: string;
  path: string;
}

export interface Session {
  id: string;
  profileName: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

interface SessionData {
  id: string;
  profileName: string;
  createdAt: string;
  lastActiveAt: string;
  messages: unknown[];
}

const DEFAULT_SOUL = `# SOUL.md — Who You Are

Be direct. Be helpful. Be resourceful.
Have opinions. Push back when it matters.

_This file is yours to evolve._
`;

const DEFAULT_AGENTS = `# AGENTS.md — Operating Instructions

Your workspace files are loaded into your system prompt automatically.
Update MEMORY.md and daily logs as you learn things worth remembering.
`;

const DEFAULT_MEMORY = `# MEMORY.md — Long-Term Memory

_Nothing here yet._
`;

const DEFAULT_USER = `# USER.md — About Your Human

- **Name:** (not configured)
`;

const DEFAULT_TOOLS = `# TOOLS.md — Tool Notes

_Record gotchas and lessons learned here._
`;

/**
 * Get the profiles directory path.
 */
export function getProfilesDir(workspacePath: string): string {
  return join(workspacePath, 'profiles');
}

/**
 * List all available profiles.
 */
export function listProfiles(workspacePath: string): Profile[] {
  const profilesDir = getProfilesDir(workspacePath);
  if (!existsSync(profilesDir)) return [];

  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      path: join(profilesDir, d.name),
    }));
}

/**
 * Get a profile's directory path, creating it with defaults if needed.
 */
export function getProfilePath(workspacePath: string, profileName: string): string {
  const profileDir = join(getProfilesDir(workspacePath), profileName);

  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(join(profileDir, 'memory'), { recursive: true });
    mkdirSync(join(profileDir, 'sessions'), { recursive: true });

    // Write default files
    writeFileSync(join(profileDir, 'SOUL.md'), DEFAULT_SOUL);
    writeFileSync(join(profileDir, 'AGENTS.md'), DEFAULT_AGENTS);
    writeFileSync(join(profileDir, 'MEMORY.md'), DEFAULT_MEMORY);
    writeFileSync(join(profileDir, 'USER.md'), DEFAULT_USER);
    writeFileSync(join(profileDir, 'TOOLS.md'), DEFAULT_TOOLS);
  }

  return profileDir;
}

/**
 * Save a session to disk.
 */
export function saveSession(
  workspacePath: string,
  profileName: string,
  sessionId: string,
  messages: unknown[],
): void {
  const profileDir = getProfilePath(workspacePath, profileName);
  const sessionsDir = join(profileDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  const data: SessionData = {
    id: sessionId,
    profileName,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    messages,
  };

  writeFileSync(join(sessionsDir, `${sessionId}.json`), JSON.stringify(data, null, 2));
}

/**
 * Load a session from disk.
 */
export function loadSession(
  workspacePath: string,
  profileName: string,
  sessionId: string,
): { messages: unknown[] } | null {
  const sessionPath = join(getProfilePath(workspacePath, profileName), 'sessions', `${sessionId}.json`);
  if (!existsSync(sessionPath)) return null;

  try {
    const data = JSON.parse(readFileSync(sessionPath, 'utf-8')) as SessionData;
    return { messages: data.messages };
  } catch {
    return null;
  }
}

/**
 * List sessions for a profile.
 */
export function listSessions(workspacePath: string, profileName: string): Session[] {
  const sessionsDir = join(getProfilePath(workspacePath, profileName), 'sessions');
  if (!existsSync(sessionsDir)) return [];

  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8')) as SessionData;
        return {
          id: data.id,
          profileName: data.profileName,
          createdAt: data.createdAt,
          lastActiveAt: data.lastActiveAt,
          messageCount: data.messages.length,
        };
      } catch {
        return null;
      }
    })
    .filter((s): s is Session => s !== null)
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
}

/**
 * Generate a short session ID.
 */
export function generateSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Auto-save session to a well-known file for automatic restore on restart.
 * Saves both the agent messages (for API continuity) and UI messages (for display).
 */
export function autoSaveSession(
  workspacePath: string,
  agentMessages: unknown[],
  uiMessages: unknown[],
): void {
  const autoSavePath = join(workspacePath, '.autosave.json');
  const data = {
    savedAt: new Date().toISOString(),
    agentMessages,
    uiMessages,
  };
  try {
    writeFileSync(autoSavePath, JSON.stringify(data, null, 2));
  } catch {
    // Silently fail — don't break the agent over a save failure
  }
}

/**
 * Auto-load the most recent auto-saved session.
 */
export function autoLoadSession(
  workspacePath: string,
): { agentMessages: unknown[]; uiMessages: unknown[] } | null {
  const autoSavePath = join(workspacePath, '.autosave.json');
  if (!existsSync(autoSavePath)) return null;

  try {
    const raw = readFileSync(autoSavePath, 'utf-8');
    const data = JSON.parse(raw) as {
      savedAt: string;
      agentMessages: unknown[];
      uiMessages: unknown[];
    };
    // Only restore if saved within the last hour
    const savedAt = new Date(data.savedAt).getTime();
    const age = Date.now() - savedAt;
    if (age > 24 * 60 * 60 * 1000) return null;
    return { agentMessages: data.agentMessages, uiMessages: data.uiMessages };
  } catch {
    return null;
  }
}

/**
 * Clear the auto-save file (e.g. on /reset).
 */
export function clearAutoSave(workspacePath: string): void {
  const autoSavePath = join(workspacePath, '.autosave.json');
  try {
    if (existsSync(autoSavePath)) {
      writeFileSync(autoSavePath, '');
    }
  } catch {
    // ignore
  }
}
