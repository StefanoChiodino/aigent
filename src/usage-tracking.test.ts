import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getUsagePath, loadLifetimeUsage, saveLifetimeUsage, formatLifetimeUsage } from './usage-tracking.js';

describe('getUsagePath', () => {
  it('returns usage.json inside workspace path', () => {
    assert.equal(getUsagePath('/workspace'), '/workspace/usage.json');
  });
});

describe('loadLifetimeUsage', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'usage-load-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns zeros when file does not exist', () => {
    const usage = loadLifetimeUsage(tmpDir);
    assert.equal(usage.totalInput, 0);
    assert.equal(usage.sessions, 0);
  });

  it('loads existing usage data', () => {
    writeFileSync(join(tmpDir, 'usage.json'), JSON.stringify({
      totalInput: 1000, totalOutput: 500, totalCacheRead: 200, totalCacheWrite: 100,
      sessions: 5, firstUsed: '2024-01-01T00:00:00.000Z', lastUsed: '2024-06-15T12:00:00.000Z',
    }));
    const usage = loadLifetimeUsage(tmpDir);
    assert.equal(usage.totalInput, 1000);
    assert.equal(usage.sessions, 5);
  });

  it('returns defaults on corrupted JSON', () => {
    writeFileSync(join(tmpDir, 'usage.json'), 'not json');
    const usage = loadLifetimeUsage(tmpDir);
    assert.equal(usage.totalInput, 0);
  });
});

describe('saveLifetimeUsage', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'usage-save-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates usage.json when it does not exist', () => {
    saveLifetimeUsage(tmpDir, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 });
    const saved = JSON.parse(readFileSync(join(tmpDir, 'usage.json'), 'utf-8'));
    assert.equal(saved.totalInput, 100);
    assert.equal(saved.totalOutput, 50);
    assert.equal(saved.sessions, 1);
  });

  it('accumulates across multiple saves', () => {
    saveLifetimeUsage(tmpDir, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    saveLifetimeUsage(tmpDir, { input: 200, output: 75, cacheRead: 0, cacheWrite: 0 });
    const saved = JSON.parse(readFileSync(join(tmpDir, 'usage.json'), 'utf-8'));
    assert.equal(saved.totalInput, 300);
    assert.equal(saved.sessions, 2);
  });

  it('preserves firstUsed across saves', () => {
    writeFileSync(join(tmpDir, 'usage.json'), JSON.stringify({
      totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
      sessions: 0, firstUsed: '2024-01-01T00:00:00.000Z', lastUsed: '2024-01-01T00:00:00.000Z',
    }));
    saveLifetimeUsage(tmpDir, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    const saved = JSON.parse(readFileSync(join(tmpDir, 'usage.json'), 'utf-8'));
    assert.equal(saved.firstUsed, '2024-01-01T00:00:00.000Z');
  });
});

describe('formatLifetimeUsage', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'usage-fmt-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('formats a new workspace with session usage', () => {
    const result = formatLifetimeUsage(tmpDir, { input: 500, output: 200, cacheRead: 0, cacheWrite: 0 });
    assert.ok(result.includes('This session:'));
    assert.ok(result.includes('Lifetime:'));
  });

  it('formats large numbers with M suffix', () => {
    writeFileSync(join(tmpDir, 'usage.json'), JSON.stringify({
      totalInput: 1_500_000, totalOutput: 500_000, totalCacheRead: 0, totalCacheWrite: 0,
      sessions: 10, firstUsed: '2024-01-01T00:00:00.000Z', lastUsed: '2024-06-01T00:00:00.000Z',
    }));
    const result = formatLifetimeUsage(tmpDir, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.ok(result.includes('M'));
  });

  it('includes session count', () => {
    writeFileSync(join(tmpDir, 'usage.json'), JSON.stringify({
      totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
      sessions: 5, firstUsed: '2024-01-01T00:00:00.000Z', lastUsed: '2024-01-01T00:00:00.000Z',
    }));
    const result = formatLifetimeUsage(tmpDir, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 });
    assert.ok(result.includes('6 session(s)'));
  });
});
