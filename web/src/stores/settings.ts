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

function buildSettingsPayload(key: string, value: boolean | number | string, all: SettingsValues): Record<string, unknown> {
  const getList = (k: string): string[] => {
    try { return JSON.parse(String(all[k] ?? '[]')) as string[]; } catch { return []; }
  };
  if (key.startsWith('exec_perm_')) {
    return {
      exec_permissions: {
        alwaysAllow: getList('exec_perm_alwaysAllow'),
        prompt: getList('exec_perm_prompt'),
        deny: getList('exec_perm_deny'),
      },
    };
  }
  if (key.startsWith('fetch_perm_')) {
    return {
      fetch_permissions: {
        alwaysAllow: getList('fetch_perm_alwaysAllow'),
        prompt: getList('fetch_perm_prompt'),
        deny: getList('fetch_perm_deny'),
      },
    };
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

      mergeClientSettings: (updates) => set(s => ({
        clientSettings: { ...s.clientSettings, ...updates },
      })),

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
