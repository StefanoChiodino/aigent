import { useState, useCallback } from 'react';
import { Box, Text, useStdout } from 'ink';
import { TextInput } from './TextInput.js';
import type { TokenUsage, BackgroundTaskInfo } from '../protocol.js';

const SLASH_COMMANDS = [
  '/help', '/compact', '/refresh', '/reset', '/restart',
  '/reasoning on', '/reasoning off',
  '/effort low', '/effort medium', '/effort high', '/effort max',
  '/image ', '/usage', '/tasks',
  '/profiles', '/profile ', '/profile create ',
  '/save', '/sessions', '/load ',
  '/mount ', '/unmount ', '/mounts',
  '/grant ', '/deny ',
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

export interface ToolExecution {
  name: string;
  input: string;
  summary: string;
}

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
  thinking?: string | undefined;
  usage?: TokenUsage | undefined;
  ctrlCHint?: boolean | undefined;
  isThinking?: boolean | undefined;
  activeTools?: ToolExecution[] | undefined;
  streaming?: boolean | undefined;
  tasks?: BackgroundTaskInfo[] | undefined;
  notifications?: string[] | undefined;
}

export function InputBar({
  value, onChange, onSubmit, isLoading, thinking, usage,
  ctrlCHint = false,
  isThinking = false, activeTools = [],
  streaming = false, tasks = [], notifications = [],
}: InputBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const borderColor = isLoading ? 'gray' : 'cyan';
  const [suggestions, setSuggestions] = useState<string[]>([]);

  const running = tasks.filter((t) => t.status === 'running');

  const handleSubmit = (input: string): void => {
    setSuggestions([]);
    onChange('');
    onSubmit(input);
  };

  const handleChange = useCallback((newValue: string) => {
    if (suggestions.length > 0) setSuggestions([]);
    onChange(newValue);
  }, [onChange, suggestions.length]);

  const handleTab = useCallback((currentValue: string): string | null => {
    if (!currentValue.startsWith('/')) return null;
    const matches = SLASH_COMMANDS.filter((cmd) => cmd.startsWith(currentValue) && cmd !== currentValue);
    if (matches.length === 0) { setSuggestions([]); return null; }
    if (matches.length === 1) { setSuggestions([]); return matches[0]!; }
    setSuggestions(matches);
    const prefix = commonPrefix(matches);
    return prefix.length > currentValue.length ? prefix : null;
  }, []);

  // --- Build the single status line for the top border ---
  const parts: string[] = [];

  // Activity
  if (isLoading && !streaming && activeTools.length === 0 && !isThinking) {
    parts.push('⟳ thinking');
  } else if (isThinking) {
    parts.push('⟳ reasoning');
  } else if (activeTools.length > 0) {
    const tool = activeTools[activeTools.length - 1]!;
    const desc = tool.summary.length > 25 ? tool.summary.slice(0, 25) + '…' : tool.summary;
    parts.push('⟳ ' + desc);
  }

  // Tasks
  if (running.length > 0) {
    parts.push(`${running.length} task${running.length > 1 ? 's' : ''} running`);
  }

  // Notifications
  if (notifications.length > 0) {
    const note = notifications[notifications.length - 1]!;
    const short = note.length > 35 ? note.slice(0, 35) + '…' : note;
    parts.push(short);
  }

  // Reasoning
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;
  parts.push(`r:${effortLetter ? 'on ' + effortLetter : 'off'}`);

  // Cost
  const cost = usage?.cost ?? 0;
  if (cost > 0) parts.push(cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`);

  // Context
  const contextUsed = usage?.contextTokens ?? 0;
  const contextWindow = 200_000;
  if (contextUsed > 0) {
    const pct = Math.round((contextUsed / contextWindow) * 100);
    parts.push(`${contextBar(contextUsed, contextWindow, 8)} ${formatTokens(contextUsed)}/${formatTokens(contextWindow)} (${pct}%)`);
  }

  const statusText = parts.join(' │ ');
  const fillW = Math.max(0, cols - 4 - statusText.length);

  return (
    <Box flexDirection="column" width={cols}>
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">{suggestions.map((s) => s.trimEnd()).join('  ')}</Text>
        </Box>
      )}

      {/* Top border — single line, no spinners, no timers */}
      <Box width={cols}>
        <Text color={borderColor}>┌{'─'.repeat(fillW)} </Text>
        <Text color="gray">{statusText}</Text>
        <Text color={borderColor}> ┐</Text>
      </Box>

      {/* Input row */}
      <Box width={cols}>
        <Text color={borderColor}>│ </Text>
        <Box flexGrow={1}>
          <Text color={isLoading ? 'gray' : 'cyan'} bold>{'> '}</Text>
          <TextInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            onTab={handleTab}
            placeholder={ctrlCHint ? 'Press Ctrl+C again to exit...' : isLoading ? 'Type to queue...' : 'Type a message...'}
          />
        </Box>
        <Text color={borderColor}> │</Text>
      </Box>

      {/* Bottom border */}
      <Box width={cols}>
        <Text color={borderColor}>└{'─'.repeat(Math.max(0, cols - 2))}┘</Text>
      </Box>
    </Box>
  );
}
