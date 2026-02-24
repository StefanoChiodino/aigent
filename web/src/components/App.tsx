import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDemoMode } from '../demo/useDemoMode';
import { useUIStore } from '../stores/ui';
import { useChatStore } from '../stores/chat';
import { useTTS } from '../hooks/useTTS';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { InputArea } from './InputArea';
import { PermissionModal } from './modals/PermissionModal';
import { SettingsModal } from './modals/SettingsModal';
import { ContextInspector } from './modals/ContextInspector';
import { TaskResultPanel } from './modals/TaskResultPanel';
import { ShortcutsModal } from './modals/ShortcutsModal';

export function App() {
  useWebSocket();
  useDemoMode();

  // Wire TTS auto-speak to streaming text changes
  const { flushStream } = useTTS();
  const flushRef = useRef(flushStream);
  flushRef.current = flushStream;
  useEffect(() => {
    let prev = '';
    let wasActive = false;
    return useChatStore.subscribe((s) => {
      const text = s.streaming.text;
      const active = s.streaming.active;
      if (text && text !== prev) { prev = text; flushRef.current(); }
      if (wasActive && !active) flushRef.current(true); // final flush
      if (!text) prev = '';
      wasActive = active;
    });
  }, []);

  const isLoading = useUIStore(s => s.isLoading);

  // Sync data-working attribute on body for CSS / test selectors
  useEffect(() => {
    if (isLoading) {
      document.body.setAttribute('data-working', '');
    } else {
      document.body.removeAttribute('data-working');
    }
  }, [isLoading]);

  return (
    <div id="app">
      <div className="bokeh" aria-hidden="true">
        <span className="b1" /><span className="b2" /><span className="b3" />
        <span className="b4" /><span className="b5" /><span className="b6" />
        <span className="b7" />
      </div>
      <Header />
      <div id="body">
        <Sidebar />
        <div id="main-col">
          <ChatArea />
          <InputArea />
        </div>
      </div>
      {createPortal(<PermissionModal />, document.body)}
      {createPortal(<SettingsModal />, document.body)}
      {createPortal(<ContextInspector />, document.body)}
      {createPortal(<TaskResultPanel />, document.body)}
      {createPortal(<ShortcutsModal />, document.body)}
    </div>
  );
}
