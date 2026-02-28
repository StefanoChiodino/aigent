/**
 * Unit tests for src/settings-file.ts — serialized settings read/write.
 *
 * Run with: node --import tsx/esm --test src/settings-file.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSettingsSync,
  writeSettings,
  writeSettingsSync,
  _setSettingsPathForTest,
  getSettingsPath,
} from './settings-file.js';

// Each test gets its own temp file to avoid cross-contamination.
let testFile: string;
let originalPath: string;
let counter = 0;

function freshTempFile(): string {
  return join(tmpdir(), `aigent-settings-test-${Date.now()}-${counter++}.json`);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalPath = getSettingsPath();
  testFile = freshTempFile();
  _setSettingsPathForTest(testFile);
});

afterEach(() => {
  _setSettingsPathForTest(originalPath);
  try { unlinkSync(testFile); } catch { /* ok */ }
  try { unlinkSync(testFile + '.tmp'); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// readSettingsSync
// ---------------------------------------------------------------------------

describe('readSettingsSync', () => {
  it('returns empty object when file does not exist', () => {
    const settings = readSettingsSync();
    assert.deepEqual(settings, {});
  });

  it('reads a valid JSON file', () => {
    writeFileSync(testFile, JSON.stringify({ foo: 'bar' }));
    const settings = readSettingsSync();
    assert.equal(settings['foo'], 'bar');
  });

  it('returns empty object on malformed JSON', () => {
    writeFileSync(testFile, 'not-json!');
    const settings = readSettingsSync();
    assert.deepEqual(settings, {});
  });
});

// ---------------------------------------------------------------------------
// writeSettingsSync
// ---------------------------------------------------------------------------

describe('writeSettingsSync', () => {
  it('creates the file if it does not exist', () => {
    writeSettingsSync('test', () => ({ created: true }));
    assert.ok(existsSync(testFile));
    const settings = readSettingsSync();
    assert.equal(settings['created'], true);
  });

  it('merges into existing settings', () => {
    writeFileSync(testFile, JSON.stringify({ a: 1, b: 2 }));
    writeSettingsSync('test', (current) => ({ ...current, b: 3, c: 4 }));
    const settings = readSettingsSync();
    assert.equal(settings['a'], 1);
    assert.equal(settings['b'], 3);
    assert.equal(settings['c'], 4);
  });
});

// ---------------------------------------------------------------------------
// writeSettings (async)
// ---------------------------------------------------------------------------

describe('writeSettings', () => {
  it('writes and reads back correctly', async () => {
    await writeSettings('test', () => ({ async_key: 'value' }));
    const settings = readSettingsSync();
    assert.equal(settings['async_key'], 'value');
  });

  it('serializes concurrent writes (no lost updates)', async () => {
    writeFileSync(testFile, JSON.stringify({ counter: 0 }));

    // Fire 10 concurrent increments
    const promises = Array.from({ length: 10 }, () =>
      writeSettings('test', (current) => ({
        ...current,
        counter: (current['counter'] as number) + 1,
      }))
    );
    await Promise.all(promises);

    const settings = readSettingsSync();
    assert.equal(settings['counter'], 10, 'All 10 increments should be applied');
  });
});

// ---------------------------------------------------------------------------
// Permission sub-object writes (the web-bridge pattern)
// ---------------------------------------------------------------------------

describe('permission sub-object writes', () => {
  it('writing alwaysAllow does not touch deny', () => {
    writeFileSync(testFile, JSON.stringify({
      exec_permissions: {
        alwaysAllow: ['git status'],
        deny: ['sudo *', 'rm -rf /'],
      },
    }));

    // Simulate browser POST: only updating alwaysAllow
    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const existing = merged['exec_permissions'] as Record<string, unknown>;
      merged['exec_permissions'] = { ...existing, alwaysAllow: ['git status', 'ls *'] };
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['exec_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['alwaysAllow'], ['git status', 'ls *']);
    assert.deepEqual(perms['deny'], ['sudo *', 'rm -rf /'], 'deny must be untouched');
  });

  it('writing deny does not touch alwaysAllow', () => {
    writeFileSync(testFile, JSON.stringify({
      exec_permissions: {
        alwaysAllow: ['git status', 'ls *'],
        deny: ['sudo *'],
      },
    }));

    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const existing = merged['exec_permissions'] as Record<string, unknown>;
      merged['exec_permissions'] = { ...existing, deny: ['sudo *', 'mkfs *'] };
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['exec_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['alwaysAllow'], ['git status', 'ls *'], 'alwaysAllow must be untouched');
    assert.deepEqual(perms['deny'], ['sudo *', 'mkfs *']);
  });

  it('user can set alwaysAllow to just ["*"] without defaults reappearing', () => {
    // Start with defaults
    writeFileSync(testFile, JSON.stringify({
      exec_permissions: {
        alwaysAllow: ['git status', 'ls', 'make *'],
        deny: ['sudo *'],
      },
    }));

    // User sets to wildcard only
    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const existing = merged['exec_permissions'] as Record<string, unknown>;
      merged['exec_permissions'] = { ...existing, alwaysAllow: ['*'] };
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['exec_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['alwaysAllow'], ['*'], 'Should be exactly ["*"], no defaults merged back');
  });

  it('user can set alwaysAllow to empty array', () => {
    writeFileSync(testFile, JSON.stringify({
      exec_permissions: {
        alwaysAllow: ['git status', 'ls'],
        deny: ['sudo *'],
      },
    }));

    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const existing = merged['exec_permissions'] as Record<string, unknown>;
      merged['exec_permissions'] = { ...existing, alwaysAllow: [] };
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['exec_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['alwaysAllow'], [], 'Empty array should be written as-is');
  });

  it('fetch_permissions alwaysAllow is stored as-is', () => {
    writeFileSync(testFile, JSON.stringify({
      fetch_permissions: {
        alwaysAllow: ['*', 'api.example.com'],
        deny: [],
      },
    }));

    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const existing = merged['fetch_permissions'] as Record<string, unknown>;
      merged['fetch_permissions'] = { ...existing, alwaysAllow: ['api.example.com'] };
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['fetch_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['alwaysAllow'], ['api.example.com']);
  });

  it('file_permissions readWrite update preserves readOnly and deny (deep-merge)', () => {
    writeFileSync(testFile, JSON.stringify({
      file_permissions: {
        readWrite: ['/home/user/project/**'],
        readOnly: ['~/configs/**'],
        deny: ['/etc/**'],
      },
    }));

    // Simulate browser POST of { file_permissions: { readWrite: ['/tmp/**'] } }
    // This mirrors the deep-merge pattern in web-bridge writeClientSettings
    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const k = 'file_permissions';
      const incoming = { readWrite: ['/tmp/**'] };
      if (merged[k] !== null && typeof merged[k] === 'object') {
        merged[k] = { ...(merged[k] as Record<string, unknown>), ...incoming };
      } else {
        merged[k] = incoming;
      }
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['file_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['readWrite'], ['/tmp/**']);
    assert.deepEqual(perms['readOnly'], ['~/configs/**'], 'readOnly must survive readWrite update');
    assert.deepEqual(perms['deny'], ['/etc/**'], 'deny must survive readWrite update');
  });

  it('file_permissions alwaysAllow is stored as-is', () => {
    writeFileSync(testFile, JSON.stringify({
      file_permissions: {
        alwaysAllow: ['/home/user/project/**'],
        deny: [],
      },
    }));

    writeSettingsSync('test', (current) => {
      const merged: Record<string, unknown> = { ...current };
      const existing = merged['file_permissions'] as Record<string, unknown>;
      merged['file_permissions'] = { ...existing, alwaysAllow: ['/tmp/**'] };
      return merged;
    });

    const settings = readSettingsSync();
    const perms = settings['file_permissions'] as Record<string, unknown>;
    assert.deepEqual(perms['alwaysAllow'], ['/tmp/**']);
  });
});

// ---------------------------------------------------------------------------
// Concurrent writes to different permission fields
// ---------------------------------------------------------------------------

describe('concurrent permission writes', () => {
  it('interleaved exec and fetch permission writes both persist', async () => {
    writeFileSync(testFile, JSON.stringify({
      exec_permissions: { alwaysAllow: ['git status'], deny: ['sudo *'] },
      fetch_permissions: { alwaysAllow: ['api.github.com'], deny: [] },
    }));

    await Promise.all([
      writeSettings('test-exec', (current) => {
        const perms = current['exec_permissions'] as Record<string, unknown>;
        return { ...current, exec_permissions: { ...perms, alwaysAllow: ['git status', 'ls *'] } };
      }),
      writeSettings('test-fetch', (current) => {
        const perms = current['fetch_permissions'] as Record<string, unknown>;
        return { ...current, fetch_permissions: { ...perms, alwaysAllow: ['api.github.com', 'api.example.com'] } };
      }),
    ]);

    const settings = readSettingsSync();
    const exec = settings['exec_permissions'] as Record<string, unknown>;
    const fetch = settings['fetch_permissions'] as Record<string, unknown>;

    // Both writes must have taken effect
    assert.ok((exec['alwaysAllow'] as string[]).includes('ls *'), 'exec alwaysAllow should include ls *');
    assert.ok((fetch['alwaysAllow'] as string[]).includes('api.example.com'), 'fetch alwaysAllow should include api.example.com');
  });
});
