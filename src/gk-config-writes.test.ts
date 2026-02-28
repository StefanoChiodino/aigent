/**
 * Unit tests for gk-config-writes.ts — host edit-file autoApply behavior.
 * Run with: node --import tsx/esm --test src/gk-config-writes.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleEditFileRequest, type ConfigWriteContext } from './gk-config-writes.js';

function makeTempFile(content: string): string {
  const dir = join(tmpdir(), 'aigent-test-' + Date.now());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'test-file.txt');
  writeFileSync(path, content, 'utf-8');
  return path;
}

function makeCtx(overrides?: Partial<ConfigWriteContext>): ConfigWriteContext & { sent: unknown[]; emitted: unknown[]; messages: string[] } {
  const sent: unknown[] = [];
  const emitted: unknown[] = [];
  const messages: string[] = [];
  return {
    client: {
      send(msg: unknown) { sent.push(msg); },
      emit(event: string, ...args: unknown[]) { emitted.push({ event, args }); },
    },
    log: { info() {}, error() {}, warn() {}, debug() {} } as unknown as ReturnType<typeof import('./logger.js').createLogger>,
    injectSystemMessage(content: string) { messages.push(content); },
    IS_TEST_MODE: true,
    REPO_DIR: tmpdir(),
    resolveHostPath: (p: string) => p,
    sent,
    emitted,
    messages,
    ...overrides,
  };
}

describe('handleEditFileRequest with autoApply', () => {
  let tempFile: string;

  beforeEach(() => {
    tempFile = makeTempFile('line one\nline two\nline three\n');
  });

  afterEach(() => {
    try { unlinkSync(tempFile); } catch { /* ignore */ }
  });

  it('queues for review when autoApply is false (default)', () => {
    const ctx = makeCtx();
    handleEditFileRequest(ctx, 'id-1', tempFile, [
      { old_str: 'line two', new_str: 'line TWO' },
    ], 'test reason');

    // Should emit patch_request, not send an immediate response
    assert.equal(ctx.emitted.length, 1);
    assert.equal((ctx.emitted[0] as { event: string }).event, 'patch_request');
    // File should NOT be modified yet
    assert.equal(readFileSync(tempFile, 'utf-8'), 'line one\nline two\nline three\n');
  });

  it('applies edits directly when autoApply is true', () => {
    const ctx = makeCtx();
    handleEditFileRequest(ctx, 'id-2', tempFile, [
      { old_str: 'line two', new_str: 'line TWO' },
    ], 'test reason', true);

    // Should send ok response, not emit patch_request
    assert.equal(ctx.emitted.length, 0);
    assert.equal(ctx.sent.length, 1);
    const resp = ctx.sent[0] as { type: string; id: string; ok: boolean };
    assert.equal(resp.type, 'edit_file_response');
    assert.equal(resp.ok, true);
    assert.equal(resp.id, 'id-2');
    // File should be modified
    assert.equal(readFileSync(tempFile, 'utf-8'), 'line one\nline TWO\nline three\n');
  });

  it('auto-applies multiple edits in order', () => {
    const ctx = makeCtx();
    handleEditFileRequest(ctx, 'id-3', tempFile, [
      { old_str: 'line one', new_str: 'LINE ONE' },
      { old_str: 'line three', new_str: 'LINE THREE' },
    ], 'test reason', true);

    assert.equal(readFileSync(tempFile, 'utf-8'), 'LINE ONE\nline two\nLINE THREE\n');
    const resp = ctx.sent[0] as { ok: boolean };
    assert.equal(resp.ok, true);
  });

  it('returns error when old_str not found (autoApply)', () => {
    const ctx = makeCtx();
    handleEditFileRequest(ctx, 'id-4', tempFile, [
      { old_str: 'nonexistent', new_str: 'replacement' },
    ], 'test reason', true);

    const resp = ctx.sent[0] as { type: string; ok: boolean; message: string };
    assert.equal(resp.ok, false);
    assert.match(resp.message, /old_str not found/);
    // File should NOT be modified
    assert.equal(readFileSync(tempFile, 'utf-8'), 'line one\nline two\nline three\n');
  });
});
