/**
 * Configurable keybindings system for the aigent web UI.
 *
 * A KeyBinding specifies one keyboard chord. Actions can have multiple bindings.
 * The `requireNoFocus` flag means the binding only fires when no text input
 * is focused (used for bare keys like Backtick or M).
 */

export interface KeyBinding {
  /** Matches e.key (case-insensitive for single letters) */
  key?: string;
  /** Matches e.code (layout-independent, e.g. "Backquote") */
  code?: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  /** When true: only fire if no input/textarea/select/contenteditable is focused */
  requireNoFocus?: boolean;
}

export type KeyBindingAction =
  | 'toggleMic'
  | 'toggleMicSticky'
  | 'showShortcuts'
  | 'cancelResponse'
  | 'clearInput';

// ---------------------------------------------------------------------------
// Defaults — mirror the hardcoded values that existed before this system
// ---------------------------------------------------------------------------

export const DEFAULT_KEYBINDINGS: Record<KeyBindingAction, KeyBinding[]> = {
  toggleMic: [
    // Ctrl+` — fires regardless of focus
    { code: 'Backquote', ctrl: true },
    // Bare ` — only when no input focused
    { code: 'Backquote', requireNoFocus: true },
    // M / m — only when no input focused
    { key: 'm', requireNoFocus: true },
  ],
  toggleMicSticky: [
    { code: 'Backquote', ctrl: true, shift: true },
  ],
  showShortcuts: [
    // Ctrl+? (US layout: Shift+/)
    { key: '?', ctrl: true },
    // Ctrl+Shift+/ — same physical key, different e.key on some platforms
    { key: '/', ctrl: true, shift: true },
  ],
  // Ctrl+Escape — cancel an in-progress response. Checked before clearInput so
  // the more-specific chord wins; plain Escape falls through to clearInput.
  cancelResponse: [
    { code: 'Escape', ctrl: true },
  ],
  // Escape — only fires when the textarea is focused and no modal/palette is
  // intercepting. The actual precedence logic lives in InputArea's handleKeyDown;
  // this entry exists so the binding is shown in the shortcuts modal and can
  // be overridden via settings.
  clearInput: [
    { code: 'Escape' },
  ],
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Check whether a KeyboardEvent matches a single KeyBinding.
 * Does NOT check requireNoFocus — callers handle that.
 */
export function matchesBinding(e: KeyboardEvent, binding: KeyBinding): boolean {
  // Modifier checks (treat undefined as "don't care"? No — be strict:
  // undefined means the modifier must NOT be pressed, except we treat
  // undefined as false for clean defaults.)
  if (!!binding.ctrl !== e.ctrlKey) return false;
  if (!!binding.shift !== e.shiftKey) return false;
  if (!!binding.alt !== e.altKey) return false;
  if (!!binding.meta !== e.metaKey) return false;

  // Key check: code takes priority (layout-independent)
  if (binding.code) {
    if (e.code !== binding.code) return false;
    // If both code and key are specified, check key too
    if (binding.key && e.key.toLowerCase() !== binding.key.toLowerCase()) return false;
    return true;
  }

  // Fall back to key match (case-insensitive for letters)
  if (binding.key) {
    return e.key.toLowerCase() === binding.key.toLowerCase();
  }

  return false;
}

/**
 * Check whether a KeyboardEvent matches ANY binding for an action,
 * optionally filtering out requireNoFocus bindings when an input is focused.
 */
export function matchesAction(
  e: KeyboardEvent,
  action: KeyBindingAction,
  bindings: Record<KeyBindingAction, KeyBinding[]>,
  options?: { noInputFocused?: boolean },
): boolean {
  const list = bindings[action] ?? [];
  const noInputFocused = options?.noInputFocused ?? true;

  for (const binding of list) {
    // Skip no-focus-required bindings when an input IS focused
    if (binding.requireNoFocus && !noInputFocused) continue;
    if (matchesBinding(e, binding)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Parser — human-readable string ↔ KeyBinding
// ---------------------------------------------------------------------------

/** Maps friendly name tokens to e.code values */
const CODE_MAP: Record<string, string> = {
  backtick: 'Backquote',
  backquote: 'Backquote',
  '`': 'Backquote',
  space: 'Space',
  enter: 'Enter',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

const MODIFIER_NAMES = new Set(['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd', 'command', 'win', 'super']);

/**
 * Parse a string like "Ctrl+Shift+Backtick" into a KeyBinding.
 * Modifiers: Ctrl / Control, Shift, Alt / Option, Meta / Cmd / Command / Win / Super
 * Keys: Backtick / ` → code Backquote; single letters → key (lowercase);
 *       ? / / → key match; other → key match as-is.
 */
export function parseBindingString(s: string): KeyBinding {
  const parts = s.trim().split('+').map(p => p.trim());
  const binding: KeyBinding = {};
  let keyPart: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const lower = parts[i].toLowerCase();
    if (lower === 'ctrl' || lower === 'control') {
      binding.ctrl = true;
    } else if (lower === 'shift') {
      binding.shift = true;
    } else if (lower === 'alt' || lower === 'option') {
      binding.alt = true;
    } else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win' || lower === 'super') {
      binding.meta = true;
    } else {
      // Everything that isn't a modifier is the key (last one wins)
      keyPart = parts[i];
    }
  }

  if (keyPart !== undefined) {
    const lower = keyPart.toLowerCase();
    const mappedCode = CODE_MAP[lower];
    if (mappedCode) {
      // Use code for layout-independent special keys
      binding.code = mappedCode;
    } else if (keyPart.length === 1) {
      // Single character: use key match (case-insensitive in matchesBinding)
      binding.key = keyPart.toLowerCase();
    } else {
      // Unknown multi-char token: try as e.key value
      binding.key = keyPart;
    }
  }

  return binding;
}

/**
 * Parse a comma-separated list of binding strings.
 * Skips empty/invalid entries.
 */
export function parseBindingsString(s: string): KeyBinding[] {
  return s
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .map(part => parseBindingString(part));
}

/**
 * Serialize a KeyBinding back to a human-readable string.
 * Used for display in the ShortcutsModal.
 */
export function serializeBinding(b: KeyBinding): string {
  const parts: string[] = [];
  if (b.ctrl) parts.push('Ctrl');
  if (b.shift) parts.push('Shift');
  if (b.alt) parts.push('Alt');
  if (b.meta) parts.push('Meta');

  if (b.code) {
    // Reverse-map code → friendly name
    const friendly = Object.entries(CODE_MAP).find(([, v]) => v === b.code && !MODIFIER_NAMES.has(''))?.[0];
    // Find the most "readable" alias (prefer title-case)
    const friendlyName = b.code === 'Backquote' ? 'Backtick' : b.code;
    parts.push(friendlyName);
  } else if (b.key) {
    // Single letter: uppercase for display
    parts.push(b.key.length === 1 ? b.key.toUpperCase() : b.key);
  }

  return parts.join('+');
}

// ---------------------------------------------------------------------------
// Active bindings — reads from settings store
// ---------------------------------------------------------------------------

import { useSettingsStore } from '../stores/settings.js';

/**
 * Get the currently active bindings, merging user settings over defaults.
 * Safe to call outside React (uses getState()).
 */
export function getActiveBindings(): Record<KeyBindingAction, KeyBinding[]> {
  const settings = useSettingsStore.getState().clientSettings;

  const result = { ...DEFAULT_KEYBINDINGS } as Record<KeyBindingAction, KeyBinding[]>;

  const actions: KeyBindingAction[] = ['toggleMic', 'toggleMicSticky', 'showShortcuts', 'cancelResponse', 'clearInput'];
  for (const action of actions) {
    const settingKey = `keybind_${action}`;
    const raw = settings[settingKey];
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = parseBindingsString(raw);
        if (parsed.length > 0) {
          result[action] = parsed;
        }
      } catch {
        // Fall back to default on parse error
      }
    }
  }

  return result;
}
