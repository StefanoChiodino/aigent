/**
 * Settings persistence — verifies that model, thinking level, and short mode
 * survive browser reconnects and server restarts.
 *
 * Tests the settings store merge logic (what happens when the server pushes
 * state vs. what the browser has saved in localStorage).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from '../stores/settings';

describe('Settings persistence — mergeClientSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      clientSettings: {},
      serverSettings: {},
      serverSettingsPending: {},
    });
  });

  it('fills in missing keys from server', () => {
    useSettingsStore.getState().mergeClientSettings({
      AIGENT_MODEL: 'claude-opus-4-6',
      AIGENT_THINKING: 'medium',
      AIGENT_SHORT: false,
    });
    const cs = useSettingsStore.getState().clientSettings;
    expect(cs['AIGENT_MODEL']).toBe('claude-opus-4-6');
    expect(cs['AIGENT_THINKING']).toBe('medium');
    expect(cs['AIGENT_SHORT']).toBe(false);
  });

  it('does NOT overwrite existing browser values with server push', () => {
    // User previously set these in the browser
    useSettingsStore.setState({
      clientSettings: {
        AIGENT_MODEL: 'claude-haiku-4-5-20251001',
        AIGENT_THINKING: 'high',
        AIGENT_SHORT: true,
      },
    });

    // Server pushes different values
    useSettingsStore.getState().mergeClientSettings({
      AIGENT_MODEL: 'claude-opus-4-6',
      AIGENT_THINKING: 'medium',
      AIGENT_SHORT: false,
    });

    // Browser values must win
    const cs = useSettingsStore.getState().clientSettings;
    expect(cs['AIGENT_MODEL']).toBe('claude-haiku-4-5-20251001');
    expect(cs['AIGENT_THINKING']).toBe('high');
    expect(cs['AIGENT_SHORT']).toBe(true);
  });

  it('permission keys always take server value (gatekeeper is authoritative)', () => {
    useSettingsStore.setState({
      clientSettings: {
        exec_perm_alwaysAllow: '["ls"]',
        fetch_perm_deny: '["evil.com"]',
        file_perm_readWrite: '["~/old"]',
      },
    });

    useSettingsStore.getState().mergeClientSettings({
      exec_perm_alwaysAllow: '["ls","git *"]',
      fetch_perm_deny: '["evil.com","bad.com"]',
      file_perm_readWrite: '["~/new"]',
    });

    const cs = useSettingsStore.getState().clientSettings;
    expect(cs['exec_perm_alwaysAllow']).toBe('["ls","git *"]');
    expect(cs['fetch_perm_deny']).toBe('["evil.com","bad.com"]');
    expect(cs['file_perm_readWrite']).toBe('["~/new"]');
  });
});

describe('Settings persistence — setClientSetting', () => {
  beforeEach(() => {
    useSettingsStore.setState({
      clientSettings: {},
      serverSettings: {},
      serverSettingsPending: {},
    });
    // Mock fetch so setClientSetting doesn't fail
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 204 }))) as typeof fetch;
  });

  it('persists thinking level when set via state event', () => {
    useSettingsStore.getState().setClientSetting('AIGENT_THINKING', 'low');
    expect(useSettingsStore.getState().clientSettings['AIGENT_THINKING']).toBe('low');
  });

  it('persists model when set via state event', () => {
    useSettingsStore.getState().setClientSetting('AIGENT_MODEL', 'claude-haiku-4-5-20251001');
    expect(useSettingsStore.getState().clientSettings['AIGENT_MODEL']).toBe('claude-haiku-4-5-20251001');
  });

  it('persists short mode when set via state event', () => {
    useSettingsStore.getState().setClientSetting('AIGENT_SHORT', true);
    expect(useSettingsStore.getState().clientSettings['AIGENT_SHORT']).toBe(true);
  });

  it('setting a value makes it visible to reconnect logic via clientSettings', () => {
    // Simulate: user changes thinking to 'max' via /effort max
    useSettingsStore.getState().setClientSetting('AIGENT_THINKING', 'max');

    // On reconnect, the browser checks clientSettings directly
    const cs = useSettingsStore.getState().clientSettings;
    expect('AIGENT_THINKING' in cs).toBe(true);
    expect(cs['AIGENT_THINKING']).toBe('max');
  });

  it('reconnect sync only triggers when key exists in clientSettings', () => {
    // No value saved — key should NOT be in clientSettings
    const cs = useSettingsStore.getState().clientSettings;
    expect('AIGENT_THINKING' in cs).toBe(false);

    // This means the reconnect logic won't override the server's value
    // (it checks 'AIGENT_THINKING' in cs, not getClientSetting which returns defaults)
  });
});
