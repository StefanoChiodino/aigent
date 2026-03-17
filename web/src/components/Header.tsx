import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import { usePiP } from '../hooks/usePiP';
import type { BackgroundTaskInfo } from '../types';
import { CAP_INFO, GRANT_DESCRIPTIONS } from '../lib/capabilities';


function modelDisplayName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  return id.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}


function NarrowTaskItem({ task }: { task: BackgroundTaskInfo }) {
  const statusChar =
    task.status === 'running' ? '▶' :
    task.status === 'completed' ? '✓' :
    task.status === 'cancelled' ? '—' : '✗';

  return (
    <div className="hdr-overflow-item" style={{ fontSize: 11 }}>
      <span className={`task-status ${task.status}`}>{statusChar}</span>
      <span className="hdr-task-desc" title={task.description}>{task.description}</span>
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
  const contextWindow = useUIStore(s => s.contextWindow);
  const modelPickerOpen = useUIStore(s => s.modelPickerOpen);
  const setModelPickerOpen = useUIStore(s => s.setModelPickerOpen);
  const thinkingLevel = useUIStore(s => s.thinkingLevel);
  const lastEffortLevel = useUIStore(s => s.lastEffortLevel);
  const shortMode = useUIStore(s => s.shortMode);
  const capsList = useUIStore(s => s.capsList);
  const ttsAvailable = useUIStore(s => s.ttsAvailable);
  const sttAvailable = useUIStore(s => s.sttAvailable);
  const extensionConnected = useUIStore(s => s.extensionConnected);
  const extensionPath = useUIStore(s => s.extensionPath);
  const vscodeConnected = useUIStore(s => s.vscodeConnected);
  const [extSetupOpen, setExtSetupOpen] = useState(false);
  const extBadgeRef = useRef<HTMLSpanElement>(null);
  const [vscodeSetupOpen, setVscodeSetupOpen] = useState(false);
  const vscodeBadgeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!extSetupOpen) return;
    const handler = (e: MouseEvent) => {
      if (extBadgeRef.current && !extBadgeRef.current.contains(e.target as Node)) {
        setExtSetupOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [extSetupOpen]);
  useEffect(() => {
    if (!vscodeSetupOpen) return;
    const handler = (e: MouseEvent) => {
      if (vscodeBadgeRef.current && !vscodeBadgeRef.current.contains(e.target as Node)) {
        setVscodeSetupOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [vscodeSetupOpen]);
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
  const ctxPct = Math.min(100, Math.round((ctxUsed / contextWindow) * 100));
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
          <span id="logo"><span className="logo-ai">AI</span><span className="logo-dot">·</span>gent</span>
          <span id="conn-badge" className={`conn-icon ${status}`}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
              <circle cx="8" cy="13" r="2.5"/>
              <path d="M3.5 8.5a6.5 6.5 0 0 1 9 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={status === 'connected' ? 1 : 0.25}/>
              <path d="M1 5.5a10 10 0 0 1 14 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity={status === 'connected' ? 1 : 0.25}/>
            </svg>
            <span className="conn-tooltip">
              {status === 'connected' ? 'Backend connected' : status === 'connecting' ? 'Connecting to backend…' : 'Reconnecting to backend…'}
            </span>
          </span>
          <span ref={extBadgeRef} id="ext-badge" className={`conn-icon ${extensionConnected ? 'ext-on' : 'ext-off'}`}
                onClick={(e) => {
                  if (extensionConnected) {
                    navigator.clipboard.writeText('chrome://extensions');
                    const el = e.currentTarget; el.dataset.copied = '1'; setTimeout(() => delete el.dataset.copied, 1500);
                  } else {
                    setExtSetupOpen(!extSetupOpen);
                  }
                }}
                style={{ cursor: 'pointer' }}>
            <svg xmlns="http://www.w3.org/2000/svg" xmlnsXlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48" height="48" width="14" style={{ opacity: extensionConnected ? 1 : 0.3 }}>
              <defs>
                <linearGradient id="a" x1="3.2173" y1="15" x2="44.7812" y2="15" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#d93025" />
                  <stop offset="1" stopColor="#ea4335" />
                </linearGradient>
                <linearGradient id="b" x1="20.7219" y1="47.6791" x2="41.5039" y2="11.6837" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#fcc934" />
                  <stop offset="1" stopColor="#fbbc04" />
                </linearGradient>
                <linearGradient id="c" x1="26.5981" y1="46.5015" x2="5.8161" y2="10.506" gradientUnits="userSpaceOnUse">
                  <stop offset="0" stopColor="#1e8e3e" />
                  <stop offset="1" stopColor="#34a853" />
                </linearGradient>
              </defs>
              <circle cx="24" cy="23.9947" r="12" fill="#fff" />
              <path d="M3.2154,36A24,24,0,1,0,12,3.2154,24,24,0,0,0,3.2154,36ZM34.3923,18A12,12,0,1,1,18,13.6077,12,12,0,0,1,34.3923,18Z" fill="none" />
              <path d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z" fill="url(#a)" />
              <circle cx="24" cy="24" r="9.5" fill="#1a73e8" />
              <path d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z" fill="url(#b)" />
              <path d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z" fill="url(#c)" />
            </svg>
            <span className="conn-tooltip">
              {extensionConnected ? 'Extension connected' : 'Extension not connected — click for setup'}
            </span>
            {!extensionConnected && extSetupOpen && (
            <div id="ext-setup-popup" className="ext-setup-popup">
              <strong>Extension Setup</strong>
              <ol>
                <li>
                  Build the extension:
                  <code className="ext-copy-code">make plugin</code>
                  <span className="ext-copy-btn" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText('make plugin'); const btn = e.currentTarget; btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1200); }} title="Copy">📋</span>
                  <span className="ext-copy-code"> (or <code className="ext-copy-code">make plugin-dev</code> for watch mode)</span>
                  <span className="ext-copy-btn" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText('make plugin-dev'); const btn = e.currentTarget; btn.textContent = '✓'; setTimeout(() => btn.textContent = '📋', 1200); }} title="Copy">📋</span>
                </li>
                <li>Copy this URL and paste in address bar:<br/><code>chrome://extensions</code> <span className="ext-copy-btn" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText('chrome://extensions'); const el = e.currentTarget; el.textContent = '✓'; setTimeout(() => el.textContent = '📋', 1200); }} title="Copy">📋</span></li>
                <li>Enable <b>Developer mode</b> (top-right toggle)</li>
                <li>Click <b>Load unpacked</b></li>
                <li>Navigate to:<br/><code>{extensionPath || 'aigent-extension/dist'}</code> <span className="ext-copy-btn" onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(extensionPath || 'aigent-extension/dist'); const el = e.currentTarget; el.textContent = '✓'; setTimeout(() => el.textContent = '📋', 1200); }} title="Copy">📋</span></li>
              </ol>
            </div>
          )}</span>
            <span ref={vscodeBadgeRef} id="vscode-badge" className={`conn-icon ${vscodeConnected ? 'ext-on' : 'ext-off'}`}
                onClick={(e) => {
                  // Don't show popup by default - just indicate connection status
                  // To see setup instructions, open Settings and look for VSCode extension info
                  // setVscodeSetupOpen(!vscodeSetupOpen);
                }}
                style={{ cursor: 'pointer' }}>
            <svg viewBox="0 0 100 100" width="14" height="14">
              <g style={{ opacity: vscodeConnected ? 1 : 0.3 }}>
                <path d="M96.4614 10.7962L75.8569 0.875542C73.4719 -0.272773 70.6217 0.211611 68.75 2.08333L1.29858 63.5832C-0.515693 65.2373 -0.513607 68.0937 1.30308 69.7452L6.81272 74.754C8.29793 76.1042 10.5347 76.2036 12.1338 74.9905L93.3609 13.3699C96.086 11.3026 100 13.2462 100 16.6667V16.4275C100 14.0265 98.6246 11.8378 96.4614 10.7962Z" fill={vscodeConnected ? "#0065A9" : "gray"}/>
                <path d="M96.4614 89.2038L75.8569 99.1245C73.4719 100.273 70.6217 99.7884 68.75 97.9167L1.29858 36.4169C-0.515693 34.7627 -0.513607 31.9063 1.30308 30.2548L6.81272 25.246C8.29793 23.8958 10.5347 23.7964 12.1338 25.0095L93.3609 86.6301C96.086 88.6974 100 86.7538 100 83.3334V83.5726C100 85.9735 98.6246 88.1622 96.4614 89.2038Z" fill={vscodeConnected ? "#007ACC" : "gray"}/>
                <path d="M75.8578 99.1263C73.4721 100.274 70.6219 99.7885 68.75 97.9166C71.0564 100.223 75 98.5895 75 95.3278V4.67213C75 1.41039 71.0564 -0.223106 68.75 2.08329C70.6219 0.211402 73.4721 -0.273666 75.8578 0.873633L96.4587 10.7807C98.6234 11.8217 100 14.0112 100 16.4132V83.5871C100 85.9891 98.6234 88.1786 96.4586 89.2196L75.8578 99.1263Z" fill={vscodeConnected ? "#1F9CF0" : "gray"}/>
              </g>
            </svg>
            <span className="conn-tooltip">
              {vscodeConnected ? 'VSCode connected' : 'VSCode not connected'}
            </span>
            {!vscodeConnected && vscodeSetupOpen && (
              <div id="vscode-setup-popup" className="ext-setup-popup">
                <strong>VSCode Extension Setup</strong>
                <ol>
                  <li>In VSCode, open the folder:<br/><code>aigent/vscode-extension</code></li>
                  <li>Press <kbd>F5</kbd> (Run → Start Debugging)</li>
                  <li>This opens a new VSCode window with the extension enabled</li>
                  <li>Click the Aigent icon in the status bar to connect</li>
                </ol>
                <p style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)' }}>
                  Tip: Click the icon again to close this popup
                </p>
              </div>
            )}
          </span>
          <span id="task-badge" className={`badge${running > 0 ? '' : ' hidden'}`} title={running > 0 ? `${running} running task${running > 1 ? 's' : ''}` : ''} onClick={() => useUIStore.getState().setTasksInspectorOpen(true)} style={{ cursor: 'pointer' }}>⚡ {running} task{running !== 1 ? 's' : ''}</span>
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
                        send({ type: 'set_model', model: mid });
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
              send({ type: 'set_thinking', enabled: !nextOff });
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
                          send({ type: 'set_effort', level });
                          setClientSetting('AIGENT_THINKING', level);
                        }}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Speak */}
                <div className="hdr-overflow-section">
                  <div className="hdr-overflow-label">Speak</div>
                  {(() => {
                    const speakMode = shortMode ? 'short' : ttsAutoSpeak ? 'on' : 'off';
                    const setSpeakMode = (mode: 'off' | 'on' | 'short') => {
                      setTtsAutoSpeak(mode !== 'off');
                      const wantShort = mode === 'short';
                      if (wantShort !== shortMode) {
                        send({ type: 'set_short', enabled: wantShort });
                        setClientSetting('AIGENT_SHORT', wantShort);
                      }
                    };
                    return (
                      <div className="hdr-effort-pills">
                        {(['off', 'on', 'short'] as const).map(level => (
                          <button
                            key={level}
                            className={`sb-pill${speakMode === level ? ' active' : ''}`}
                            data-speak={level}
                            onClick={() => setSpeakMode(level)}
                          >
                            {level}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
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

                {/* Tasks */}
                {tasks.length > 0 && (
                  <div className="hdr-overflow-section">
                    <div className="hdr-overflow-label">Tasks</div>
                    {[...tasks].reverse().map(t => (
                      <NarrowTaskItem key={t.id} task={t} />
                    ))}
                  </div>
                )}


                {/* Capabilities */}
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
                      <div className="hdr-overflow-item" style={{ fontSize: 11 }} title="Speech-to-text via Parakeet server">
                        <span className="cap-grant allow">on</span>
                        <span>STT</span>
                      </div>
                    )}
                    <div
                      className={`hdr-overflow-item${extensionConnected ? '' : ' cap-ext-off'}`}
                      style={{ fontSize: 11 }}
                      title={extensionConnected ? 'Chrome extension connected' : 'Chrome extension not connected — use sidebar for setup'}
                    >
                      <span className={`cap-grant ${extensionConnected ? 'allow' : 'deny'}`}>
                        {extensionConnected ? 'on' : 'off'}
                      </span>
                      <span>Browser</span>
                    </div>
                  </div>

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
      {status !== 'connected' && (
        <div id="reconnect-banner" role="status" aria-live="polite">
          <span className="reconnect-spinner" aria-hidden="true" />
          <span>{status === 'connecting' ? 'Connecting to server…' : 'Connection lost — reconnecting…'}</span>
        </div>
      )}
    </div>
  );
}
