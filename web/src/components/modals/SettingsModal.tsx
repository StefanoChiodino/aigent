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
  const clientSettings = useSettingsStore(s => s.clientSettings);
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
  const [search, setSearch] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && settingsOpen) setSettingsOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [settingsOpen, setSettingsOpen]);

  useEffect(() => {
    if (settingsOpen) {
      setSearch('');
      // Defer focus so the modal is visible before we try to focus
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [settingsOpen]);

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

  function getClientValue(key: string): boolean | number | string {
    if (key in clientSettings) return clientSettings[key]!;
    const schema = SETTINGS_SCHEMA.find(d => d.key === key && d.scope === 'client');
    return schema?.default ?? '';
  }

  // Tool summarize list
  const summarizeToolsRaw = String(getClientValue('tools_summarizeTools') ?? '[]');
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
          <div id="settings-toast" className={toastVisible ? '' : 'hidden'}>Saved</div>
          <button id="settings-close" onClick={() => setSettingsOpen(false)}>×</button>
        </div>
        <div id="settings-layout">
          <nav id="settings-nav">
            <div id="settings-search-wrap">
              <input
                ref={searchRef}
                id="settings-search"
                type="search"
                placeholder="Search settings…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {search === '' && groupNames.map(name => (
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
            {search !== '' ? (() => {
              const term = search.toLowerCase();
              const matched = SETTINGS_SCHEMA.filter(def =>
                def.label.toLowerCase().includes(term) ||
                (def.desc ?? '').toLowerCase().includes(term) ||
                def.key.toLowerCase().includes(term)
              );
              if (matched.length === 0) {
                return <div className="settings-search-empty">No settings match <em>"{search}"</em></div>;
              }
              // Group matched results under their group headings
              const seenGroups = new Set<string>();
              return (
                <div className="settings-group">
                  {matched.map(def => {
                    const showGroupLabel = !seenGroups.has(def.group);
                    if (showGroupLabel) seenGroups.add(def.group);
                    const value = def.scope === 'client'
                      ? getClientValue(def.key)
                      : (serverSettings[def.key] ?? def.default ?? '');
                    const isStacked = def.type === 'string-list';
                    return (
                      <React.Fragment key={def.key}>
                        {showGroupLabel && (
                          <div className="settings-group-label settings-group-label--search">{def.group}</div>
                        )}
                        <div className={`settings-row${isStacked ? ' settings-row--stacked' : ''}${def.danger ? ' settings-row--danger' : ''}`}>
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
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })() : groupNames.map(name => {
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
                      ? getClientValue(def.key)
                      : (serverSettings[def.key] ?? def.default ?? '');
                    const isStacked = def.type === 'string-list';
                    return (
                      <div key={def.key} className={`settings-row${isStacked ? ' settings-row--stacked' : ''}${def.danger ? ' settings-row--danger' : ''}`}>
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
