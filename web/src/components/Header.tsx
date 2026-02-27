import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import { usePiP } from '../hooks/usePiP';
import type { MountInfo, BackgroundTaskInfo } from '../types';
import { CAP_INFO, GRANT_DESCRIPTIONS } from '../lib/capabilities';

function modelDisplayName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  return id.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const secs = Math.round(ms / 1000);
  if (secs <= 60) return `${secs} sec`;
  return `${Math.round((ms / 60_000) * 2) / 2} min`;
}

function NarrowMountItem({ mount }: { mount: MountInfo }) {
  const [remaining, setRemaining] = useState<number | null>(
    mount.expiresAt ? mount.expiresAt - Date.now() : null
  );
  useEffect(() => {
    if (!mount.expiresAt) return;
    const id = setInterval(() => setRemaining(mount.expiresAt! - Date.now()), 5_000);
    return () => clearInterval(id);
  }, [mount.expiresAt]);

  const parts = mount.hostPath.replace(/\/$/, '').split('/').filter(Boolean);
  const label = parts.length >= 2
    ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
    : mount.hostPath;

  return (
    <div className="hdr-overflow-item" style={{ fontSize: 11 }}>
      <span className={`mount-mode ${mount.mode}`}>{mount.mode}</span>
      <span style={{ flex: 1 }} title={mount.hostPath}>{label}</span>
      {remaining !== null && (
        <span className="mount-expiry-badge">{fmtRemaining(remaining)}</span>
      )}
    </div>
  );
}

function NarrowTaskItem({ task }: { task: BackgroundTaskInfo }) {
  const statusChar =
    task.status === 'running' ? '▶' :
    task.status === 'completed' ? '✓' :
    task.status === 'cancelled' ? '—' : '✗';

  return (
    <div className="hdr-overflow-item" style={{ fontSize: 11 }}>
      <span className={`task-status ${task.status}`}>{statusChar}</span>
      <span style={{ flex: 1 }} title={task.description}>{task.description}</span>
    </div>
  );
}

function fmtCtx(tokens: number): string {
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + 'M';
  if (tokens >= 1_000) return (tokens / 1_000).toFixed(0) + 'k';
  return String(tokens);
}

