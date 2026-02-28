import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AtItem } from '../types';
import { isDemo } from '../demo/useDemoMode';

const STATIC_AT_ITEMS: AtItem[] = [
  { icon: '🖥️', label: 'screen',    desc: 'Share your screen',       insert: '@screen' },
  { icon: '📋', label: 'clipboard', desc: 'Paste clipboard content', insert: '@clipboard' },
  { icon: '🖼️', label: 'image',     desc: 'Attach an image',         insert: '@image' },
];

export function getAtStaticMatches(query: string): AtItem[] {
  const q = query.toLowerCase();
  return STATIC_AT_ITEMS.filter(item => item.label.toLowerCase().includes(q));
}

// ── Path mode helpers ────────────────────────────────────────────────────────

/** True if the query looks like a filesystem path (@~/, @/, @./) */
function isPathMode(query: string): boolean {
  return query === '~' || query === '.' || query === '..'
    || query.startsWith('~/') || query.startsWith('/') || query.startsWith('./');
}

/** Split a path query into directory (for server fetch) and filter (for client matching). */
function parsePathQuery(query: string): { dir: string; filter: string } {
  const lastSlash = query.lastIndexOf('/');
  if (lastSlash === -1) return { dir: query, filter: '' };
  return { dir: query.slice(0, lastSlash + 1), filter: query.slice(lastSlash + 1) };
}

/** Case-insensitive fuzzy subsequence test — same algorithm as highlightMatch. */
function fuzzyMatch(text: string, query: string): boolean {
  if (!query) return true;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// ── Demo mock data ───────────────────────────────────────────────────────────

const MOCK_FS: Record<string, { name: string; isDir: boolean }[]> = {
  '~/': [
    { name: 'Documents', isDir: true },
    { name: 'projects', isDir: true },
    { name: 'Downloads', isDir: true },
    { name: 'notes.md', isDir: false },
  ],
  '~/projects/': [
    { name: 'myapp', isDir: true },
    { name: 'shared-lib', isDir: true },
    { name: 'README.md', isDir: false },
  ],
  '~/projects/myapp/': [
    { name: 'src', isDir: true },
    { name: 'package.json', isDir: false },
    { name: 'tsconfig.json', isDir: false },
  ],
};

function makeDirItems(entries: { name: string; isDir: boolean }[], dir: string): AtItem[] {
  return entries.map(e => ({
    icon: e.isDir ? '📁' : '📄',
    label: e.name,
    desc: dir,
    insert: dir + e.name + (e.isDir ? '/' : ''),
    isFile: !e.isDir,
    isDir: e.isDir,
  }));
}

// ── Component ────────────────────────────────────────────────────────────────

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
  const lastDirRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pathMode = triggerPos !== -1 && isPathMode(query);
  const { dir: pathDir, filter: pathFilter } = pathMode ? parsePathQuery(query) : { dir: '', filter: '' };

  // Fetch directory listing (path mode) or mount search (mount mode)
  useEffect(() => {
    if (triggerPos === -1) { setFileItems([]); return; }

    if (pathMode) {
      // Path mode — fetch directory listing from /files?dir=
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        timerRef.current = null;
        if (pathDir === lastDirRef.current) return;
        lastDirRef.current = pathDir;
        if (isDemo()) {
          setFileItems(makeDirItems(MOCK_FS[pathDir] ?? [], pathDir));
          return;
        }
        try {
          const resp = await fetch(`/files?dir=${encodeURIComponent(pathDir)}`);
          if (!resp.ok) { setFileItems([]); return; }
          const data = await resp.json() as { entries: { name: string; isDir: boolean }[] };
          setFileItems(makeDirItems(data.entries, pathDir));
        } catch { setFileItems([]); }
      }, 120);
      return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    }

    // Mount search mode (existing)
    if (!mountsAvailable) { setFileItems([]); return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      timerRef.current = null;
      if (query === lastDirRef.current) return;
      lastDirRef.current = query;
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mountsAvailable, triggerPos, pathMode, pathDir]);

  // Static items: hidden when in path mode
  const staticItems = triggerPos !== -1 && !pathMode
    ? STATIC_AT_ITEMS.filter(item => fuzzyMatch(item.label, query))
    : [];

  // Filter file items by the filter portion in path mode
  const filteredFiles = pathMode && pathFilter
    ? fileItems.filter(item => fuzzyMatch(item.label, pathFilter))
    : fileItems;

  const allItems = [...staticItems, ...filteredFiles];
  const isHidden = triggerPos === -1 || allItems.length === 0;
  const clampedSelected = allItems.length > 0 ? Math.min(selected, allItems.length - 1) : selected;

  // Notify parent of current items for keyboard Tab completion
  const onItemsChangeRef = useRef(onItemsChange);
  onItemsChangeRef.current = onItemsChange;
  useEffect(() => {
    onItemsChangeRef.current?.(isHidden ? [] : allItems);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allItems.length, isHidden]);

  const displayQuery = pathMode ? pathFilter : query;

  return (
    <div id="at-palette" className={isHidden ? 'hidden' : ''}>
      {staticItems.length > 0 && (
        <>
          <div className="at-palette-section">Mention</div>
          {staticItems.map((item, i) => (
            <AtPaletteItem
              key={item.insert}
              item={item}
              query={displayQuery}
              idx={i}
              selected={clampedSelected}
              onSelect={onSelect}
              onComplete={onComplete}
            />
          ))}
        </>
      )}
      {filteredFiles.length > 0 && (
        <>
          <div className="at-palette-section">{pathMode ? pathDir : 'Files'}</div>
          {filteredFiles.map((item, i) => (
            <AtPaletteItem
              key={item.insert}
              item={item}
              query={displayQuery}
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

/** Wrap characters in `text` that are part of a fuzzy match for `query` in <mark> spans. */
function highlightMatch(text: string, query: string): ReactNode {
  if (!query) return text;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  // Find sequential character positions (fuzzy subsequence match)
  const positions = new Set<number>();
  let qi = 0;
  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] === q[qi]) { positions.add(i); qi++; }
  }
  if (positions.size === 0) return text;
  // Build React node array, grouping consecutive matched/unmatched chars
  const nodes: ReactNode[] = [];
  let buf = '';
  let inMark = false;
  for (let i = 0; i < text.length; i++) {
    const matched = positions.has(i);
    if (matched !== inMark) {
      if (buf) nodes.push(inMark ? <mark key={i}>{buf}</mark> : buf);
      buf = '';
      inMark = matched;
    }
    buf += text[i];
  }
  if (buf) nodes.push(inMark ? <mark key="end">{buf}</mark> : buf);
  return <>{nodes}</>;
}

function AtPaletteItem({ item, query, idx, selected, onSelect, onComplete }: {
  item: AtItem; query: string; idx: number; selected: number;
  onSelect: (i: number) => void; onComplete: (item: AtItem) => void;
}) {
  const displayLabel = (item.isFile || item.isDir) ? item.label : item.label;
  const displayDesc  = (item.isFile || item.isDir) ? item.desc : item.desc;
  return (
    <div
      className={`at-palette-item${idx === selected ? ' selected' : ''}`}
      onMouseEnter={() => onSelect(idx)}
      onMouseDown={e => { e.preventDefault(); onComplete(item); }}
    >
      <span className="at-item-icon">{item.icon}</span>
      <span className="at-item-text">
        <span className="at-item-label">{highlightMatch(displayLabel, query)}</span>
        <span className="at-item-desc">{(item.isFile || item.isDir) ? highlightMatch(displayDesc, query) : displayDesc}</span>
      </span>
    </div>
  );
}
