import { useState, useCallback } from 'react';
import { Box, Text, useStdout } from 'ink';
import { TextInput } from './TextInput.js';
import type { TokenUsage } from '../agent.js';

const SLASH_COMMANDS = [
  '/help',
  '/refresh',
  '/reset',
  '/reasoning on',
  '/reasoning off',
  '/effort low',
  '/effort medium',
  '/effort high',
  '/effort max',
  '/profiles',
  '/profile ',
  '/profile create ',
  '/save',
  '/sessions',
  '/load ',
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function contextBar(used: number, total: number, width: number): string {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

function commonPrefix(strings: string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0]!;
  for (let i = 1; i < strings.length; i++) {
    const s = strings[i]!;
    let j = 0;
    while (j < prefix.length && j < s.length && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
  }
  return prefix;
}

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
  thinking?: string | undefined;
  usage?: TokenUsage | undefined;
}

export function InputBar({ value, onChange, onSubmit, isLoading, thinking, usage }: InputBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const borderColor = isLoading ? 'gray' : 'cyan';
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const handleSubmit = (input: string): void => {
    setSuggestions([]);
    onChange('');
    onSubmit(input);
  };

  const handleChange = useCallback((newValue: string) => {
    if (suggestions.length > 0) {
      setSuggestions([]);
    }
    onChange(newValue);
  }, [onChange, suggestions.length]);

  const handleTab = useCallback((currentValue: string): string | null => {
    if (!currentValue.startsWith('/')) return null;

    const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(currentValue) && cmd !== currentValue);

    if (matches.length === 0) {
      setSuggestions([]);
      return null;
    }

    if (matches.length === 1) {
      setSuggestions([]);
      return matches[0]!;
    }

    setSuggestions(matches);
    const prefix = commonPrefix(matches);
    return prefix.length > currentValue.length ? prefix : null;
  }, []);

  // Status parts
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;
  const rText = effortLetter ? 'on' : 'off';

  const contextUsed = (usage?.input ?? 0) + (usage?.output ?? 0);
  const contextWindow = 200_000;
  const pct = contextUsed > 0 ? Math.round((contextUsed / contextWindow) * 100) : 0;
  const bar = contextBar(contextUsed, contextWindow, 12);
  const usedStr = formatTokens(contextUsed);
  const totalStr = formatTokens(contextWindow);

  // Measure status character width for border fill
  let statusLen = 2 + rText.length; // "r:" + "on"/"off"
  if (effortLetter) statusLen += 2; // " H"
  if (contextUsed > 0) {
    statusLen += 3 + 12 + 1 + usedStr.length + 1 + totalStr.length + 2 + String(pct).length + 2;
  }

  // Top: "┌ " + status + " " + ─fill + "┐"  →  2 + statusLen + 1 + fill + 1 = cols
  const fill = Math.max(0, cols - 4 - statusLen);

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">
            {suggestions.map((s) => s.trimEnd()).join('  ')}
          </Text>
        </Box>
      )}
      <Box>
        <Text color={borderColor}>{'\u250c '}</Text>
        <Text color="gray">r:<Text color="white">{rText}</Text></Text>
        {effortLetter && <Text color="gray"> {effortLetter}</Text>}
        {contextUsed > 0 && (
          <>
            <Text color="gray">{' | '}</Text>
            <Text color={pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green'}>{bar}</Text>
            <Text color="gray"> <Text color="white">{usedStr}</Text>/{totalStr} ({pct}%)</Text>
          </>
        )}
        <Text color={borderColor}>{' '}{'\u2500'.repeat(fill)}{'\u2510'}</Text>
      </Box>
      <Box>
        <Text color={borderColor}>{'\u2502 '}</Text>
        <Box flexGrow={1}>
          <Text color={isLoading ? 'gray' : 'cyan'} bold>{'> '}</Text>
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            onTab={handleTab}
            placeholder={isLoading ? 'Type to queue...' : 'Type a message...'}
          />
        </Box>
        <Text color={borderColor}>{' \u2502'}</Text>
      </Box>
      <Text color={borderColor}>{'\u2514'}{'\u2500'.repeat(Math.max(0, cols - 2))}{'\u2518'}</Text>
    </Box>
  );
}
