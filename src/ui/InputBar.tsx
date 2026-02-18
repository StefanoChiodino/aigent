import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { TextInput } from './TextInput.js';
import type { TokenUsage, BackgroundTaskInfo } from '../protocol.js';

const SLASH_COMMANDS = [
  '/help', '/compact', '/refresh', '/reset', '/restart',
  '/reasoning on', '/reasoning off',
  '/effort low', '/effort medium', '/effort high', '/effort max',
  '/image ', '/usage', '/tasks',
  '/profiles', '/profile ', '/profile create ',
  '/save', '/sessions', '/load ',
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

function elapsed(startedAt: string): string {
  const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem > 0 ? `${rem}s` : ''}`;
}

export interface ToolExecution {
  name: string;
  input: string;
  summary: string;
}

/** A bordered row: │ content ... (padded) │ */
function BorderRow({ children, cols, borderColor }: { children: React.ReactNode; cols: number; borderColor: string }): React.JSX.Element {
  return (
    <Box width={cols}>
      <Text color={borderColor}>│ </Text>
      <Box flexGrow={1}>{children}</Box>
      <Text color={borderColor}> │</Text>
    </Box>
  );
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
  const maxStatusLinesRef = useRef(0);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (running.length === 0 && !isLoading) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running.length, isLoading]);

  useEffect(() => {
    if (running.length === 0 && !isLoading && activeTools.length === 0 && notifications.length === 0) {
      maxStatusLinesRef.current = 0;
    }
  }, [running.length, isLoading, activeTools.length, notifications.length]);

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

  // --- Top border status ---
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;

  let activityText = '';
  if (isLoading && !streaming && activeTools.length === 0 && !isThinking) {
    activityText = 'thinking…';
  } else if (isThinking) {
    activityText = 'reasoning…';
  } else if (activeTools.length > 0) {
    const tool = activeTools[activeTools.length - 1]!;
    activityText = tool.summary.length > 30 ? tool.summary.slice(0, 30) + '…' : tool.summary;
  }

  const statusParts: string[] = [];
  statusParts.push(`r:${effortLetter ? 'on ' + effortLetter : 'off'}`);
  const cost = usage?.cost ?? 0;
  if (cost > 0) statusParts.push(cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`);
  const contextUsed = usage?.contextTokens ?? 0;
  const contextWindow = 200_000;
  if (contextUsed > 0) {
    const pct = Math.round((contextUsed / contextWindow) * 100);
    statusParts.push(`${contextBar(contextUsed, contextWindow, 8)} ${formatTokens(contextUsed)}/${formatTokens(contextWindow)} (${pct}%)`);
  }
  const rightStatus = statusParts.join(' │ ');
  const needsSpinner = isLoading || running.length > 0;
  const spinnerW = needsSpinner ? 2 : 0;
  const sepW = activityText ? 3 : 0;
  const fillW = Math.max(0, cols - 4 - spinnerW - activityText.length - sepW - rightStatus.length);

  // --- Status rows ---
  const statusRows: React.JSX.Element[] = [];

  for (const task of running) {
    const maxDesc = cols - 16;
    const short = task.description.length > maxDesc ? task.description.slice(0, maxDesc) + '…' : task.description;
    statusRows.push(
      <BorderRow key={task.id} cols={cols} borderColor={borderColor}>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text color="gray"> {short} </Text>
        <Text color="gray" dimColor>({elapsed(task.startedAt)})</Text>
      </BorderRow>
    );
  }

  for (let i = 0; i < notifications.length; i++) {
    statusRows.push(
      <BorderRow key={`note-${i}`} cols={cols} borderColor={borderColor}>
        <Text color="yellow" dimColor>{notifications[i]!.slice(0, cols - 6)}</Text>
      </BorderRow>
    );
  }

  // Pad to prevent shrinking
  if (statusRows.length > maxStatusLinesRef.current) {
    maxStatusLinesRef.current = statusRows.length;
  }
  while (statusRows.length < maxStatusLinesRef.current) {
    statusRows.push(
      <BorderRow key={`pad-${statusRows.length}`} cols={cols} borderColor={borderColor}>
        <Text> </Text>
      </BorderRow>
    );
  }

  return (
    <Box flexDirection="column" width={cols}>
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">{suggestions.map((s) => s.trimEnd()).join('  ')}</Text>
        </Box>
      )}

      {/* Top border */}
      <Box width={cols}>
        <Text color={borderColor}>┌─</Text>
        {needsSpinner && <Text color="magenta"><Spinner type="dots" /></Text>}
        {needsSpinner && <Text> </Text>}
        {activityText ? <Text color={isLoading ? 'magenta' : 'gray'}>{activityText}</Text> : null}
        {activityText ? <Text color="gray"> │ </Text> : null}
        <Text color={borderColor}>{'─'.repeat(fillW)} </Text>
        <Text color="gray">{rightStatus}</Text>
        <Text color={borderColor}> ┐</Text>
      </Box>

      {/* Status rows */}
      {statusRows}

      {/* Separator */}
      {maxStatusLinesRef.current > 0 && (
        <Box width={cols}>
          <Text color={borderColor}>├{'─'.repeat(Math.max(0, cols - 2))}┤</Text>
        </Box>
      )}

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
