/**
 * Unit tests for src/log-rotate.ts — startup log rotation.
 * Run with: node --import tsx/esm --test src/log-rotate.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rotateIfNeeded } from './log-rotate.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-rotate-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('rotateIfNeeded', () => {
  it('does nothing when file is under threshold', () => {
    const logPath = join(tmpDir, 'small.log');
    writeFileSync(logPath, 'small content');
    rotateIfNeeded(logPath, 1024); // 1 KB threshold
    assert.ok(existsSync(logPath));
    assert.equal(readFileSync(logPath, 'utf-8'), 'small content');
    assert.ok(!existsSync(`${logPath}.1`));
  });

  it('rotates file when over threshold', () => {
    const logPath = join(tmpDir, 'big.log');
    const bigContent = 'x'.repeat(2048);
    writeFileSync(logPath, bigContent);
    rotateIfNeeded(logPath, 1024); // 1 KB threshold
    // Original should be gone (renamed to .1)
    assert.ok(!existsSync(logPath));
    assert.ok(existsSync(`${logPath}.1`));
    assert.equal(readFileSync(`${logPath}.1`, 'utf-8'), bigContent);
  });

  it('shifts existing .1 to .2 before rotating', () => {
    const logPath = join(tmpDir, 'cascade.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    writeFileSync(`${logPath}.1`, 'previous rotation');
    rotateIfNeeded(logPath, 1024, 2);
    assert.ok(!existsSync(logPath));
    assert.ok(existsSync(`${logPath}.1`));
    assert.ok(existsSync(`${logPath}.2`));
    assert.equal(readFileSync(`${logPath}.2`, 'utf-8'), 'previous rotation');
  });

  it('deletes oldest rotation when at capacity', () => {
    const logPath = join(tmpDir, 'full.log');
    writeFileSync(logPath, 'x'.repeat(2048));
    writeFileSync(`${logPath}.1`, 'rotation 1');
    writeFileSync(`${logPath}.2`, 'oldest — should be deleted');
    rotateIfNeeded(logPath, 1024, 2);
    assert.ok(!existsSync(logPath));
    assert.ok(existsSync(`${logPath}.1`));
    assert.ok(existsSync(`${logPath}.2`));
    // .2 should now contain what was .1
    assert.equal(readFileSync(`${logPath}.2`, 'utf-8'), 'rotation 1');
  });

  it('does not throw when file does not exist', () => {
    assert.doesNotThrow(() => {
      rotateIfNeeded(join(tmpDir, 'nonexistent.log'));
    });
  });

  it('does not throw on permission error', () => {
    assert.doesNotThrow(() => {
      rotateIfNeeded('/nonexistent/deeply/nested/path.log');
    });
  });
});
