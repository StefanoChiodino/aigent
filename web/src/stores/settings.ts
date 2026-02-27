import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SETTINGS_SCHEMA } from '../lib/settings-schema';

type SettingsValues = Record<string, boolean | number | string>;

interface SettingsState {
  clientSettings: SettingsValues;
  serverSettings: SettingsValues;
  serverSettingsPending: SettingsValues;

  getClientSetting: (key: string) => boolean | number | string;
  setClientSetting: (key: string, value: boolean | number | string) => void;
  mergeClientSettings: (updates: SettingsValues) => void;
  setServerSettings: (updates: SettingsValues) => void;
  setServerSettingPending: (key: string, value: boolean | number | string) => void;
}

/** @internal — exported for testing only */
export function buildSettingsPayload(key: string, value: boolean | number | string, all: SettingsValues): Record<string, unknown> {
  const getList = (k: string): string[] => {
    try { return JSON.parse(String(all[k] ?? '[]')) as string[]; } catch { return []; }
  };
  // Only send the specific sub-field that changed — never rebuild the full
  // permission object.  This prevents stale browser state from overwriting
  // entries added by the gatekeeper (e.g. via --always approve).
  if (key === 'exec_perm_alwaysAllow') {
    return { exec_permissions: { alwaysAllow: getList(key) } };
  }
  if (key === 'exec_perm_deny') {
    return { exec_permissions: { deny: getList(key) } };
  }
  if (key === 'fetch_perm_alwaysAllow') {
    return { fetch_permissions: { alwaysAllow: getList(key) } };
  }
  if (key === 'fetch_perm_deny') {
    return { fetch_permissions: { deny: getList(key) } };
  }
  if (key.startsWith('tools_')) {
    return {
      tools: {
        summarizeLargeResults: all['tools_summarizeLargeResults'] === true,
        summarizeThresholdTokens: Number(all['tools_summarizeThresholdTokens'] ?? 500),
        summarizeModel: String(all['tools_summarizeModel'] ?? 'claude-haiku-4-5-20251001'),
        summarizeMode: String(all['tools_summarizeMode'] ?? 'allowlist'),
        summarizeTools: getList('tools_summarizeTools'),
      },
    };
  }
  return { [key]: value };
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      clientSettings: {},
      serverSettings: {},
      serverSettingsPending: {},

      getClientSetting: (key) => {
        const { clientSettings } = get();
        if (key in clientSettings) return clientSettings[key]!;
        const def = SETTINGS_SCHEMA.find(d => d.key === key && d.scope === 'client');
        return def?.default ?? '';
      },

      setClientSetting: (key, value) => {
        set(s => {
          const next = { ...s.clientSettings, [key]: value };
          const payload = buildSettingsPayload(key, value, next);
          fetch('/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {});
          return { clientSettings: next };
        });
      },

      // Server sends its view of settings on connect. We let the browser's own
      // persisted values (localStorage) win over the server push — the server
      // is just filling in keys we don't have locally yet.
      // Exception: exec_perm_* and fetch_perm_* always take the server value
      // because the gatekeeper is the authoritative owner of those lists.
      mergeClientSettings: (updates) => set(s => {
        const merged: SettingsValues = { ...s.clientSettings };
        for (const [k, v] of Object.entries(updates)) {
          if (k.startsWith('exec_perm_') || k.startsWith('fetch_perm_')) {
            merged[k] = v; // gatekeeper is authoritative
          } else if (!(k in s.clientSettings)) {
            merged[k] = v; // fill in missing keys only
          }
          // otherwise keep the locally-persisted value
        }
        return { clientSettings: merged };
      }),

      setServerSettings: (updates) => set(s => ({
        serverSettings: { ...s.serverSettings, ...updates },
      })),

      setServerSettingPending: (key, value) => set(s => ({
        serverSettingsPending: { ...s.serverSettingsPending, [key]: value },
      })),
    }),
    {
      name: 'aigent-client-settings',
      partialize: (s) => ({ clientSettings: s.clientSettings }),
    }
  )
);
