/**
 * Unit tests for src/audit.ts — structured audit logging.
 * Run with: node --import tsx/esm --test src/audit.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditLog, _setLogPathForTest } from './audit.js';

// ---------------------------------------------------------------------------
// auditLog
// ---------------------------------------------------------------------------

let tmpDir: string;
let logPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-audit-test-'));
  logPath = join(tmpDir, 'audit.log');
  _setLogPathForTest(logPath);
});

afterEach(() => {
  _setLogPathForTest('/tmp/aigent-audit.log'); // restore default
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('auditLog', () => {
  it('writes a JSON line to the log file', () => {
    auditLog({ type: 'exec_tier1_block', detail: 'rm -rf /' });
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.type, 'exec_tier1_block');
    assert.equal(parsed.detail, 'rm -rf /');
  });

  it('includes ts field with a number', () => {
    auditLog({ type: 'exec_tier2_allow', detail: 'git status' });
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    assert.equal(typeof parsed.ts, 'number');
    // Should be a recent timestamp
    assert.ok(parsed.ts > Date.now() - 5000);
  });

  it('includes reason when provided', () => {
    auditLog({ type: 'exec_tier1_block', detail: 'sudo rm', reason: 'privilege escalation' });
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    assert.equal(parsed.reason, 'privilege escalation');
  });

  it('includes approved when provided', () => {
    auditLog({ type: 'exec_user_approve', detail: 'npm install', approved: true });
    const parsed = JSON.parse(readFileSync(logPath, 'utf-8').trim());
    assert.equal(parsed.approved, true);
  });

  it('produces NDJSON format (one JSON line per call)', () => {
    auditLog({ type: 'exec_tier2_allow', detail: 'ls' });
    auditLog({ type: 'exec_tier2_allow', detail: 'cat foo' });
    auditLog({ type: 'exec_tier1_block', detail: 'rm -rf /', reason: 'root delete' });
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 3);
    // Each line should be valid JSON
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  it('does not throw on write failure', () => {
    _setLogPathForTest('/nonexistent/deeply/nested/path/audit.log');
    // Should silently swallow the error
    assert.doesNotThrow(() => {
      auditLog({ type: 'exec_tier2_allow', detail: 'test' });
    });
  });
});
