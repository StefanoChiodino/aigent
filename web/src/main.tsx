import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { useChatStore } from './stores/chat';
import { useUIStore } from './stores/ui';
import { useVoiceStore } from './stores/voice';
import { useConnectionStore } from './stores/connection';
import { useSettingsStore } from './stores/settings';
import '../style.css';

// Expose test reset hook so Playwright shared-page helper can clear Zustand state
// between tests without a full page reload.
(window as Record<string, unknown>).__testResetStores = () => {
  const chat = useChatStore.getState();
  chat.clearMessages();
  chat.setTasks([]);
  chat.setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  chat.endStream();

  const ui = useUIStore.getState();
  ui.setError(null);
  ui.setLoading(false);
  ui.setSettingsOpen(false);
  ui.setShortcutsOpen(false);
  ui.setCtxInspectorOpen(false);
  ui.setModelPickerOpen(false);
  ui.setTaskResultTask(null);
  ui.setContextBreakdown(null);
  ui.clearAttachments();
  // Clear permission queue
  useUIStore.setState({ permQueue: [], permShowing: false });

  const voice = useVoiceStore.getState();
  voice.setMicState('idle');
  voice.setMicSticky(false);
  voice.setVadActive(false);
  voice.setTtsPlaying(false);
  voice.setTtsAutoSpeak(false);

  // Reset connection store
  useConnectionStore.getState().resetReconnect();

  // Reset settings store (clear pending changes, preserve server-synced state)
  useSettingsStore.setState({ serverSettingsPending: {} });

  // Clear persisted localStorage to prevent test-modified settings from leaking
  localStorage.removeItem('aigent-client-settings');

  // Reset local React component state (micCapped, hasMicText, etc.)
  window.dispatchEvent(new Event('__test_reset_input'));
};

// Expose store setter for context inspector tests that need direct store access
(window as Record<string, unknown>).__testSetCtxInspectorOpen = (open: boolean) => {
  useUIStore.getState().setCtxInspectorOpen(open);
};

// Expose stores for e2e tests
(window as Record<string, unknown>).__zustand_ui = useUIStore;
(window as Record<string, unknown>).__zustand_chat = useChatStore;
(window as Record<string, unknown>).__zustand_voice = useVoiceStore;
(window as Record<string, unknown>).__zustand_settings = useSettingsStore;

// Return system message contents added after a given timestamp (ISO string).
// Used by permission routing tests to check only messages caused by the test action.
(window as Record<string, unknown>).__testGetSystemMessagesSince = (sinceMs: number) => {
  return useChatStore.getState().messages
    .filter(m => m.role === 'system' && new Date(m.timestamp).getTime() >= sinceMs)
    .map(m => m.content);
};

const rootEl = document.getElementById('root')!;
createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
