import React, { useEffect } from 'react';
import { useUIStore } from '../../stores/ui';

interface Shortcut {
  keys: string[];
  description: string;
}

interface ShortcutGroup {
  label: string;
  shortcuts: Shortcut[];
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: 'Global',
    shortcuts: [
      { keys: ['Ctrl', 'Shift', '?'], description: 'Show keyboard shortcuts' },
      { keys: ['Ctrl', '`'], description: 'Toggle microphone' },
      { keys: ['Ctrl', 'Shift', '`'], description: 'Toggle sticky mic (always-on)' },
      { keys: ['`'], description: 'Toggle mic (when not typing)' },
      { keys: ['M'], description: 'Toggle mic (when not typing)' },
    ],
  },
  {
    label: 'Input',
    shortcuts: [
      { keys: ['Enter'], description: 'Send message' },
      { keys: ['Ctrl', 'Enter'], description: 'Send with thinking toggle' },
      { keys: ['Shift', 'Enter'], description: 'Insert newline' },
      { keys: ['Escape'], description: 'Clear input / close palette' },
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

export function ShortcutsModal() {
  const open = useUIStore(s => s.shortcutsOpen);
  const close = () => useUIStore.getState().setShortcutsOpen(false);

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
          {SHORTCUT_GROUPS.map(group => (
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
