import React from 'react';
import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';

function fmtCtx(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M';
  if (tokens >= 1_000) return (tokens / 1_000).toFixed(0) + 'k';
  return String(tokens);
}

export function Header() {
  const status = useConnectionStore(s => s.status);
  const usage = useChatStore(s => s.usage);
  const tasks = useChatStore(s => s.tasks);
  const { setSettingsOpen, setCtxInspectorOpen } = useUIStore.getState();

  const running = tasks.filter(t => t.status === 'running').length;
  const cost = usage.cost ?? 0;
  const ctxUsed = usage.contextTokens ?? 0;
  const ctxPct = Math.min(100, Math.round((ctxUsed / 200_000) * 100));
  const ctxColor = ctxPct > 80 ? 'var(--error)' : ctxPct > 60 ? 'var(--warning)' : 'var(--accent)';

  const handleCtxClick = () => {
    setCtxInspectorOpen(true);
  };

  return (
    <div id="header-wrap">
      <header id="header">
        <div id="header-left">
          <span id="logo">aigent</span>
          <span id="conn-badge" className={`badge ${status}`}>{status}</span>
          <span id="task-badge" className={`badge${running > 0 ? '' : ' hidden'}`}>{running} task{running > 1 ? 's' : ''}</span>
        </div>
        <div id="header-right">
          {cost > 0 && (
            <span id="cost-badge" className="badge">
              {cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`}
            </span>
          )}
          {ctxUsed > 0 && (
            <div id="ctx-meter-wrap" className="has-tip" data-tip={`${fmtCtx(ctxUsed)} tokens`} onClick={handleCtxClick} style={{ cursor: 'pointer' }}>
              <div id="ctx-meter">
                <div id="ctx-fill" style={{ width: `${ctxPct}%`, background: ctxColor }} />
              </div>
              <span id="ctx-label">{fmtCtx(ctxUsed)}</span>
            </div>
          )}
          <button
            id="settings-btn"
            className="icon-btn has-tip"
            data-tip="Settings"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
      </header>
    </div>
  );
}
