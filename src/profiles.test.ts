/**
 * Unit tests for src/profiles.ts — profile/session management and autosave.
 * Run with: node --import tsx/esm --test src/profiles.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateSessionId,
  listProfiles,
  getProfilePath,
  saveSession,
  loadSession,
  listSessions,
  autoSaveSession,
  autoLoadSession,
  clearAutoSave,
} from './profiles.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-prof-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// generateSessionId
// ---------------------------------------------------------------------------

describe('generateSessionId', () => {
  it('starts with s-', () => {
    assert.ok(generateSessionId().startsWith('s-'));
  });

  it('produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateSessionId()));
    assert.equal(ids.size, 20);
  });

  it('contains only safe characters', () => {
    const id = generateSessionId();
    assert.match(id, /^s-[a-z0-9]+-[a-z0-9]+$/);
  });
});

// ---------------------------------------------------------------------------
// listProfiles
// ---------------------------------------------------------------------------

describe('listProfiles', () => {
  it('returns empty array when profiles dir does not exist', () => {
    assert.deepEqual(listProfiles(tmpDir), []);
  });

  it('returns profiles with name and path', () => {
    const profDir = join(tmpDir, 'profiles', 'alpha');
    mkdirSync(profDir, { recursive: true });
    const profiles = listProfiles(tmpDir);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.name, 'alpha');
    assert.equal(profiles[0]!.path, profDir);
  });

  it('only includes directories, not files', () => {
    mkdirSync(join(tmpDir, 'profiles'), { recursive: true });
    mkdirSync(join(tmpDir, 'profiles', 'real-profile'));
    writeFileSync(join(tmpDir, 'profiles', 'not-a-profile.txt'), 'nope');
    const profiles = listProfiles(tmpDir);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0]!.name, 'real-profile');
  });
});

// ---------------------------------------------------------------------------
// getProfilePath
// ---------------------------------------------------------------------------

describe('getProfilePath', () => {
  it('creates profile directory with default files', () => {
    const path = getProfilePath(tmpDir, 'test-profile');
    assert.ok(existsSync(path));
    assert.ok(existsSync(join(path, 'SOUL.md')));
    assert.ok(existsSync(join(path, 'AGENTS.md')));
    assert.ok(existsSync(join(path, 'MEMORY.md')));
    assert.ok(existsSync(join(path, 'USER.md')));
    assert.ok(existsSync(join(path, 'TOOLS.md')));
    assert.ok(existsSync(join(path, 'memory')));
    assert.ok(existsSync(join(path, 'sessions')));
  });

  it('returns existing path without recreating', () => {
    const path1 = getProfilePath(tmpDir, 'p');
    // Write something custom to SOUL.md
    writeFileSync(join(path1, 'SOUL.md'), 'custom content');
    const path2 = getProfilePath(tmpDir, 'p');
    assert.equal(path1, path2);
    // Custom content should still be there (not overwritten)
    assert.equal(readFileSync(join(path2, 'SOUL.md'), 'utf-8'), 'custom content');
  });
});

// ---------------------------------------------------------------------------
// saveSession / loadSession
// ---------------------------------------------------------------------------

describe('saveSession / loadSession', () => {
  it('roundtrips messages', () => {
    const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }];
    saveSession(tmpDir, 'default', 'sess-1', messages);
    const loaded = loadSession(tmpDir, 'default', 'sess-1');
    assert.ok(loaded);
    assert.deepEqual(loaded.messages, messages);
  });

  it('returns null for non-existent session', () => {
    // getProfilePath creates the profile dir, so loadSession won't fail on missing dir
    getProfilePath(tmpDir, 'default');
    assert.equal(loadSession(tmpDir, 'default', 'nonexistent'), null);
  });

  it('returns null for corrupt JSON', () => {
    const path = getProfilePath(tmpDir, 'default');
    const sessDir = join(path, 'sessions');
    writeFileSync(join(sessDir, 'bad.json'), 'NOT JSON!!!');
    assert.equal(loadSession(tmpDir, 'default', 'bad'), null);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  it('returns empty array when no sessions exist', () => {
    getProfilePath(tmpDir, 'default');
    assert.deepEqual(listSessions(tmpDir, 'default'), []);
  });

  it('returns sessions sorted newest first', () => {
    const messages = [{ role: 'user', content: 'x' }];
    saveSession(tmpDir, 'default', 'old-session', messages);
    // Nudge time forward to ensure different lastActiveAt
    saveSession(tmpDir, 'default', 'new-session', messages);
    const sessions = listSessions(tmpDir, 'default');
    assert.equal(sessions.length, 2);
    // Both should be present; the newer one first
    assert.ok(sessions[0]!.lastActiveAt >= sessions[1]!.lastActiveAt);
  });

  it('includes messageCount', () => {
    saveSession(tmpDir, 'default', 's1', [1, 2, 3]);
    const sessions = listSessions(tmpDir, 'default');
    assert.equal(sessions[0]!.messageCount, 3);
  });

  it('skips corrupt JSON files', () => {
    saveSession(tmpDir, 'default', 'good', [{ msg: 'ok' }]);
    const path = getProfilePath(tmpDir, 'default');
    writeFileSync(join(path, 'sessions', 'bad.json'), 'CORRUPT');
    const sessions = listSessions(tmpDir, 'default');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.id, 'good');
  });
});

// ---------------------------------------------------------------------------
// autoSaveSession / autoLoadSession / clearAutoSave
// ---------------------------------------------------------------------------

describe('autoSaveSession', () => {
  it('writes .autosave.json to workspace root', () => {
    autoSaveSession(tmpDir, [{ role: 'user' }], [{ text: 'hi' }]);
    assert.ok(existsSync(join(tmpDir, '.autosave.json')));
  });

  it('includes optional fields when provided', () => {
    autoSaveSession(
      tmpDir, [], [],
      { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      { current: 'medium', savedEffort: 'low' },
      'claude-opus-4-6',
      true,
    );
    const raw = JSON.parse(readFileSync(join(tmpDir, '.autosave.json'), 'utf-8'));
    assert.equal(raw.usage.input, 100);
    assert.equal(raw.thinking.current, 'medium');
    assert.equal(raw.model, 'claude-opus-4-6');
    assert.equal(raw.short, true);
  });
});

describe('autoLoadSession', () => {
  it('returns null when no autosave exists', () => {
    assert.equal(autoLoadSession(tmpDir), null);
  });

  it('returns saved data when autosave is recent', () => {
    autoSaveSession(tmpDir, [{ m: 1 }], [{ d: 2 }]);
    const loaded = autoLoadSession(tmpDir);
    assert.ok(loaded);
    assert.deepEqual(loaded.agentMessages, [{ m: 1 }]);
    assert.deepEqual(loaded.uiMessages, [{ d: 2 }]);
  });

  it('returns null when autosave is older than 24 hours', () => {
    const data = {
      savedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      agentMessages: [],
      uiMessages: [],
    };
    writeFileSync(join(tmpDir, '.autosave.json'), JSON.stringify(data));
    assert.equal(autoLoadSession(tmpDir), null);
  });

  it('returns null for corrupt JSON', () => {
    writeFileSync(join(tmpDir, '.autosave.json'), 'NOT JSON');
    assert.equal(autoLoadSession(tmpDir), null);
  });

  it('includes optional fields when present', () => {
    autoSaveSession(tmpDir, [], [], undefined, undefined, 'sonnet', false);
    const loaded = autoLoadSession(tmpDir);
    assert.ok(loaded);
    assert.equal(loaded.model, 'sonnet');
    assert.equal(loaded.short, false);
  });
});

describe('clearAutoSave', () => {
  it('empties the autosave file', () => {
    autoSaveSession(tmpDir, [{ m: 1 }], [{ d: 2 }]);
    clearAutoSave(tmpDir);
    assert.equal(autoLoadSession(tmpDir), null);
  });

  it('is a no-op when no autosave exists', () => {
    clearAutoSave(tmpDir); // should not throw
  });
});
