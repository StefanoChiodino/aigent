import { useState, useEffect } from 'react';
import { Text, useInput } from 'ink';
import chalk from 'chalk';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  placeholder?: string | undefined;
  focus?: boolean | undefined;
  showCursor?: boolean | undefined;
}

/**
 * Custom text input with readline-style keybindings:
 *
 * Navigation:
 *   Ctrl+A       — move to beginning of line
 *   Ctrl+E       — move to end of line
 *   Ctrl+B       — move back one character (same as left arrow)
 *   Ctrl+F       — move forward one character (same as right arrow)
 *   Alt+B        — move back one word
 *   Alt+F        — move forward one word
 *
 * Deletion:
 *   Ctrl+W       — delete word before cursor
 *   Ctrl+U       — delete from cursor to beginning of line
 *   Ctrl+K       — delete from cursor to end of line
 *   Ctrl+H       — delete character before cursor (same as backspace)
 *   Ctrl+D       — delete character under cursor
 *
 * Other:
 *   Ctrl+L       — clear (handled at app level)
 */
export function TextInput({
  value,
  onChange,
  onSubmit,
  placeholder = '',
  focus = true,
  showCursor = true,
}: TextInputProps): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);

  // Keep cursor in bounds when value changes externally
  useEffect(() => {
    if (cursorOffset > value.length) {
      setCursorOffset(value.length);
    }
  }, [value, cursorOffset]);

  useInput((input, key) => {
    if (!focus) return;

    // Ignore certain keys we don't handle
    if (key.upArrow || key.downArrow || key.tab || (key.shift && key.tab)) return;

    // Ctrl+C — let parent handle
    if (key.ctrl && input === 'c') return;

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
      if (key.meta) {
        // Alt+Left — back one word
        setCursorOffset(findWordBoundaryLeft(value, cursorOffset));
      } else {
        setCursorOffset(Math.max(0, cursorOffset - 1));
      }
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      if (key.meta) {
        // Alt+Right — forward one word
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

    // Ctrl+H — backspace
    if (key.ctrl && input === 'h') {
      if (cursorOffset > 0) {
        const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        onChange(newValue);
        setCursorOffset(cursorOffset - 1);
      }
      return;
    }

    // Ctrl+D — delete char under cursor (or forward delete)
    if (key.ctrl && input === 'd') {
      if (cursorOffset < value.length) {
        onChange(value.slice(0, cursorOffset) + value.slice(cursorOffset + 1));
      }
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        const newValue = value.slice(0, cursorOffset - 1) + value.slice(cursorOffset);
        onChange(newValue);
        setCursorOffset(cursorOffset - 1);
      }
      return;
    }

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
      rendered += i === cursorOffset ? chalk.inverse(value[i]) : value[i];
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
