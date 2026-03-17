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
      return (
        <input
          type="text"
          className="settings-text"
          value={String(value)}
          placeholder={def.placeholder}
          onChange={e => onChange(e.target.value)}
        />
      );

    case 'model-tokens': {
      // Rich table editor for model_max_tokens
      const currentValue = String(value);
      const [error, setError] = useState<string | null>(null);
      const [rawJson, setRawJson] = useState(currentValue);
      const [editMode, setEditMode] = useState(false);
      const modelTiers = useUIStore(s => s.modelTiers);
      
      // Parse and categorize models
      const parsedData = (() => {
        try {
          if (currentValue.trim() === '') return {};
          const parsed = JSON.parse(currentValue);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
          return parsed as Record<string, number>;
        } catch {
          return {};
        }
      })();

      // Get all unique models from parsed data and tiers
      const allModels = (() => {
        const models = new Set<string>();
        Object.keys(parsedData).forEach(m => models.add(m));
        if (modelTiers.flash) models.add(modelTiers.flash);
        if (modelTiers.pro) models.add(modelTiers.pro);
        if (modelTiers.ultra) models.add(modelTiers.ultra);
        return Array.from(models);
      })();

      // Categorize model into tier
      const categorizeModel = (model: string): 'flash' | 'pro' | 'ultra' | 'other' => {
        if (modelTiers.flash && model.includes(modelTiers.flash.toLowerCase().split('-')[0])) return 'flash';
        if (modelTiers.pro && model.includes(modelTiers.pro.toLowerCase().split('-')[0])) return 'pro';
        if (modelTiers.ultra && model.includes(modelTiers.ultra.toLowerCase().split('-')[0])) return 'ultra';
        if (model.toLowerCase().includes('flash') || model.toLowerCase().includes('haiku')) return 'flash';
        if (model.toLowerCase().includes('pro') || model.toLowerCase().includes('sonnet')) return 'pro';
        if (model.toLowerCase().includes('ultra') || model.toLowerCase().includes('opus')) return 'ultra';
        return 'other';
      };

      // Get tier label for a model
      const getTierLabel = (model: string): string => {
        const cat = categorizeModel(model);
        if (cat === 'flash') return 'Flash';
        if (cat === 'pro') return 'Pro';
        if (cat === 'ultra') return 'Ultra';
        return 'Custom';
      };

      // Get tier color for visual distinction
      const getTierColor = (model: string): string => {
        const cat = categorizeModel(model);
        if (cat === 'flash') return '#22c55e';
        if (cat === 'pro') return '#3b82f6';
        if (cat === 'ultra') return '#8b5cf6';
        return '#64748b';
      };

      const handleJsonChange = (newValue: string) => {
        setRawJson(newValue);
        try {
          if (newValue.trim() === '') {
            onChange('{}');
            setError(null);
            return;
          }
          const parsed = JSON.parse(newValue);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            setError('Expected JSON object');
            return;
          }
          for (const [key, val] of Object.entries(parsed)) {
            if (typeof val !== 'number' || val <= 0) {
              setError(`Value for "${key}" must be a positive number`);
              return;
            }
          }
          setError(null);
          onChange(newValue);
        } catch (e: unknown) {
          const err = e as { message?: string };
          setError(err.message ?? 'Invalid JSON');
        }
      };

      const handleQuickSet = (model: string, tokens: number) => {
        try {
          const current = JSON.parse(rawJson) as Record<string, number>;
          current[model] = tokens;
          setRawJson(JSON.stringify(current, null, 2));
          handleJsonChange(JSON.stringify(current, null, 2));
        } catch {
          setRawJson(JSON.stringify({ [model]: tokens }, null, 2));
          handleJsonChange(JSON.stringify({ [model]: tokens }, null, 2));
        }
      };

      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {editMode ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <textarea
                className="settings-text settings-json-input"
                value={rawJson}
                onChange={e => handleJsonChange(e.target.value)}
                rows={6}
                spellCheck={false}
                style={{ fontFamily: "'SF Mono', 'Monaco', 'Consolas', monospace", fontSize: 12 }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  onClick={() => {
                    setEditMode(false);
                    setRawJson(String(value));
                  }}
                  style={{ padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => setEditMode(false)}
                  style={{ padding: '4px 12px', fontSize: 12, cursor: 'pointer', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: 4 }}
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr 80px', gap: 0, alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 11, color: '#666', padding: '4px 8px', borderBottom: '1px solid var(--border)', fontWeight: 500 }}>Model Tier</div>
                <div style={{ fontSize: 11, color: '#666', padding: '4px 8px', borderBottom: '1px solid var(--border)', fontWeight: 500 }}>Model Name</div>
                <div style={{ fontSize: 11, color: '#666', padding: '4px 8px', borderBottom: '1px solid var(--border)', fontWeight: 500, textAlign: 'right' }}>Max Tokens</div>
              </div>
              {allModels.length === 0 ? (
                <div style={{ padding: 12, fontSize: 12, color: '#777', textAlign: 'center' }}>
                  No models configured. Set Flash, Pro, or Ultra model first.
                </div>
              ) : (
                allModels.map(model => {
                  const tokens = parsedData[model];
                  const tier = getTierLabel(model);
                  const color = getTierColor(model);
                  return (
                    <div key={model} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 80px', gap: 0, alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ padding: '6px 8px', fontSize: 12, color: '#888', borderBottom: `2px solid ${color}`, position: 'relative' }}>
                        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: color }} />
                        {tier}
                      </div>
                      <div style={{ padding: '6px 8px', fontSize: 11, color: modelTiers.flash === model || modelTiers.pro === model || modelTiers.ultra === model ? '#444' : '#666' }}>
                        {model}
                      </div>
                      <div style={{ padding: '6px 8px', fontSize: 12, fontWeight: 500, textAlign: 'right', borderBottom: `2px solid ${color}` }}>
                        {tokens ? tokens.toLocaleString() : '—'}
                      </div>
                    </div>
                  );
                })
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  onClick={() => setEditMode(true)}
                  style={{ padding: '6px 16px', fontSize: 12, cursor: 'pointer', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: 4, flex: 1 }}
                >
                  {allModels.length === 0 ? 'Configure Models First' : 'Edit JSON'}
                </button>
                {allModels.length > 0 && (
                  <>
                    <button
                      onClick={() => {
                        const firstModel = allModels[0];
                        handleQuickSet(firstModel, 8192);
                      }}
                      style={{ padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 4, backgroundColor: 'var(--bg)', color: 'var(--text)' }}
                      title="Set first model to 8192"
                    >
                      Quick: 8K
                    </button>
                    <button
                      onClick={() => {
                        const firstModel = allModels[0];
                        handleQuickSet(firstModel, 16384);
                      }}
                      style={{ padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 4, backgroundColor: 'var(--bg)', color: 'var(--text)' }}
                      title="Set first model to 16384"
                    >
                      Quick: 16K
                    </button>
                    <button
                      onClick={() => {
                        const firstModel = allModels[0];
                        handleQuickSet(firstModel, 32000);
                      }}
                      style={{ padding: '4px 10px', fontSize: 11, cursor: 'pointer', border: '1px solid var(--border)', borderRadius: 4, backgroundColor: 'var(--bg)', color: 'var(--text)' }}
                      title="Set first model to 32000"
                    >
                      Quick: 32K
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {error && <span className="settings-error">{error}</span>}
          <span className="settings-hint">
            {editMode 
              ? 'Edit the JSON directly. Valid format: {"model-name": 32000}' 
              : allModels.length === 0 
                ? 'Configure Flash, Pro, or Ultra model in the Model group first, then edit max tokens.'
                : `Viewing ${allModels.length} model${allModels.length > 1 ? 's' : ''}. Click "Edit JSON" to modify values.`
            }
          </span>
        </div>
      );
    }

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
