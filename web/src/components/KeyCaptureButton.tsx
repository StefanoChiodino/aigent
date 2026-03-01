import React, { useState, useEffect } from 'react';
import { serializeBinding } from '../lib/keybindings';
import type { KeyBinding } from '../lib/keybindings';

interface Props {
  onCapture: (bindingStr: string) => void;
}

/** Maps e.code values to friendly display names for special keys. */
const CODE_DISPLAY: Record<string, string> = {
  Backquote: 'Backtick',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
};

/** Modifier-only keys that should be ignored (don't trigger a capture). */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']);

function buildBindingString(e: KeyboardEvent): string | null {
  // Skip if only a modifier key was pressed
  if (MODIFIER_KEYS.has(e.key)) return null;

  const binding: KeyBinding = {
    ctrl: e.ctrlKey || undefined,
    shift: e.shiftKey || undefined,
    alt: e.altKey || undefined,
    meta: e.metaKey || undefined,
  };

  const code = e.code;

  if (code in CODE_DISPLAY) {
    // Known special key — use code-based matching for layout independence
    binding.code = code;
  } else if (code.startsWith('Key')) {
    // Letter key (e.g. KeyM → "M")
    // Use e.key.toUpperCase() to ensure uppercase display
    binding.key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  } else if (code.startsWith('Digit')) {
    // Digit key (e.g. Digit1 → "1")
    binding.key = code.slice(5); // extract the digit
  } else if (/^F\d+$/.test(code)) {
    // Function keys (F1-F12)
    binding.key = e.key;
  } else if (code.startsWith('Arrow')) {
    // Arrow keys
    binding.key = e.key;
  } else {
    // Fall back to e.key for anything else
    if (e.key.length === 1) {
      binding.key = e.key;
    } else {
      binding.key = e.key;
    }
  }

  // Ensure at least a key or code was captured
  if (!binding.key && !binding.code) return null;

  return serializeBinding(binding);
}

export function KeyCaptureButton({ onCapture }: Props) {
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    if (!recording) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }

      const bindingStr = buildBindingString(e);
      if (bindingStr) {
        onCapture(bindingStr);
        setRecording(false);
      }
    };

    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [recording, onCapture]);

  return (
    <button
      type="button"
      className={`kb-record-btn${recording ? ' recording' : ''}`}
      onClick={() => setRecording(r => !r)}
      title={recording ? 'Press a key combo, or Escape to cancel' : 'Click to record a key binding'}
    >
      {recording ? 'Press keys…' : '⌨ Record'}
    </button>
  );
}
