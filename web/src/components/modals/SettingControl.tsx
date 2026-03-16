import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { SettingDef } from '../../lib/settings-schema';
import { KeyCaptureButton } from '../KeyCaptureButton';
import { useUIStore } from '../../stores/ui';
import { useSettingsStore } from '../../stores/settings';

function modelDisplayName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  return id.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

interface SettingControlProps {
  def: SettingDef;
  value: boolean | number | string;
  onChange: (v: boolean | number | string) => void;
  availableModels?: string[];
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

function ModelPickerControl({ value, onChange, availableModels, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  availableModels: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const modelTiers = useUIStore(s => s.modelTiers);
  const getClientSetting = useSettingsStore(s => s.getClientSetting);
  const setClientSetting = useSettingsStore(s => s.setClientSetting);

  const favRaw = getClientSetting('model_favorites');
  const favorites: string[] = (() => {
    try { return JSON.parse(String(favRaw || '[]')) as string[]; } catch { return []; }
  })();
  const toggleFavorite = (mid: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = favorites.includes(mid) ? favorites.filter(f => f !== mid) : [...favorites, mid];
    setClientSetting('model_favorites', JSON.stringify(next));
  };

  const tierIds = { Flash: modelTiers.flash, Pro: modelTiers.pro, Ultra: modelTiers.ultra };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const showCustom = filter.trim() && !availableModels.some(m => m === filter.trim());

  const select = (mid: string) => { onChange(mid); setOpen(false); setFilter(''); };

  return (
    <div className="settings-model-picker" ref={ref}>
      <div className="settings-model-picker-row">
        <input
          type="text"
          className="settings-text"
          value={value}
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
        />
        {availableModels.length > 0 && (
          <button
            className={`settings-model-picker-btn${open ? ' open' : ''}`}
            onClick={() => { setOpen(!open); setFilter(''); }}
            title="Pick from available models"
          >▾</button>
        )}
      </div>
      {open && (
        <div className="settings-model-dropdown">
          <input
            type="text"
            className="settings-model-search"
            placeholder="Filter models…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            autoFocus
            onClick={e => e.stopPropagation()}
          />

          {/* Tiers */}
          {!filter && <div className="sb-model-section-label">Tiers</div>}
          {Object.entries(tierIds)
            .filter(([tierName, resolvedId]) =>
              !filter ||
              tierName.toLowerCase().includes(filter.toLowerCase()) ||
              (resolvedId && resolvedId.toLowerCase().includes(filter.toLowerCase()))
            )
            .map(([tierName, resolvedId]) => (
              <button
                key={tierName}
                className={`settings-model-option sb-model-tier${resolvedId === value ? ' active' : ''}`}
                title={resolvedId || tierName}
                onClick={() => resolvedId && select(resolvedId)}
              >
                <span className="sb-tier-name">{tierName}</span>
                {resolvedId && <span className="sb-tier-model">{modelDisplayName(resolvedId)}</span>}
              </button>
            ))}

          {/* Favourites */}
          {favorites.length > 0 && !filter && <div className="sb-model-section-label">Favourites</div>}
          {favorites
            .filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()))
            .map(m => (
              <div
                key={`fav-${m}`}
                className={`settings-model-option${m === value ? ' active' : ''}`}
                onClick={() => select(m)}
                title={m}
              >
                <span className="sb-model-name">{modelDisplayName(m)}</span>
                <span className="sb-model-star starred" title="Remove from favourites" onClick={e => toggleFavorite(m, e)}>★</span>
              </div>
            ))}

          {/* All models */}
          {!filter && availableModels.some(m => !favorites.includes(m)) && (
            <div className="sb-model-section-label">All models</div>
          )}
          <div className="settings-model-list">
            {availableModels
              .filter(m => !favorites.includes(m))
              .filter(m => !filter || m.toLowerCase().includes(filter.toLowerCase()))
              .map(m => (
                <div
                  key={m}
                  className={`settings-model-option${m === value ? ' active' : ''}`}
                  title={m}
                  onClick={() => select(m)}
                >
                  <span className="sb-model-name">{modelDisplayName(m)}</span>
                  <span
                    className={`sb-model-star${favorites.includes(m) ? ' starred' : ''}`}
                    title={favorites.includes(m) ? 'Remove from favourites' : 'Add to favourites'}
                    onClick={e => toggleFavorite(m, e)}
                  >★</span>
                </div>
              ))}
            {showCustom && (
              <button
                className="settings-model-option settings-model-custom"
                onClick={() => select(filter.trim())}
              >Use &ldquo;{filter.trim()}&rdquo;</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingControl({ def, value, onChange, availableModels = [] }: SettingControlProps) {
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
      if (def.key.startsWith('keybind_')) {
        // Keybinding fields get an inline Record button
        const currentValue = String(value);
        return (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="text"
              className="settings-text"
              value={currentValue}
              placeholder={def.placeholder}
              onChange={e => onChange(e.target.value)}
            />
            <KeyCaptureButton
              onCapture={captured => {
                const trimmed = currentValue.trim();
                onChange(trimmed ? `${trimmed}, ${captured}` : captured);
              }}
            />
          </span>
        );
      }
      // Special case: model_max_tokens gets individual inputs per tier
      if (def.key === 'model_max_tokens') {
        const currentValue = String(value);
        const [error, setError] = useState<string | null>(null);
        const [formData, setFormData] = useState<{ flash?: number; pro?: number; ultra?: number }>({});

        useEffect(() => {
          try {
            if (currentValue.trim() === '') {
              setFormData({});
              setError(null);
              return;
            }
            const parsed = JSON.parse(currentValue);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              setFormData({});
              setError('Expected JSON object');
              return;
            }
            const valid: { flash?: number; pro?: number; ultra?: number } = {};
            for (const [key, val] of Object.entries(parsed)) {
              if (typeof val === 'number' && val > 0) {
                if (key.includes('flash') || key.includes('haiku')) valid.flash = val;
                else if (key.includes('pro') || key.includes('sonnet')) valid.pro = val;
                else if (key.includes('ultra') || key.includes('opus')) valid.ultra = val;
              }
            }
            setFormData(valid);
            setError(null);
          } catch (e: unknown) {
            const err = e as { message?: string };
            setError(err.message ?? 'Invalid JSON');
            setFormData({});
          }
        }, [currentValue]);

        const handleTierChange = (tier: 'flash' | 'pro' | 'ultra', newValue: string) => {
          const num = newValue.trim() === '' ? undefined : Number(newValue);
          if (num !== undefined && num !== null && num > 0 && !Number.isNaN(num)) {
            setFormData(prev => ({ ...prev, [tier]: num }));
          } else {
            setFormData(prev => {
              const next = { ...prev };
              delete next[tier];
              return next;
            });
          }
        };

        const commit = () => {
          if (Object.keys(formData).length === 0) {
            onChange('{}');
            setError(null);
            return;
          }
          try {
            const mapped: Record<string, number> = {};
            const modelTiers = useUIStore.getState().modelTiers;
            for (const [tier, tokens] of Object.entries(formData)) {
              if (tokens === undefined) continue;
              const tierKey = tier === 'flash' ? modelTiers.flash : tier === 'pro' ? modelTiers.pro : modelTiers.ultra;
              if (tierKey) mapped[tierKey] = tokens;
            }
            onChange(JSON.stringify(mapped));
            setError(null);
          } catch (e: unknown) {
            const err = e as { message?: string };
            setError(err.message ?? 'Failed to save');
          }
        };

        useEffect(() => {
          commit();
        }, [formData]);

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(() => {
              const modelTiers = useUIStore.getState().modelTiers;
              const tiers: { key: 'flash' | 'pro' | 'ultra'; label: string; model?: string }[] = [
                { key: 'flash', label: 'Flash tier', model: modelTiers.flash },
                { key: 'pro', label: 'Pro tier', model: modelTiers.pro },
                { key: 'ultra', label: 'Ultra tier', model: modelTiers.ultra },
              ];
              return tiers.map(({ key, label, model }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 80, fontSize: 13, color: '#888' }}>{label}</span>
                  {model && <span style={{ fontSize: 12, color: '#666' }}>({model})</span>}
                  <input
                    type="number"
                    className="settings-text settings-tokens-input"
                    min="1"
                    step="100"
                    placeholder="default"
                    value={formData[key] ?? ''}
                    onChange={e => handleTierChange(key, e.target.value)}
                    style={{ flex: 1, maxWidth: 150 }}
                  />
                  <span style={{ fontSize: 11, color: '#777' }}>tokens</span>
                </div>
              ));
            })()}
            {error && <span className="settings-error">{error}</span>}
            <span className="settings-hint">
              Set max tokens per tier. Leave blank to use default (16384).
            </span>
          </div>
        );
      }
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

    case 'model-picker':
      return <ModelPickerControl value={String(value)} onChange={onChange} availableModels={availableModels} placeholder={def.placeholder} />;

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
