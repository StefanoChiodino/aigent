import React, { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connection';
import { useChatStore } from '../stores/chat';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import type { BackgroundTaskInfo } from '../types';
import { CAP_INFO, GRANT_DESCRIPTIONS } from '../lib/capabilities';
import { listAudioDevices, type AudioDevice } from '../lib/audio-devices';

function modelDisplayName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  return id.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}


function TaskItem({ task, onOpen }: { task: BackgroundTaskInfo; onOpen: () => void }) {
  const isUserPullDone = task.delivery === 'user-pull' &&
    (task.status === 'completed' || task.status === 'failed') && !!task.result;
  const statusChar =
    task.status === 'running' ? '▶' :
    task.status === 'completed' ? '✓' :
    task.status === 'cancelled' ? '—' : '✗';

  const parts: string[] = [];
  if (task.model) parts.push(modelDisplayName(task.model));
  if (task.inputTokens !== undefined || task.outputTokens !== undefined) {
    parts.push(`${((task.inputTokens ?? 0) + (task.outputTokens ?? 0)).toLocaleString()} tok`);
  }
  if (task.cost !== undefined && task.cost > 0) {
    parts.push(task.cost < 0.01 ? `$${task.cost.toFixed(3)}` : `$${task.cost.toFixed(2)}`);
  }

  return (
    <div
      className={`task-item task-item-clickable${isUserPullDone ? ' task-item-pull' : ''}`}
      title="Click to inspect task"
      onClick={onOpen}
      style={{ cursor: 'pointer' }}
    >
      <span className={`task-status ${task.status}`} title={task.status}>{statusChar}</span>
      <span className="task-desc" title={task.description}>{task.description}</span>
      {parts.length > 0 && <div className="task-meta">{parts.join(' · ')}</div>}
    </div>
  );
}

