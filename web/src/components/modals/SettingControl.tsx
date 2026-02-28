import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { SettingDef } from '../../lib/settings-schema';

interface SettingControlProps {
  def: SettingDef;
  value: boolean | number | string;
  onChange: (v: boolean | number | string) => void;
}

function StringListTextarea({ value, onChange }: { value: boolean | number | string; onChange: (v: string) => void }) {
  const toText = (v: typeof value) => {
    try { return (JSON.parse(String(v)) as string[]).join('\n'); } catch { return ''; }
  };
  const [text, setText] = useState(() => toText(value));
  const focused = useRef(false);
  const dirty = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const textRef = useRef(text);
  textRef.current = text;
  const dirtyRef = useRef(dirty.current);
  dirtyRef.current = dirty.current;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const commit = useCallback((t: string) => {
    const arr = t.split('\n').map(s => s.trim()).filter(Boolean);
    onChangeRef.current(JSON.stringify(arr));
  }, []);

  // Sync from parent when external value changes (e.g. server push),
  // but only when the user isn't actively editing.
  // Also detect stale focus: if our ref says focused but the DOM element
  // doesn't actually have focus (e.g. modal was hidden via CSS without
  // firing blur), reset the flag so we accept the server value.
  useEffect(() => {
    if (focused.current && textareaRef.current && document.activeElement !== textareaRef.current) {
      focused.current = false;
      dirty.current = false;
    }
    if (!focused.current) {
      setText(toText(value));
      dirty.current = false;
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Commit unsaved edits on unmount — but only if the user actually changed something.
  useEffect(() => () => {
    if (dirtyRef.current) commit(textRef.current);
  }, [commit]);

  return (
    <textarea
      ref={textareaRef}
      className="settings-string-list"
      rows={8}
      spellCheck={false}
      value={text}
      onFocus={() => { focused.current = true; }}
      onChange={e => { setText(e.target.value); dirty.current = true; }}
      onBlur={() => {
        focused.current = false;
        if (dirty.current) {
          commit(text);
          dirty.current = false;
        }
      }}
    />
  );
}

export function SettingControl({ def, value, onChange }: SettingControlProps) {
  switch (def.type) {
    case 'toggle':
      return (
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={value as boolean}
            onChange={e => onChange(e.target.checked)}
          />
          <span className="settings-toggle-track" />
        </label>
      );

    case 'select':
      return (
        <select
          className="settings-select"
          value={String(value)}
          onChange={e => onChange(e.target.value)}
        >
          {(def.options ?? []).map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      );

    case 'number':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="number"
            className="settings-number"
            value={value as number}
            min={def.min}
            max={def.max}
            step={def.step}
            onChange={e => { const n = Number(e.target.value); if (!isNaN(n)) onChange(n); }}
          />
          {def.unit && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{def.unit}</span>}
        </span>
      );

    case 'text':
      return (
        <input
          type="text"
          className="settings-text"
          value={String(value)}
          placeholder={def.placeholder}
          onChange={e => onChange(e.target.value)}
        />
      );

    case 'password':
      return (
        <input
          type="password"
          className="settings-text"
          value={String(value)}
          placeholder={def.placeholder}
          onChange={e => onChange(e.target.value)}
        />
      );

    case 'slider':
      return (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range"
            value={value as number}
            min={def.min}
            max={def.max}
            step={def.step}
            onChange={e => onChange(Number(e.target.value))}
          />
          <span style={{ fontSize: 12 }}>{value}{def.unit ?? ''}</span>
        </span>
      );

    case 'string-list':
      return <StringListTextarea value={value} onChange={onChange} />;

    default:
      return (
        <input
          type="text"
          className="settings-text"
          value={String(value)}
          onChange={e => onChange(e.target.value)}
        />
      );
  }
}
