/**
 * Settings payload — verifies that permission edits only send the changed
 * sub-field, preventing stale browser state from clobbering gatekeeper-owned
 * permission lists.
 *
 * Regression test for: browser POSTing the full permission object with
 * phantom `prompt: []` and potentially stale alwaysAllow/deny arrays.
 */

import { describe, it, expect } from 'vitest';
import { buildSettingsPayload } from '../stores/settings';

describe('buildSettingsPayload', () => {
  // ── Exec permissions ──────────────────────────────────────────────────────

  it('exec_perm_alwaysAllow sends only alwaysAllow, not deny', () => {
    const all = {
      exec_perm_alwaysAllow: '["ls","ls *"]',
      exec_perm_deny: '["sudo *"]',
    };
    const result = buildSettingsPayload('exec_perm_alwaysAllow', all.exec_perm_alwaysAllow, all);
    expect(result).toEqual({ exec_permissions: { alwaysAllow: ['ls', 'ls *'] } });
    // Must NOT include deny or prompt
    const perms = result['exec_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('deny');
    expect(perms).not.toHaveProperty('prompt');
  });

  it('exec_perm_deny sends only deny, not alwaysAllow', () => {
    const all = {
      exec_perm_alwaysAllow: '["ls"]',
      exec_perm_deny: '["rm -rf /"]',
    };
    const result = buildSettingsPayload('exec_perm_deny', all.exec_perm_deny, all);
    expect(result).toEqual({ exec_permissions: { deny: ['rm -rf /'] } });
    const perms = result['exec_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('alwaysAllow');
    expect(perms).not.toHaveProperty('prompt');
  });

  it('exec_perm_alwaysClassify sends only alwaysClassify', () => {
    const all = {
      exec_perm_alwaysAllow: '["ls"]',
      exec_perm_alwaysClassify: '["curl *","python *"]',
      exec_perm_deny: '["sudo *"]',
    };
    const result = buildSettingsPayload('exec_perm_alwaysClassify', all.exec_perm_alwaysClassify, all);
    expect(result).toEqual({ exec_permissions: { alwaysClassify: ['curl *', 'python *'] } });
    const perms = result['exec_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('alwaysAllow');
    expect(perms).not.toHaveProperty('deny');
    expect(perms).not.toHaveProperty('prompt');
  });

  // ── Fetch permissions ─────────────────────────────────────────────────────

  it('fetch_perm_alwaysAllow sends only alwaysAllow', () => {
    const all = {
      fetch_perm_alwaysAllow: '["example.com"]',
      fetch_perm_deny: '["evil.com"]',
    };
    const result = buildSettingsPayload('fetch_perm_alwaysAllow', all.fetch_perm_alwaysAllow, all);
    expect(result).toEqual({ fetch_permissions: { alwaysAllow: ['example.com'] } });
    const perms = result['fetch_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('deny');
    expect(perms).not.toHaveProperty('prompt');
  });

  it('fetch_perm_deny sends only deny', () => {
    const all = {
      fetch_perm_alwaysAllow: '["example.com"]',
      fetch_perm_deny: '["evil.com"]',
    };
    const result = buildSettingsPayload('fetch_perm_deny', all.fetch_perm_deny, all);
    expect(result).toEqual({ fetch_permissions: { deny: ['evil.com'] } });
    const perms = result['fetch_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('alwaysAllow');
    expect(perms).not.toHaveProperty('prompt');
  });

  // ── File permissions ─────────────────────────────────────────────────────

  it('file_perm_readWrite sends only readWrite', () => {
    const all = {
      file_perm_readWrite: '["/home/user/project/**"]',
      file_perm_readOnly: '["~/configs/**"]',
      file_perm_deny: '["/etc/**"]',
    };
    const result = buildSettingsPayload('file_perm_readWrite', all.file_perm_readWrite, all);
    expect(result).toEqual({ file_permissions: { readWrite: ['/home/user/project/**'] } });
    const perms = result['file_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('readOnly');
    expect(perms).not.toHaveProperty('deny');
    expect(perms).not.toHaveProperty('prompt');
  });

  it('file_perm_readOnly sends only readOnly', () => {
    const all = {
      file_perm_readWrite: '["/home/user/project/**"]',
      file_perm_readOnly: '["~/configs/**"]',
      file_perm_deny: '["/etc/**"]',
    };
    const result = buildSettingsPayload('file_perm_readOnly', all.file_perm_readOnly, all);
    expect(result).toEqual({ file_permissions: { readOnly: ['~/configs/**'] } });
    const perms = result['file_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('readWrite');
    expect(perms).not.toHaveProperty('deny');
    expect(perms).not.toHaveProperty('prompt');
  });

  it('file_perm_deny sends only deny', () => {
    const all = {
      file_perm_readWrite: '["/home/user/project/**"]',
      file_perm_readOnly: '["~/configs/**"]',
      file_perm_deny: '["/etc/**"]',
    };
    const result = buildSettingsPayload('file_perm_deny', all.file_perm_deny, all);
    expect(result).toEqual({ file_permissions: { deny: ['/etc/**'] } });
    const perms = result['file_permissions'] as Record<string, unknown>;
    expect(perms).not.toHaveProperty('readWrite');
    expect(perms).not.toHaveProperty('readOnly');
    expect(perms).not.toHaveProperty('prompt');
  });

  // ── No phantom prompt field ───────────────────────────────────────────────

  it('never includes a prompt field in exec_permissions', () => {
    for (const key of ['exec_perm_alwaysAllow', 'exec_perm_alwaysClassify', 'exec_perm_deny']) {
      const all = { [key]: '["test"]' };
      const result = buildSettingsPayload(key, all[key]!, all);
      const perms = result['exec_permissions'] as Record<string, unknown>;
      expect(perms).not.toHaveProperty('prompt');
    }
  });

  it('never includes a prompt field in fetch_permissions', () => {
    for (const key of ['fetch_perm_alwaysAllow', 'fetch_perm_deny']) {
      const all = { [key]: '["test"]' };
      const result = buildSettingsPayload(key, all[key]!, all);
      const perms = result['fetch_permissions'] as Record<string, unknown>;
      expect(perms).not.toHaveProperty('prompt');
    }
  });

  it('never includes a prompt field in file_permissions', () => {
    for (const key of ['file_perm_readWrite', 'file_perm_readOnly', 'file_perm_deny']) {
      const all = { [key]: '["test"]' };
      const result = buildSettingsPayload(key, all[key]!, all);
      const perms = result['file_permissions'] as Record<string, unknown>;
      expect(perms).not.toHaveProperty('prompt');
    }
  });

  // ── YOLO mode toggles pass through as plain booleans ─────────────────────

  it('exec_perm_yolo passes through as a plain boolean', () => {
    const result = buildSettingsPayload('exec_perm_yolo', true, { exec_perm_yolo: true });
    expect(result).toEqual({ exec_perm_yolo: true });
    expect(result).not.toHaveProperty('exec_permissions');
  });

  it('fetch_perm_yolo passes through as a plain boolean', () => {
    const result = buildSettingsPayload('fetch_perm_yolo', true, { fetch_perm_yolo: true });
    expect(result).toEqual({ fetch_perm_yolo: true });
    expect(result).not.toHaveProperty('fetch_permissions');
  });

  it('file_perm_yolo passes through as a plain boolean', () => {
    const result = buildSettingsPayload('file_perm_yolo', true, { file_perm_yolo: true });
    expect(result).toEqual({ file_perm_yolo: true });
    expect(result).not.toHaveProperty('file_permissions');
  });

  // ── Non-permission keys pass through unchanged ────────────────────────────

  it('passes through non-permission keys as-is', () => {
    const result = buildSettingsPayload('AIGENT_MODEL', 'claude-opus-4-6', {});
    expect(result).toEqual({ AIGENT_MODEL: 'claude-opus-4-6' });
  });
});
