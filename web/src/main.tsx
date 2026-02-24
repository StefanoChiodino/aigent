import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { useChatStore } from './stores/chat';
import { useUIStore } from './stores/ui';
import { useVoiceStore } from './stores/voice';
import '../style.css';

// Expose test reset hook so Playwright shared-page helper can clear Zustand state
// between tests without a full page reload.
(window as Record<string, unknown>).__testResetStores = () => {
  const chat = useChatStore.getState();
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

  // Reset local React component state (micCapped, hasMicText, etc.)
  window.dispatchEvent(new Event('__test_reset_input'));
};

// Expose store setter for context inspector tests that need direct store access
(window as Record<string, unknown>).__testSetCtxInspectorOpen = (open: boolean) => {
  useUIStore.getState().setCtxInspectorOpen(open);
};

// Expose UI store for attachment preview tests
(window as Record<string, unknown>).__zustand_ui = useUIStore;

// Expose chat message clearing for permission routing tests
(window as Record<string, unknown>).__testClearMessages = () => {
  useChatStore.getState().clearMessages();
};

const rootEl = document.getElementById('root')!;
createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
