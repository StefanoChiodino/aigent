import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../../stores/ui';
import { useSettingsStore } from '../../stores/settings';
import { useConnectionStore } from '../../stores/connection';
import { SETTINGS_SCHEMA } from '../../lib/settings-schema';
import type { SettingDef } from '../../lib/settings-schema';
import { SettingControl } from './SettingControl';

export function SettingsModal() {
  const settingsOpen = useUIStore(s => s.settingsOpen);
  const setSettingsOpen = useUIStore(s => s.setSettingsOpen);
  const availableTools = useUIStore(s => s.availableTools);
  const getClientSetting = useSettingsStore(s => s.getClientSetting);
  const setClientSetting = useSettingsStore(s => s.setClientSetting);
  const serverSettings = useSettingsStore(s => s.serverSettings);
  const setServerSettingPending = useSettingsStore(s => s.setServerSettingPending);
  const send = useConnectionStore(s => s.send);

  const groups = useMemo(() => {
    const map = new Map<string, SettingDef[]>();
    for (const def of SETTINGS_SCHEMA) {
      if (!map.has(def.group)) map.set(def.group, []);
      map.get(def.group)!.push(def);
    }
    return map;
  }, []);

  const groupNames = useMemo(() => Array.from(groups.keys()), [groups]);
  const [activeGroup, setActiveGroup] = useState<string>(groupNames[0] ?? '');
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [settingsOpen, setSettingsOpen]);

  function showToast() {
    setToastVisible(true);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      setToastVisible(false);
      toastTimerRef.current = null;
    }, 2000);
  }

  function handleChange(def: SettingDef, value: boolean | number | string) {
    if (def.scope === 'client') {
      setClientSetting(def.key, value);
      showToast();
    } else {
      setServerSettingPending(def.key, value);
      send({ type: 'message', content: '/set-env ' + JSON.stringify({ [def.key]: value }) });
      showToast();
    }
  }

  // Tool summarize list
  const summarizeToolsRaw = String(getClientSetting('tools_summarizeTools') ?? '[]');
  let summarizeTools: string[] = [];
  try { summarizeTools = JSON.parse(summarizeToolsRaw) as string[]; } catch { /* empty */ }

  function toggleTool(toolName: string) {
    const next = summarizeTools.includes(toolName)
      ? summarizeTools.filter(t => t !== toolName)
      : [...summarizeTools, toolName];
    setClientSetting('tools_summarizeTools', JSON.stringify(next));
  }

  return (
    <div
      id="settings-overlay"
      className={settingsOpen ? '' : 'hidden'}
      onClick={e => { if (e.target === e.currentTarget) setSettingsOpen(false); }}
    >
      <div id="settings-modal">
        <div id="settings-header">
          <span>Settings</span>
          <button id="settings-close" onClick={() => setSettingsOpen(false)}>×</button>
        </div>
        <div id="settings-toast" className={toastVisible ? '' : 'hidden'}>Saved</div>
        <div id="settings-layout">
          <nav id="settings-nav">
            {groupNames.map(name => (
              <button
                key={name}
                className={`settings-nav-item${name === activeGroup ? ' active' : ''}`}
                data-group={name}
                onClick={() => setActiveGroup(name)}
              >
                {name}
              </button>
            ))}
          </nav>
          <div id="settings-body">
            {groupNames.map(name => {
              const defs = groups.get(name)!;
              const isActive = name === activeGroup;
              return (
                <div
                  key={name}
                  className={`settings-group${isActive ? '' : ' hidden'}`}
                >
                  <div className="settings-group-label">{name}</div>
                  {defs.map(def => {
                    const value = def.scope === 'client'
                      ? getClientSetting(def.key)
                      : (serverSettings[def.key] ?? def.default ?? '');
                    const isStacked = def.type === 'string-list';
                    return (
                      <div key={def.key} className={`settings-row${isStacked ? ' settings-row--stacked' : ''}`}>
                        <div className="settings-row-label">
                          <div className="label-text">{def.label}</div>
                          {def.desc && <div className="label-desc">{def.desc}</div>}
                        </div>
                        <div className="settings-row-control">
                          <SettingControl
                            def={def}
                            value={value}
                            onChange={v => handleChange(def, v)}
                          />
                        </div>
                      </div>
                    );
                  })}

                  {name === 'Context' && availableTools.length > 0 && (
                    <div className="settings-row settings-row--stacked">
                      <div className="settings-row-label">
                        <div className="label-text">Tool list</div>
                        <div className="label-desc">
                          In allowlist mode: checked tools get summarized. In blocklist mode: checked tools are never summarized.
                        </div>
                      </div>
                      <div className="settings-tool-checklist">
                        {availableTools.map(tool => (
                          <label key={tool} className="settings-tool-check-item">
                            <input
                              type="checkbox"
                              checked={summarizeTools.includes(tool)}
                              onChange={() => toggleTool(tool)}
                            />
                            {tool}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
