import { useState, useEffect, useRef } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onTab?: (currentValue: string) => string | null;
  placeholder?: string | undefined;
  focus?: boolean | undefined;
  showCursor?: boolean | undefined;
}

/**
 * Custom text input with readline-style keybindings:
 *
 * Navigation:
 *   Ctrl+A / Home — move to beginning of line
 *   Ctrl+E / End  — move to end of line
 *   Ctrl+B        — move back one character (same as left arrow)
 *   Ctrl+F        — move forward one character (same as right arrow)
 *   Alt+B / Ctrl+Left  — move back one word
 *   Alt+F / Ctrl+Right — move forward one word
 *
 * Deletion:
 *   Ctrl+W       — delete word before cursor
 *   Ctrl+U       — delete from cursor to beginning of line
 *   Ctrl+K       — delete from cursor to end of line
 *   Backspace / Ctrl+H — delete character before cursor
 *   Delete       — delete character after cursor
 *   Ctrl+D       — delete character under cursor
 *
 * Multi-line:
 *   Ctrl+J       — insert newline
 *
 * Other:
 *   Ctrl+L       — clear (handled at app level)
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  onTab,
  placeholder = '',
  focus = true,
  showCursor = true,
}: TextInputProps): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const valueRef = useRef(value);
  valueRef.current = value;
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;
  const isPastingRef = useRef(false);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    if (cursorOffset > value.length) {
      setCursorOffset(value.length);
    }
  }, [value, cursorOffset]);

  // Bracket paste mode + Home/End key handling.
  // Patches stdin.emit to intercept bracket paste data BEFORE Ink/readline
  // ever see it. Using prependListener alone isn't enough because all data
  // listeners still receive the same buffer — Ink's parser leaks the markers.
  useEffect(() => {
    if (!focus) return;

    let pasteBuffer = '';
    const PASTE_START = '\x1b[200~';
    const PASTE_END = '\x1b[201~';

    // Enable bracket paste mode
    process.stdout.write('\x1b[?2004h');

    // Find paste marker, tolerating split ESC delivery (ESC in prior chunk)
    function findPasteStart(s: string): { idx: number; len: number } | null {
      const full = s.indexOf(PASTE_START);
      if (full !== -1) return { idx: full, len: PASTE_START.length };
      const split = s.indexOf('[200~');
      if (split !== -1) return { idx: split, len: 5 };
      return null;
    }
    function findPasteEnd(s: string): number {
      const full = s.indexOf(PASTE_END);
      if (full !== -1) return full;
      return s.indexOf('[201~');
    }

    function finishPaste(text: string): void {
      if (text) {
        const v = valueRef.current;
        const c = cursorOffsetRef.current;
        const newValue = v.slice(0, c) + text + v.slice(c);
        onChange(newValue);
        setCursorOffset(c + text.length);
      }
      // Defer reset so any synchronous Ink handlers still see isPasting=true
      setTimeout(() => { isPastingRef.current = false; }, 0);
    }

    const origEmit = process.stdin.emit.bind(process.stdin) as typeof process.stdin.emit;

    (process.stdin as NodeJS.ReadStream & { emit: typeof process.stdin.emit }).emit = function (
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (event === 'data') {
        const seq = (args[0] as Buffer).toString();

        // Bracket paste start — suppress entirely so Ink never sees it
        const start = findPasteStart(seq);
        if (start) {
          isPastingRef.current = true;
          const afterStart = seq.slice(start.idx + start.len);
          const endIdx = findPasteEnd(afterStart);
          if (endIdx !== -1) {
            finishPaste(afterStart.slice(0, endIdx));
          } else {
            pasteBuffer = afterStart;
          }
          return true;
        }

        // Mid-paste — buffer and suppress
        if (isPastingRef.current) {
          const endIdx = findPasteEnd(seq);
          if (endIdx !== -1) {
            pasteBuffer += seq.slice(0, endIdx);
            finishPaste(pasteBuffer);
            pasteBuffer = '';
          } else {
            pasteBuffer += seq;
          }
          return true;
        }

        // Home/End — handle here, pass through to Ink (it ignores them)
        if (seq === '\x1b[H' || seq === '\x1bOH' || seq === '\x1b[1~') {
          setCursorOffset(0);
        } else if (seq === '\x1b[F' || seq === '\x1bOF' || seq === '\x1b[4~') {
          setCursorOffset(valueRef.current.length);
        }

        // Backspace — most terminals send \x7f, but Ink misidentifies it as
        // key.delete. Handle directly here and suppress from Ink.
        if (seq === '\x7f' || seq === '\b') {
          const v = valueRef.current;
          const c = cursorOffsetRef.current;
          if (c > 0) {
            onChange(v.slice(0, c - 1) + v.slice(c));
            setCursorOffset(c - 1);
          }
          return true;
        }

        // Delete key — \x1b[3~ (xterm). Handle directly and suppress.
        if (seq === '\x1b[3~') {
          const v = valueRef.current;
          const c = cursorOffsetRef.current;
          if (c < v.length) {
            onChange(v.slice(0, c) + v.slice(c + 1));
          }
          return true;
        }
      }

      return origEmit(event, ...args);
    };

    return () => {
      (process.stdin as NodeJS.ReadStream & { emit: typeof process.stdin.emit }).emit = origEmit;
      process.stdout.write('\x1b[?2004l');
    };
  }, [focus, onChange]);

  useInput((input, key) => {
    if (!focus || isPastingRef.current) return;

    // Ignore certain keys we don't handle
    if (key.upArrow || key.downArrow || (key.shift && key.tab)) return;

    // Tab — autocomplete
    if (key.tab) {
      if (onTab) {
        const completed = onTab(value);
        if (completed !== null) {
          onChange(completed);
          setCursorOffset(completed.length);
        }
      }
      return;
    }

    // Ctrl+C — let parent handle
    if (key.ctrl && input === 'c') return;

    // Ctrl+J — insert newline
    if (key.ctrl && input === 'j') {
      const newValue = value.slice(0, cursorOffset) + '\n' + value.slice(cursorOffset);
      onChange(newValue);
      setCursorOffset(cursorOffset + 1);
      return;
    }

    // Enter — submit
    if (key.return) {
      onSubmit?.(value);
      return;
    }

    // --- Navigation ---

    // Ctrl+A — beginning of line
    if (key.ctrl && input === 'a') {
      setCursorOffset(0);
      return;
    }

    // Ctrl+E — end of line
    if (key.ctrl && input === 'e') {
      setCursorOffset(value.length);
      return;
    }

    // Ctrl+B — back one char
    if (key.ctrl && input === 'b') {
      setCursorOffset(Math.max(0, cursorOffset - 1));
      return;
    }

    // Ctrl+F — forward one char
    if (key.ctrl && input === 'f') {
      setCursorOffset(Math.min(value.length, cursorOffset + 1));
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      if (key.meta || key.ctrl) {
        // Alt+Left or Ctrl+Left — back one word
        setCursorOffset(findWordBoundaryLeft(value, cursorOffset));
      } else {
        setCursorOffset(Math.max(0, cursorOffset - 1));
      }
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      if (key.meta || key.ctrl) {
        // Alt+Right or Ctrl+Right — forward one word
        setCursorOffset(findWordBoundaryRight(value, cursorOffset));
      } else {
        setCursorOffset(Math.min(value.length, cursorOffset + 1));
      }
      return;
    }

    // Alt+B — back one word
    if (key.meta && input === 'b') {
      setCursorOffset(findWordBoundaryLeft(value, cursorOffset));
      return;
    }

    // Alt+F — forward one word
    if (key.meta && input === 'f') {
      setCursorOffset(findWordBoundaryRight(value, cursorOffset));
      return;
    }

    // --- Deletion ---

    // Ctrl+W — delete word before cursor
    if (key.ctrl && input === 'w') {
      const boundary = findWordBoundaryLeft(value, cursorOffset);
      const newValue = value.slice(0, boundary) + value.slice(cursorOffset);
      onChange(newValue);
      setCursorOffset(boundary);
      return;
    }

    // Ctrl+U — delete to beginning of line
    if (key.ctrl && input === 'u') {
      onChange(value.slice(cursorOffset));
      setCursorOffset(0);
      return;
    }

    // Ctrl+K — delete to end of line
    if (key.ctrl && input === 'k') {
      onChange(value.slice(0, cursorOffset));
      return;
    }

    // Ctrl+D — on empty input, let parent handle (exit). Otherwise forward-delete.
    if (key.ctrl && input === 'd') {
      if (value.length === 0) return; // pass through to parent
      if (cursorOffset < value.length) {
        onChange(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1));
      }
      return;
    }

    // Backspace / Delete / Ctrl+H — handled in raw stdin handler above
    // (Ink misidentifies \x7f as key.delete, so we bypass its key parsing)
    if (key.backspace || key.delete) return;

    // --- Regular character input ---
    if (input && !key.ctrl && !key.meta) {
      const newValue = value.slice(0, cursorOffset) + input + value.slice(cursorOffset);
      onChange(newValue);
      setCursorOffset(cursorOffset + input.length);
    }
  });

  // --- Rendering ---
  const renderedPlaceholder = placeholder
    ? showCursor && focus
      ? chalk.inverse(placeholder[0] ?? ' ') + chalk.gray(placeholder.slice(1))
      : chalk.gray(placeholder)
    : showCursor && focus
      ? chalk.inverse(' ')
      : '';

  let rendered = '';
  if (value.length === 0) {
    rendered = renderedPlaceholder;
  } else if (showCursor && focus) {
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!;
      // Show cursor on newline as highlighted space before the break
      rendered += i === cursorOffset ? (ch === '\n' ? chalk.inverse(' ') + '\n' : chalk.inverse(ch)) : ch;
    }
    if (cursorOffset === value.length) {
      rendered += chalk.inverse(' ');
    }
  } else {
    rendered = value;
  }

  return <Text>{rendered}</Text>;
}

// --- Word boundary helpers ---

function findWordBoundaryLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  // Skip whitespace
  while (i > 0 && /\s/.test(text[i] ?? '')) i--;
  // Skip word chars
  while (i > 0 && !/\s/.test(text[i - 1] ?? '')) i--;
  return i;
}

function findWordBoundaryRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  let i = pos;
  // Skip current word chars
  while (i < text.length && !/\s/.test(text[i] ?? '')) i++;
  // Skip whitespace
  while (i < text.length && /\s/.test(text[i] ?? '')) i++;
  return i;
}
