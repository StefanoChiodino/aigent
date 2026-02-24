import React, { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connection';
import { useChatStore } from '../stores/chat';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import type { MountInfo, BackgroundTaskInfo } from '../types';

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

function MountItem({ mount }: { mount: MountInfo }) {
  const [remaining, setRemaining] = useState<number | null>(
    mount.expiresAt ? mount.expiresAt - Date.now() : null
  );

  useEffect(() => {
    if (!mount.expiresAt) return;
    const id = setInterval(() => setRemaining(mount.expiresAt! - Date.now()), 5_000);
    return () => clearInterval(id);
  }, [mount.expiresAt]);

  const parts = mount.hostPath.replace(/\/$/, '').split('/').filter(Boolean);
  const pct = mount.expiresAt && mount.durationMinutes
    ? Math.max(0, Math.min(100, ((mount.expiresAt - Date.now()) / (mount.durationMinutes * 60_000)) * 100))
    : null;

  return (
    <div className="mount-item">
      <div className="mount-item-row">
        <span className={`mount-mode ${mount.mode}`}>{mount.mode}</span>
        <span className="mount-path" title={mount.hostPath}>
          {parts.length >= 2 ? (
            <>
              <span className="mount-path-parent">{parts[parts.length - 2]}/</span>
              <span>{parts[parts.length - 1]}</span>
            </>
          ) : mount.hostPath}
        </span>
        {remaining !== null && (
          <span className="mount-expiry-badge" title={`Expires at ${new Date(mount.expiresAt!).toLocaleTimeString()}`}>
            {fmtRemaining(remaining)}
          </span>
        )}
      </div>
      {pct !== null && (
        <div className="mount-timer-bar">
          <div className="mount-timer-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
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
      className={`task-item${isUserPullDone ? ' task-item-pull' : ''}`}
      title={isUserPullDone ? 'Click to view result' : undefined}
      onClick={isUserPullDone ? onOpen : undefined}
      style={isUserPullDone ? { cursor: 'pointer' } : undefined}
    >
      <span className={`task-status ${task.status}`} title={task.status}>{statusChar}</span>
      <span className="task-desc" title={task.description}>{task.description}</span>
      {parts.length > 0 && <div className="task-meta">{parts.join(' · ')}</div>}
    </div>
  );
}

export function Sidebar() {
  const send = useConnectionStore(s => s.send);

  const usage = useChatStore(s => s.usage);
  const tasks = useChatStore(s => s.tasks);

  const mountsList = useUIStore(s => s.mountsList);
  const capsList = useUIStore(s => s.capsList);
  const modelName = useUIStore(s => s.modelName);
  const availableModels = useUIStore(s => s.availableModels);
  const thinkingLevel = useUIStore(s => s.thinkingLevel);
  const lastEffortLevel = useUIStore(s => s.lastEffortLevel);
  const conciseMode = useUIStore(s => s.conciseMode);
  const setCtxInspectorOpen = useUIStore(s => s.setCtxInspectorOpen);
  const setTaskResultTask = useUIStore(s => s.setTaskResultTask);
  const modelPickerOpen = useUIStore(s => s.modelPickerOpen);
  const setModelPickerOpen = useUIStore(s => s.setModelPickerOpen);

  const setClientSetting = useSettingsStore(s => s.setClientSetting);

  const ttsAutoSpeak = useVoiceStore(s => s.ttsAutoSpeak);
  const ttsRatePct = useVoiceStore(s => s.ttsRatePct);
  const setTtsAutoSpeak = useVoiceStore(s => s.setTtsAutoSpeak);
  const setTtsRatePct = useVoiceStore(s => s.setTtsRatePct);

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
    send({ type: 'context_breakdown_request' });
  };

  return (
    <aside id="sidebar">
      <div id="sidebar-panel">

        {/* Tasks */}
        <div className="sidebar-section" id="sb-tasks-section">
          <div className="sidebar-label">Tasks</div>
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
          <div className="sb-reasoning-controls">
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>Extended thinking</span>
            <button
              id="sb-reasoning-toggle"
              className={`sb-toggle${reasoningOn ? ' on' : ''}`}
              onClick={() => {
                const nextOff = reasoningOn;
                send({ type: 'message', content: nextOff ? '/reasoning off' : '/reasoning on' });
                setClientSetting('AIGENT_THINKING', nextOff ? 'off' : (lastEffortLevel || 'high'));
              }}
            >
              {reasoningOn ? 'ON' : 'OFF'}
            </button>
          </div>
          <div id="sb-effort-pills" className={`sb-pills${!reasoningOn ? ' disabled' : ''}`} style={{ marginTop: 6 }}>
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

        {/* TTS */}
        <div className="sidebar-section">
          <div className="sidebar-label">Voice</div>
          <div className="sb-reasoning-controls">
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>Auto-speak</span>
            <button
              id="sb-tts-toggle"
              className={`sb-toggle${ttsAutoSpeak ? ' on' : ''}`}
              onClick={() => setTtsAutoSpeak(!ttsAutoSpeak)}
            >
              {ttsAutoSpeak ? 'ON' : 'OFF'}
            </button>
          </div>
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
        </div>

        {/* Concise */}
        <div className="sidebar-section">
          <div className="sb-reasoning-controls">
            <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1 }}>Concise mode</span>
            <button
              id="sb-concise-toggle"
              className={`sb-toggle${conciseMode ? ' on' : ''}`}
              onClick={() => {
                const next = !conciseMode;
                send({ type: 'message', content: next ? '/concise on' : '/concise off' });
                setClientSetting('AIGENT_CONCISE', next);
              }}
            >
              {conciseMode ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {/* Mounts */}
        <div className="sidebar-section">
          <div className="sidebar-label">Mounts</div>
          <div id="sb-mounts-list">
            {mountsList.length === 0
              ? <span className="sidebar-value" style={{ fontSize: 11 }}>none</span>
              : mountsList.map(m => <MountItem key={m.hostPath} mount={m} />)
            }
          </div>
        </div>

        {/* Capabilities */}
        <div className="sidebar-section">
          <div className="sidebar-label">Capabilities</div>
          <div id="sb-caps-list">
            {Object.keys(capsList).length === 0
              ? <span className="sidebar-value" style={{ fontSize: 11 }}>--</span>
              : Object.entries(capsList).map(([cap, grant]) => (
                  <div key={cap} className="cap-item">
                    <span className={`cap-grant ${grant}`} title={grant}>
                      {grant === 'prompt' ? '?' : grant.slice(0, 3)}
                    </span>
                    <span className="cap-name" title={cap}>
                      {cap.replace('clipboard', 'clip').replace('screen', 'scr').replace('audio', 'aud')}
                    </span>
                  </div>
                ))
            }
          </div>
        </div>


      </div>
    </aside>
  );
}
