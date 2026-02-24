import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useWebSocket } from '../hooks/useWebSocket';
import { useUIStore } from '../stores/ui';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { ChatArea } from './ChatArea';
import { InputArea } from './InputArea';
import { PermissionModal } from './modals/PermissionModal';
import { SettingsModal } from './modals/SettingsModal';
import { ContextInspector } from './modals/ContextInspector';
import { TaskResultPanel } from './modals/TaskResultPanel';

export function App() {
  useWebSocket();

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
    </div>
  );
}
