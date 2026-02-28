/**
 * Unit tests for src/tool-log.ts — tool call daily log.
 * Run with: node --import tsx/esm --test src/tool-log.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatToolLogLine, appendToolLog } from './tool-log.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'aigent-toollog-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('formatToolLogLine', () => {
  it('produces pipe-delimited format', () => {
    const line = formatToolLogLine({ tool: 'exec', input: '{"command":"ls"}', ms: '42', ok: true });
    assert.match(line, /^\| \d{2}:\d{2}:\d{2} \| exec \| \{"command":"ls"\} \| 42ms \| ok \|  \|$/);
  });

  it('includes reqId when provided', () => {
    const line = formatToolLogLine({ tool: 'read_file', input: '{"path":"/tmp/x"}', ms: '3', ok: true }, 'f9d8e7');
    assert.ok(line.includes('| f9d8e7 |'));
  });

  it('shows FAIL for failed tools', () => {
    const line = formatToolLogLine({ tool: 'exec', input: '(not executed)', ms: '0', ok: false });
    assert.ok(line.includes('| FAIL |'));
  });

  it('escapes pipe characters in input', () => {
    const line = formatToolLogLine({ tool: 'exec', input: 'echo "a|b|c"', ms: '10', ok: true });
    assert.ok(!line.includes('a|b'));
    assert.ok(line.includes('a\\|b\\|c'));
  });

  it('truncates input to 80 chars', () => {
    const longInput = 'a'.repeat(200);
    const line = formatToolLogLine({ tool: 'exec', input: longInput, ms: '5', ok: true });
    // The input field should be 80 chars max
    const parts = line.split(' | ');
    // parts[2] is the input field
    assert.ok(parts[2]!.length <= 80);
  });

  it('replaces newlines with spaces', () => {
    const line = formatToolLogLine({ tool: 'exec', input: 'line1\nline2\nline3', ms: '5', ok: true });
    assert.ok(!line.includes('\n'));
    // The actual content should have spaces instead
    assert.ok(line.includes('line1 line2'));
  });
});

describe('appendToolLog', () => {
  it('creates file with header on first call', () => {
    const memoryDir = join(tmpDir, 'memory');
    mkdirSync(memoryDir);

    appendToolLog(memoryDir, { tool: 'exec', input: '{"cmd":"ls"}', ms: '42', ok: true });

    const dateStr = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(memoryDir, `${dateStr}.md`), 'utf-8');
    assert.ok(content.includes('## Tool Calls'));
    assert.ok(content.includes('| Time |'));
    assert.ok(content.includes('| exec |'));
  });

  it('appends without header on subsequent calls', () => {
    const memoryDir = join(tmpDir, 'memory');
    mkdirSync(memoryDir);

    appendToolLog(memoryDir, { tool: 'exec', input: 'first', ms: '10', ok: true });
    appendToolLog(memoryDir, { tool: 'read_file', input: 'second', ms: '5', ok: true });

    const dateStr = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(memoryDir, `${dateStr}.md`), 'utf-8');
    // Should have exactly one header
    const headerCount = (content.match(/## Tool Calls/g) || []).length;
    assert.equal(headerCount, 1);
    // Should have both tool entries
    assert.ok(content.includes('exec'));
    assert.ok(content.includes('read_file'));
  });

  it('does nothing when memory dir does not exist', () => {
    assert.doesNotThrow(() => {
      appendToolLog(join(tmpDir, 'nonexistent'), { tool: 'exec', input: 'test', ms: '1', ok: true });
    });
  });

  it('includes reqId when provided', () => {
    const memoryDir = join(tmpDir, 'memory');
    mkdirSync(memoryDir);

    appendToolLog(memoryDir, { tool: 'exec', input: 'test', ms: '1', ok: true }, 'abc123');

    const dateStr = new Date().toISOString().slice(0, 10);
    const content = readFileSync(join(memoryDir, `${dateStr}.md`), 'utf-8');
    assert.ok(content.includes('abc123'));
  });
});
