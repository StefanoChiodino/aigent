/**
 * Unit tests for src/workspace.ts — workspace context loading and date helpers.
 * Run with: node --import tsx/esm --test src/workspace.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceContext, getTodayDateString, _clearCacheForTest } from './workspace.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function setupWorkspace(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-ws-test-'));
  return tmpDir;
}

// Save/restore env vars
const envVars = ['AIGENT_SLIM_PROMPT', 'AIGENT_FULL_LOGS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const v of envVars) {
    savedEnv[v] = process.env[v];
    delete process.env[v];
  }
  _clearCacheForTest();
  setupWorkspace();
});

afterEach(() => {
  for (const v of envVars) {
    if (savedEnv[v] === undefined) delete process.env[v];
    else process.env[v] = savedEnv[v];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// getTodayDateString
// ---------------------------------------------------------------------------

describe('getTodayDateString', () => {
  it('returns string in YYYY-MM-DD format', () => {
    const result = getTodayDateString();
    assert.match(result, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('has length exactly 10', () => {
    assert.equal(getTodayDateString().length, 10);
  });
});

// ---------------------------------------------------------------------------
// loadWorkspaceContext
// ---------------------------------------------------------------------------

describe('loadWorkspaceContext', () => {
  it('returns empty string for empty workspace', () => {
    assert.equal(loadWorkspaceContext(tmpDir), '');
  });

  it('creates memory directory if it does not exist', () => {
    loadWorkspaceContext(tmpDir);
    assert.ok(existsSync(join(tmpDir, 'memory')));
  });

  it('includes config files with [read-only] label', () => {
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    writeFileSync(join(tmpDir, 'config', 'AGENTS.md'), '# Instructions here');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(ctx.includes('[read-only]'));
    assert.ok(ctx.includes('Instructions here'));
  });

  it('skips empty config files', () => {
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    writeFileSync(join(tmpDir, 'config', 'EMPTY.md'), '   \n  ');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(!ctx.includes('EMPTY'));
  });

  it('includes MEMORY.md by default', () => {
    writeFileSync(join(tmpDir, 'MEMORY.md'), '# Some memory notes');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(ctx.includes('Long-Term Memory'));
    assert.ok(ctx.includes('Some memory notes'));
  });

  it('skips MEMORY.md when AIGENT_SLIM_PROMPT=1', () => {
    process.env['AIGENT_SLIM_PROMPT'] = '1';
    writeFileSync(join(tmpDir, 'MEMORY.md'), '# Memory content');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(!ctx.includes('Long-Term Memory'));
  });

  it('includes daily memory file index when files exist', () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, '2026-02-25.md'), '# Log entry');
    writeFileSync(join(memDir, '2026-02-26.md'), '# Another log');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(ctx.includes('2026-02-26'));
    assert.ok(ctx.includes('2026-02-25'));
  });

  it('lists daily memory files sorted newest first in index mode', () => {
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, '2026-01-01.md'), '# Old');
    writeFileSync(join(memDir, '2026-02-27.md'), '# New');
    const ctx = loadWorkspaceContext(tmpDir);
    const idx27 = ctx.indexOf('2026-02-27');
    const idx01 = ctx.indexOf('2026-01-01');
    assert.ok(idx27 >= 0, 'should include 2026-02-27');
    assert.ok(idx01 >= 0, 'should include 2026-01-01');
    assert.ok(idx27 < idx01, 'newer date should appear before older date');
  });

  it('includes full logs when AIGENT_FULL_LOGS=1', () => {
    process.env['AIGENT_FULL_LOGS'] = '1';
    const memDir = join(tmpDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    const today = getTodayDateString();
    writeFileSync(join(memDir, `${today}.md`), '# Today full log content');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(ctx.includes('Today full log content'));
    assert.ok(ctx.includes("Today's Log"));
  });

  it('header includes path references', () => {
    mkdirSync(join(tmpDir, 'config'), { recursive: true });
    writeFileSync(join(tmpDir, 'config', 'SOUL.md'), '# Soul');
    const ctx = loadWorkspaceContext(tmpDir);
    assert.ok(ctx.includes('Workspace Context'));
    assert.ok(ctx.includes('read-only in the sandbox'));
  });
});
