import React, { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '../../stores/ui';
import { useSettingsStore } from '../../stores/settings';
import { getActiveBindings, serializeBinding, type KeyBinding } from '../../lib/keybindings.js';

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  label: string;
  shortcuts: Shortcut[];
}

/** Convert a KeyBinding into an array of display tokens like ['Ctrl', 'Shift', '`'] */
function bindingToKeys(b: KeyBinding): string[] {
  const parts: string[] = [];
  // Hold bindings get a special prefix token instead of individual modifier badges
  if (b.hold !== undefined) {
    const holdSec = b.hold === 1000 ? '1s' : `${b.hold}ms`;
    if (b.ctrl) parts.push('Ctrl');
    if (b.shift) parts.push('Shift');
    if (b.alt) parts.push('Alt');
    if (b.meta) parts.push('Meta');
    if (b.code) {
      parts.push(`Hold ${b.code === 'Backquote' ? '`' : b.code} (${holdSec})`);
    } else if (b.key) {
      parts.push(`Hold ${b.key.length === 1 ? b.key.toUpperCase() : b.key} (${holdSec})`);
    }
    return parts;
  }
  if (b.ctrl) parts.push('Ctrl');
  if (b.shift) parts.push('Shift');
  if (b.alt) parts.push('Alt');
  if (b.meta) parts.push('Meta');
  if (b.code) {
    parts.push(b.code === 'Backquote' ? '`' : b.code);
  } else if (b.key) {
    parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
  }
  return parts;
}

/**
 * Build the shortcut groups, using configured bindings for the 3 configurable
 * actions and keeping everything else hardcoded.
 */
function getShortcutGroups(multilineEnter: boolean): ShortcutGroup[] {
  const bindings = getActiveBindings();

  // Helper: turn a list of KeyBindings into Shortcut rows, one per binding
  // (skip requireNoFocus ones for the display — we annotate them in the description)
  function bindingsToShortcuts(
    bindingList: KeyBinding[],
    descFull: string,
    descNoFocus: string,
  ): Shortcut[] {
    return bindingList.map(b => ({
      keys: bindingToKeys(b),
      description: b.requireNoFocus ? descNoFocus : descFull,
    }));
  }

  return [
    {
      label: 'Global',
      shortcuts: [
        ...bindingsToShortcuts(
          bindings.showShortcuts,
          'Show keyboard shortcuts',
          'Show keyboard shortcuts (when not typing)',
        ),
        ...bindingsToShortcuts(
          bindings.toggleMic,
          'Toggle microphone',
          'Toggle mic (when not typing)',
        ),
        ...bindingsToShortcuts(
          bindings.toggleMicSticky,
          'Toggle sticky mic (always-on)',
          'Toggle sticky mic (when not typing)',
        ),
      ],
    },
    {
      label: 'Input',
      shortcuts: multilineEnter
        ? [
            { keys: ['Enter'], description: 'Insert newline' },
            { keys: ['Ctrl', 'Enter'], description: 'Send message' },
            { keys: ['Shift', 'Enter'], description: 'Send with thinking toggle' },
            { keys: ['Escape'], description: 'Clear input / close palette' },
            ...bindingsToShortcuts(bindings.cancelResponse, 'Cancel / stop response', 'Cancel / stop response'),
            { keys: ['/'], description: 'Open command palette' },
            { keys: ['@'], description: 'Open mention palette' },
          ]
        : [
            { keys: ['Enter'], description: 'Send message' },
            { keys: ['Ctrl', 'Enter'], description: 'Send with thinking toggle' },
            { keys: ['Shift', 'Enter'], description: 'Insert newline' },
            { keys: ['Escape'], description: 'Clear input / close palette' },
            ...bindingsToShortcuts(bindings.cancelResponse, 'Cancel / stop response', 'Cancel / stop response'),
            { keys: ['/'], description: 'Open command palette' },
            { keys: ['@'], description: 'Open mention palette' },
          ],
    },
    {
      label: 'Permission Modal',
      shortcuts: [
        { keys: ['Enter'], description: 'Approve' },
        { keys: ['Escape'], description: 'Deny' },
        { keys: ['A'], description: 'Always allow' },
      ],
    },
  ];
}

export function ShortcutsModal() {
  const open = useUIStore(s => s.shortcutsOpen);
  const close = () => useUIStore.getState().setShortcutsOpen(false);
  const multilineEnter = useSettingsStore(s => s.getClientSetting('AIGENT_MULTILINE_ENTER')) === true;
  // Subscribe to keybinding settings changes so the display stays in sync.
  // useShallow prevents infinite re-renders — without it the array selector
  // returns a new reference every render, tripping React 19's useSyncExternalStore.
  useSettingsStore(useShallow(s => [
    s.clientSettings['keybind_toggleMic'],
    s.clientSettings['keybind_toggleMicSticky'],
    s.clientSettings['keybind_showShortcuts'],
  ]));

  const groups = getShortcutGroups(multilineEnter);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div id="shortcuts-overlay" className={open ? '' : 'hidden'} onClick={(e) => {
      if ((e.target as HTMLElement).id === 'shortcuts-overlay') close();
    }}>
      <div id="shortcuts-modal">
        <div id="shortcuts-header">
          <span id="shortcuts-title">Keyboard Shortcuts</span>
          <button id="shortcuts-close" className="icon-btn" onClick={close} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div id="shortcuts-body">
          {groups.map(group => (
            <div key={group.label} className="shortcuts-group">
              <div className="shortcuts-group-label">{group.label}</div>
              {group.shortcuts.map((sc, i) => (
                <div key={i} className="shortcut-row">
                  <div className="shortcut-keys">
                    {sc.keys.map((k, j) => (
                      <React.Fragment key={j}>
                        {j > 0 && <span className="shortcut-plus">+</span>}
                        <kbd>{k}</kbd>
                      </React.Fragment>
                    ))}
                  </div>
                  <span className="shortcut-desc">{sc.description}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