function DevicePicker({ kind, value, onChange }: {
  kind: 'audioinput' | 'audiooutput';
  value: string;
  onChange: (id: string) => void;
}) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void listAudioDevices(kind).then(setDevices);
    // Re-enumerate when devices change (plug/unplug)
    const cb = () => void listAudioDevices(kind).then(setDevices);
    navigator.mediaDevices?.addEventListener('devicechange', cb);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', cb);
  }, [kind]);

  // Refresh device list when dropdown opens (labels may appear after mic permission)
  useEffect(() => {
    if (open) void listAudioDevices(kind).then(setDevices);
  }, [open, kind]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // If the stored device ID is no longer in the enumerated list, reset to default.
  // This handles browsers regenerating device IDs across sessions.
  useEffect(() => {
    if (devices.length > 0 && value && !devices.some(d => d.deviceId === value)) {
      onChange('');
    }
  }, [devices, value, onChange]);

  const selected = devices.find(d => d.deviceId === value) ?? devices[0];

  return (
    <div className="sb-device-section" ref={ref}>
      <button
        className={`sb-device-btn${open ? ' open' : ''}`}
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
        title={selected?.label ?? 'Default'}
      >
        <span className="sb-device-label">{selected?.label ?? 'Default'}</span>
        <span className="sb-model-chevron">▾</span>
      </button>
      <div className={`sb-device-picker${open ? '' : ' hidden'}`}>
        {devices.map(d => (
          <button
            key={d.deviceId}
            className={`sb-model-option${d.deviceId === value ? ' active' : ''}`}
            title={d.label}
            onClick={() => { onChange(d.deviceId); setOpen(false); }}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Sidebar() {
  const send = useConnectionStore(s => s.send);

  const usage = useChatStore(s => s.usage);
  const tasks = useChatStore(s => s.tasks);

  const capsList = useUIStore(s => s.capsList);
  const ttsAvailable = useUIStore(s => s.ttsAvailable);
  const sttAvailable = useUIStore(s => s.sttAvailable);
  const extensionConnected = useUIStore(s => s.extensionConnected);
  const modelName = useUIStore(s => s.modelName);
  const availableModels = useUIStore(s => s.availableModels);
  const thinkingLevel = useUIStore(s => s.thinkingLevel);
  const lastEffortLevel = useUIStore(s => s.lastEffortLevel);
  const shortMode = useUIStore(s => s.shortMode);
  const setCtxInspectorOpen = useUIStore(s => s.setCtxInspectorOpen);
  const setTaskResultTask = useUIStore(s => s.setTaskResultTask);
  const setTasksInspectorOpen = useUIStore(s => s.setTasksInspectorOpen);
  const modelPickerOpen = useUIStore(s => s.modelPickerOpen);
  const setModelPickerOpen = useUIStore(s => s.setModelPickerOpen);

  const setClientSetting = useSettingsStore(s => s.setClientSetting);


  const ttsAutoSpeak = useVoiceStore(s => s.ttsAutoSpeak);
  const ttsRatePct = useVoiceStore(s => s.ttsRatePct);
  const setTtsAutoSpeak = useVoiceStore(s => s.setTtsAutoSpeak);
  const setTtsRatePct = useVoiceStore(s => s.setTtsRatePct);
  const micDeviceId = useVoiceStore(s => s.micDeviceId);
  const speakerDeviceId = useVoiceStore(s => s.speakerDeviceId);
  const setMicDeviceId = useVoiceStore(s => s.setMicDeviceId);
  const setSpeakerDeviceId = useVoiceStore(s => s.setSpeakerDeviceId);

  const ctxUsed = usage.contextTokens ?? 0;
  const cost = usage.cost ?? 0;
  const ctxPct = ctxUsed > 0 ? Math.min(100, Math.round((ctxUsed / 200_000) * 100)) : 0;
  const ctxColor = ctxPct > 80 ? 'var(--error)' : ctxPct > 60 ? 'var(--warning)' : 'var(--accent)';
  const tokStr = ctxUsed >= 1_000_000
    ? (ctxUsed / 1_000_000).toFixed(1) + 'M'
    : ctxUsed >= 1_000
    ? Math.round(ctxUsed / 1_000) + 'k'
    : (ctxUsed > 0 ? String(ctxUsed) : '');

  const reasoningOn = thinkingLevel !== 'off';
  const activeLevel = reasoningOn ? thinkingLevel : lastEffortLevel;
  const effortLevels = ['low', 'medium', 'high', 'max'];

  const modelPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (!modelPickerRef.current?.contains(e.target as Node)) setModelPickerOpen(false);
    };
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [modelPickerOpen, setModelPickerOpen]);

  const openCtxInspector = () => {
    setCtxInspectorOpen(true);
  };

  return (
    <aside id="sidebar">
      <div id="sidebar-panel">

        {/* Tasks */}
        <div className="sidebar-section" id="sb-tasks-section">
          <div className="sidebar-label" style={{ cursor: 'pointer' }} onClick={() => setTasksInspectorOpen(true)}>Tasks <span className="ctx-open-hint">&rsaquo;</span></div>
          <div id="sb-tasks-list">
            {tasks.length === 0
              ? <span className="sidebar-value" style={{ fontSize: 11 }}>none</span>
              : [...tasks].reverse().map(t => (
                  <TaskItem key={t.id} task={t} onOpen={() => setTaskResultTask(t)} />
                ))
            }
          </div>
        </div>

        {/* Model picker */}
        <div className="sidebar-section sb-model-section" ref={modelPickerRef}>
          <div className="sidebar-label">Model</div>
          <button
            id="sb-model-btn"
            className={`sb-model-btn${modelPickerOpen ? ' open' : ''}`}
            onClick={e => { e.stopPropagation(); setModelPickerOpen(!modelPickerOpen); }}
          >
            <span id="sb-model-value">{modelName ? modelDisplayName(modelName) : '--'}</span>
            <span className="sb-model-chevron">▾</span>
          </button>
          <div id="sb-model-picker" className={`sb-model-picker${modelPickerOpen ? '' : ' hidden'}`}>
            {availableModels.map((mid: string) => (
              <button
                key={mid}
                className={`sb-model-option${mid === modelName ? ' active' : ''}`}
                title={mid}
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
        </div>

        {/* Reasoning */}
        <div className="sidebar-section">
          <div className="sidebar-label">Reasoning</div>
          {(() => {
            // Only Opus models support extended thinking
            const supportsThinking = !!modelName && /opus/i.test(modelName);
            return <>
          <div className="sb-reasoning-controls">
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>Extended thinking</span>
            <button
              id="sb-reasoning-toggle"
              className={`sb-toggle${reasoningOn ? ' on' : ''}${!supportsThinking ? ' disabled' : ''}`}
              disabled={!supportsThinking}
              title={!supportsThinking ? 'Reasoning requires an Opus model' : undefined}
              onClick={() => {
                const nextOff = reasoningOn;
                send({ type: 'message', content: nextOff ? '/reasoning off' : '/reasoning on' });
                setClientSetting('AIGENT_THINKING', nextOff ? 'off' : (lastEffortLevel || 'high'));
              }}
            >
              {reasoningOn ? 'ON' : 'OFF'}
            </button>
          </div>
          {!supportsThinking && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              Requires Opus model
            </div>
          )}
          <div id="sb-effort-pills" className={`sb-pills${!reasoningOn || !supportsThinking ? ' disabled' : ''}`} style={{ marginTop: 6 }}>
            {effortLevels.map(level => (
              <button
                key={level}
                className={`sb-pill${activeLevel === level ? ' active' : ''}`}
                data-level={level}
                onClick={() => {
                  send({ type: 'message', content: `/effort ${level}` });
                  setClientSetting('AIGENT_THINKING', level);
                }}
              >
                {level}
              </button>
            ))}
          </div>
            </>;
          })()}
        </div>

        {/* Context meter */}
        <div
          id="sb-ctx-meter"
          className="sidebar-section ctx-meter-section"
          style={{ cursor: 'pointer' }}
          onClick={openCtxInspector}
        >
          <div className="sidebar-label">Context <span className="ctx-open-hint">›</span></div>
          <div className="sb-ctx-bar">
            <div id="sb-ctx-fill" style={{ width: `${ctxPct}%`, background: ctxColor }} />
            <div id="sb-ctx-label">{tokStr}</div>
          </div>
          <div id="sb-ctx-tokens" className="sidebar-value" style={{ fontSize: 11, marginBottom: 2 }}>{ctxUsed > 0 ? `${tokStr} / 200k` : '--'}</div>
          <div id="sb-cost-value" className="sidebar-value" style={{ fontSize: 11 }}>
            {cost > 0 ? (cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`) : '$0.00'}
          </div>
        </div>

        {/* Speak */}
        <div className="sidebar-section">
          <div className="sidebar-label">Speak</div>
          {(() => {
            const speakMode = shortMode ? 'short' : ttsAutoSpeak ? 'on' : 'off';
            const setSpeakMode = (mode: 'off' | 'on' | 'short') => {
              setTtsAutoSpeak(mode !== 'off');
              const wantShort = mode === 'short';
              if (wantShort !== shortMode) {
                send({ type: 'message', content: wantShort ? '/short on' : '/short off' });
                setClientSetting('AIGENT_SHORT', wantShort);
              }
            };
            return (
              <div id="sb-speak-pills" className="sb-pills" style={{ marginTop: 4 }}>
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
          <div className="sb-tts-speed" style={{ marginTop: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Rate</span>
            <input
              id="sb-tts-rate"
              type="range"
              min={-50}
              max={100}
              step={5}
              value={ttsRatePct}
              onChange={e => setTtsRatePct(Number(e.target.value))}
            />
            <span id="sb-tts-rate-label">{ttsRatePct >= 0 ? `+${ttsRatePct}%` : `${ttsRatePct}%`}</span>
          </div>
          {ttsAvailable && (
            <div className="sb-device-row" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Speaker</span>
              <DevicePicker kind="audiooutput" value={speakerDeviceId} onChange={setSpeakerDeviceId} />
            </div>
          )}
          {sttAvailable && (
            <div className="sb-device-row" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>Mic</span>
              <DevicePicker kind="audioinput" value={micDeviceId} onChange={setMicDeviceId} />
            </div>
          )}
        </div>


        {/* Capabilities */}
        <div className="sidebar-section">
          <div className="sidebar-label">Capabilities</div>
          <div id="sb-caps-list">
            {Object.keys(capsList).length === 0 && !ttsAvailable && !sttAvailable && !extensionConnected
              ? <span className="sidebar-value" style={{ fontSize: 11 }}>--</span>
              : <>
                  {Object.entries(capsList).map(([cap, info]) => {
                    const ci = CAP_INFO[cap];
                    const label = ci?.label ?? cap;
                    const desc = ci?.description ?? cap;
                    const grantDesc = GRANT_DESCRIPTIONS[info.grant] ?? info.grant;
                    const tooltip = info.available
                      ? `${desc} — ${grantDesc}`
                      : `${desc} — ${grantDesc} (not yet wired up)`;
                    const grantLabel = info.grant === 'prompt' ? '?' : info.grant.slice(0, 3);
                    return (
                      <div key={cap} className={`cap-item${info.available ? '' : ' cap-unavailable'}`} title={tooltip}>
                        <span className={`cap-grant ${info.grant}`} title={grantDesc}>
                          {grantLabel}
                        </span>
                        <span className="cap-name">{label}</span>
                      </div>
                    );
                  })}
                  {ttsAvailable && (
                    <div className="cap-item" title="Text-to-speech via edge-tts server">
                      <span className="cap-grant allow" title="Available">on</span>
                      <span className="cap-name">TTS</span>
                    </div>
                  )}
                  {sttAvailable && (
                    <div className="cap-item" title="Speech-to-text via Whisper server">
                      <span className="cap-grant allow" title="Available">on</span>
                      <span className="cap-name">STT</span>
                    </div>
                  )}
                  {extensionConnected && (
                    <div className="cap-item" title="Chrome extension connected — browser tools available">
                      <span className="cap-grant allow" title="Connected">on</span>
                      <span className="cap-name">Browser</span>
                    </div>
                  )}
                </>
            }
          </div>
        </div>


      </div>
    </aside>
  );
}