export function Header() {
  const send = useConnectionStore(s => s.send);
  const status = useConnectionStore(s => s.status);
  const usage = useChatStore(s => s.usage);
  const tasks = useChatStore(s => s.tasks);

  const modelName = useUIStore(s => s.modelName);
  const availableModels = useUIStore(s => s.availableModels);
  const modelPickerOpen = useUIStore(s => s.modelPickerOpen);
  const setModelPickerOpen = useUIStore(s => s.setModelPickerOpen);
  const thinkingLevel = useUIStore(s => s.thinkingLevel);
  const lastEffortLevel = useUIStore(s => s.lastEffortLevel);
  const shortMode = useUIStore(s => s.shortMode);
  const mountsList = useUIStore(s => s.mountsList);
  const capsList = useUIStore(s => s.capsList);
  const ttsAvailable = useUIStore(s => s.ttsAvailable);
  const sttAvailable = useUIStore(s => s.sttAvailable);
  const { setSettingsOpen, setShortcutsOpen, setCtxInspectorOpen } = useUIStore.getState();

  const setClientSetting = useSettingsStore(s => s.setClientSetting);

  const { openPiP, pipSupported } = usePiP();

  const ttsAutoSpeak = useVoiceStore(s => s.ttsAutoSpeak);
  const ttsRatePct = useVoiceStore(s => s.ttsRatePct);
  const setTtsAutoSpeak = useVoiceStore(s => s.setTtsAutoSpeak);
  const setTtsRatePct = useVoiceStore(s => s.setTtsRatePct);

  const running = tasks.filter(t => t.status === 'running').length;
  const cost = usage.cost ?? 0;
  const ctxUsed = usage.contextTokens ?? 0;
  const ctxPct = Math.min(100, Math.round((ctxUsed / 200_000) * 100));
  const ctxColor = ctxPct > 80 ? 'var(--error)' : ctxPct > 60 ? 'var(--warning)' : 'var(--accent)';

  const reasoningOn = thinkingLevel !== 'off';
  const activeLevel = reasoningOn ? thinkingLevel : lastEffortLevel;
  const effortLevels = ['low', 'medium', 'high', 'max'];

  const handleCtxClick = () => {
    setCtxInspectorOpen(true);
  };

  const [overflowOpen, setOverflowOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Click outside to close model picker
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!modelPickerRef.current?.contains(e.target as Node)) setModelPickerOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [modelPickerOpen, setModelPickerOpen]);

  // Click outside to close overflow
  useEffect(() => {
    if (!overflowOpen) return;
    const handler = (e: MouseEvent) => {
      if (!overflowRef.current?.contains(e.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [overflowOpen]);

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
          {/* Narrow-only: model picker */}
          <div id="hdr-model-wrap" className="hdr-narrow-ctrl" ref={modelPickerRef}>
            <button
              id="hdr-model-btn"
              className="icon-btn"
              onClick={e => { e.stopPropagation(); setModelPickerOpen(!modelPickerOpen); }}
              title={modelName || 'Select model'}
            >
              <span className="hdr-model-label">{modelName ? modelDisplayName(modelName) : '--'}</span>
              <span className="hdr-chevron">▾</span>
            </button>
            {modelPickerOpen && (
              <div id="hdr-model-picker" className="hdr-dropdown">
                {availableModels.map(mid => (
                  <button
                    key={mid}
                    className={`hdr-dropdown-option${mid === modelName ? ' active' : ''}`}
                    onClick={() => {
                      if (mid !== modelName) {
                        send({ type: 'message', content: `/model ${mid}` });
                        setClientSetting('AIGENT_MODEL', mid);
                      }
                      setModelPickerOpen(false);
                    }}
                  >
                    {modelDisplayName(mid)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Narrow-only: reasoning toggle */}
          <button
            id="hdr-reasoning-btn"
            className={`hdr-narrow-ctrl hdr-pill${reasoningOn ? ' on' : ''}`}
            title={`Reasoning: ${reasoningOn ? activeLevel : 'off'}`}
            onClick={() => {
              const nextOff = reasoningOn;
              send({ type: 'message', content: nextOff ? '/reasoning off' : '/reasoning on' });
              setClientSetting('AIGENT_THINKING', nextOff ? 'off' : (lastEffortLevel || 'high'));
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
              <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
            </svg>
            <span>{reasoningOn ? activeLevel.slice(0, 3) : 'off'}</span>
          </button>

          {/* Narrow-only: overflow menu for remaining sidebar sections */}
          <div id="hdr-overflow-wrap" className="hdr-narrow-ctrl" ref={overflowRef}>
            <button
              id="hdr-overflow-btn"
              className={`icon-btn${overflowOpen ? ' active' : ''}`}
              title="More controls"
              onClick={e => { e.stopPropagation(); setOverflowOpen(!overflowOpen); }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="2"/>
                <circle cx="12" cy="12" r="2"/>
                <circle cx="19" cy="12" r="2"/>
              </svg>
            </button>
            {overflowOpen && (
              <div id="hdr-overflow-menu" className="hdr-dropdown">
                {/* Cost (moved from header bar to save space) */}
                {cost > 0 && (
                  <div className="hdr-overflow-section">
                    <div className="hdr-overflow-row">
                      <span>Cost</span>
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`}
                      </span>
                    </div>
                  </div>
                )}

                {/* Reasoning effort pills */}
                <div className="hdr-overflow-section">
                  <div className="hdr-overflow-label">Effort</div>
                  <div className="hdr-effort-pills">
                    {effortLevels.map(level => (
                      <button
                        key={level}
                        className={`sb-pill${activeLevel === level ? ' active' : ''}${!reasoningOn ? ' disabled' : ''}`}
                        onClick={() => {
                          send({ type: 'message', content: `/effort ${level}` });
                          setClientSetting('AIGENT_THINKING', level);
                        }}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Voice */}
                <div className="hdr-overflow-section">
                  <div className="hdr-overflow-label">Voice</div>
                  <div className="hdr-overflow-row">
                    <span>Auto-speak</span>
                    <button
                      className={`sb-toggle${ttsAutoSpeak ? ' on' : ''}`}
                      onClick={() => setTtsAutoSpeak(!ttsAutoSpeak)}
                    >
                      {ttsAutoSpeak ? 'ON' : 'OFF'}
                    </button>
                  </div>
                  <div className="hdr-overflow-row" style={{ marginTop: 4 }}>
                    <span>Rate</span>
                    <input
                      type="range"
                      min={-50} max={100} step={5}
                      value={ttsRatePct}
                      onChange={e => setTtsRatePct(Number(e.target.value))}
                      style={{ flex: 1, margin: '0 6px' }}
                    />
                    <span style={{ fontSize: 10, minWidth: 32 }}>{ttsRatePct >= 0 ? `+${ttsRatePct}%` : `${ttsRatePct}%`}</span>
                  </div>
                </div>

                {/* Short mode */}
                <div className="hdr-overflow-section">
                  <div className="hdr-overflow-row">
                    <span>Short</span>
                    <button
                      className={`sb-toggle${shortMode ? ' on' : ''}`}
                      onClick={() => {
                        const next = !shortMode;
                        send({ type: 'message', content: next ? '/short on' : '/short off' });
                        setClientSetting('AIGENT_SHORT', next);
                      }}
                    >
                      {shortMode ? 'ON' : 'OFF'}
                    </button>
                  </div>
                </div>

                {/* Tasks */}
                {tasks.length > 0 && (
                  <div className="hdr-overflow-section">
                    <div className="hdr-overflow-label">Tasks</div>
                    {[...tasks].reverse().map(t => (
                      <NarrowTaskItem key={t.id} task={t} />
                    ))}
                  </div>
                )}

                {/* Mounts */}
                {mountsList.length > 0 && (
                  <div className="hdr-overflow-section">
                    <div className="hdr-overflow-label">Mounts</div>
                    {mountsList.map(m => (
                      <NarrowMountItem key={m.hostPath} mount={m} />
                    ))}
                  </div>
                )}

                {/* Capabilities */}
                {(Object.keys(capsList).length > 0 || ttsAvailable || sttAvailable) && (
                  <div className="hdr-overflow-section">
                    <div className="hdr-overflow-label">Capabilities</div>
                    {Object.entries(capsList).map(([cap, info]) => {
                      const ci = CAP_INFO[cap];
                      const label = ci?.label ?? cap;
                      const desc = ci?.description ?? cap;
                      const tooltip = info.available
                        ? `${desc} — ${GRANT_DESCRIPTIONS[info.grant] ?? info.grant}`
                        : `${desc} — Not yet implemented`;
                      return (
                        <div key={cap} className={`hdr-overflow-item${info.available ? '' : ' cap-unavailable'}`} style={{ fontSize: 11 }} title={tooltip}>
                          {info.available ? (
                            <span className={`cap-grant ${info.grant}`}>{info.grant === 'prompt' ? '?' : info.grant.slice(0, 3)}</span>
                          ) : (
                            <span className="cap-grant cap-stub">n/a</span>
                          )}
                          <span>{label}</span>
                        </div>
                      );
                    })}
                    {ttsAvailable && (
                      <div className="hdr-overflow-item" style={{ fontSize: 11 }} title="Text-to-speech via edge-tts server">
                        <span className="cap-grant allow">on</span>
                        <span>TTS</span>
                      </div>
                    )}
                    {sttAvailable && (
                      <div className="hdr-overflow-item" style={{ fontSize: 11 }} title="Speech-to-text via Whisper server">
                        <span className="cap-grant allow">on</span>
                        <span>STT</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Settings & shortcuts (moved from header bar) */}
                <div className="hdr-overflow-section hdr-overflow-actions">
                  <button
                    className="hdr-overflow-action-btn"
                    onClick={() => { setOverflowOpen(false); setSettingsOpen(true); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                    Settings
                  </button>
                  <button
                    className="hdr-overflow-action-btn"
                    onClick={() => { setOverflowOpen(false); setShortcutsOpen(true); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <text x="12" y="17" textAnchor="middle" fill="currentColor" stroke="none" fontSize="14" fontWeight="700">?</text>
                    </svg>
                    Shortcuts
                  </button>
                </div>
              </div>
            )}
          </div>

          <button
            id="shortcuts-btn"
            className="icon-btn has-tip hdr-wide-ctrl"
            data-tip="Keyboard shortcuts"
            onClick={() => setShortcutsOpen(true)}
            title="Keyboard shortcuts"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <text x="12" y="17" textAnchor="middle" fill="currentColor" stroke="none" fontSize="14" fontWeight="700">?</text>
            </svg>
            <span className="shortcut-hint">Ctrl+Shift+?</span>
          </button>
          {pipSupported && (
            <button
              className="icon-btn has-tip hdr-wide-ctrl"
              data-tip="Float"
              onClick={() => openPiP()}
              title="Float (PiP)"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <rect x="12" y="9" width="8" height="6" rx="1" />
              </svg>
            </button>
          )}
          <button
            id="settings-btn"
            className="icon-btn has-tip hdr-wide-ctrl"
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
