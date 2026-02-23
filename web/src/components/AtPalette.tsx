import React, { useEffect, useRef, useState } from 'react';
import type { AtItem } from '../types';

const STATIC_AT_ITEMS: AtItem[] = [
  { icon: '🖥️', label: 'screen',    desc: 'Share your screen',       insert: '@screen' },
  { icon: '📋', label: 'clipboard', desc: 'Paste clipboard content', insert: '@clipboard' },
  { icon: '🖼️', label: 'image',     desc: 'Attach an image',         insert: '@image' },
];

export function getAtStaticMatches(query: string): AtItem[] {
  return STATIC_AT_ITEMS.filter(item => item.label.toLowerCase().includes(query.toLowerCase()));
}

interface AtPaletteProps {
  triggerPos: number;
  query: string;
  mountsAvailable: boolean;
  selected: number;
  onSelect: (idx: number) => void;
  onComplete: (item: AtItem) => void;
  onItemsChange?: (items: AtItem[]) => void;
}

export const AtPalette = React.memo(function AtPalette({
  triggerPos, query, mountsAvailable, selected, onSelect, onComplete, onItemsChange,
}: AtPaletteProps) {
  const [fileItems, setFileItems] = useState<AtItem[]>([]);
  const lastQuery = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mountsAvailable || triggerPos === -1) {
      setFileItems([]);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      if (query === lastQuery.current) return;
      lastQuery.current = query;
      try {
        const resp = await fetch(`/files?q=${encodeURIComponent(query)}`);
        if (!resp.ok) return;
        const data = await resp.json() as { files: { path: string; mountPath: string }[] };
        setFileItems(data.files.map(f => ({
          icon: '📄',
          label: f.path,
          desc: f.mountPath,
          insert: f.mountPath.replace(/\/$/, '') + '/' + f.path,
          isFile: true,
        })));
      } catch { /* unavailable */ }
    }, 120);

    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, mountsAvailable, triggerPos]);

  const staticItems = triggerPos !== -1
    ? STATIC_AT_ITEMS.filter(item => item.label.toLowerCase().includes(query.toLowerCase()))
    : [];
  const allItems = [...staticItems, ...fileItems];
  // Hidden when no trigger, OR when there are no items to show
  // Use triggerPos as primary gate so stale fileItems don't keep palette visible
  const isHidden = triggerPos === -1 || (staticItems.length === 0 && fileItems.length === 0);
  // Clamp selection to valid range
  const clampedSelected = allItems.length > 0 ? Math.min(selected, allItems.length - 1) : selected;

  // Notify parent of current items for keyboard Tab completion
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  useEffect(() => {
    onItemsChangeRef.current?.(isHidden ? [] : allItems);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems.length, isHidden]);

  return (
    <div id="at-palette" className={isHidden ? 'hidden' : ''}>
      {staticItems.length > 0 && (
        <>
          <div className="at-palette-section">Mention</div>
          {staticItems.map((item, i) => (
            <AtPaletteItem
              key={item.insert}
              item={item}
              idx={i}
              selected={clampedSelected}
              onSelect={onSelect}
              onComplete={onComplete}
            />
          ))}
        </>
      )}
      {fileItems.length > 0 && (
        <>
          <div className="at-palette-section">Files</div>
          {fileItems.map((item, i) => (
            <AtPaletteItem
              key={item.insert}
              item={item}
              idx={staticItems.length + i}
              selected={clampedSelected}
              onSelect={onSelect}
              onComplete={onComplete}
            />
          ))}
        </>
      )}
    </div>
  );
});

function AtPaletteItem({ item, idx, selected, onSelect, onComplete }: {
  item: AtItem; idx: number; selected: number;
  onSelect: (i: number) => void; onComplete: (item: AtItem) => void;
}) {
  return (
    <div
      className={`at-palette-item${idx === selected ? ' selected' : ''}`}
      onMouseEnter={() => onSelect(idx)}
      onMouseDown={e => { e.preventDefault(); onComplete(item); }}
    >
      <span className="at-item-icon">{item.icon}</span>
      <span className="at-item-text">
        <span className="at-item-label">{item.isFile ? item.label.split('/').pop() : item.label}</span>
        <span className="at-item-desc">{item.isFile ? item.label : item.desc}</span>
      </span>
    </div>
  );
}
