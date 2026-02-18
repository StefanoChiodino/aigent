import { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { TextInput } from './TextInput.js';
import type { TokenUsage, BackgroundTaskInfo } from '../protocol.js';

const SLASH_COMMANDS = [
  '/help',
  '/compact',
  '/refresh',
  '/reset',
  '/restart',
  '/reasoning on',
  '/reasoning off',
  '/effort low',
  '/effort medium',
  '/effort high',
  '/effort max',
  '/image ',
  '/usage',
  '/tasks',
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

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
  thinking?: string | undefined;
  usage?: TokenUsage | undefined;
  ctrlCHint?: boolean | undefined;
  // Status
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

  // Track max status lines we've shown so we can pad to prevent shrinking
  const maxStatusLinesRef = useRef(0);

  // Tick every second to update task elapsed times
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running.length === 0 && !isLoading) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running.length, isLoading]);

  // Reset max lines when nothing is active
  useEffect(() => {
    if (running.length === 0 && !isLoading && activeTools.length === 0) {
      maxStatusLinesRef.current = 0;
    }
  }, [running.length, isLoading, activeTools.length]);

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

  // --- Top border status ---
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;
  const rText = effortLetter ? 'on' : 'off';

  const contextUsed = usage?.contextTokens ?? 0;
  const contextWindow = 200_000;
  const pct = contextUsed > 0 ? Math.round((contextUsed / contextWindow) * 100) : 0;
  const cost = usage?.cost ?? 0;
  const costStr = cost > 0 ? (cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`) : '';

  // Activity text for top border
  let activityText = '';
  if (isLoading && !streaming && activeTools.length === 0 && !isThinking) {
    activityText = 'thinking…';
  } else if (isThinking) {
    activityText = 'reasoning…';
  } else if (activeTools.length > 0) {
    const tool = activeTools[activeTools.length - 1]!;
    activityText = tool.summary.length > 30 ? tool.summary.slice(0, 30) + '…' : tool.summary;
  }

  // Build concise top-right status string
  const statusParts: string[] = [];
  statusParts.push(`r:${rText}${effortLetter ? ' ' + effortLetter : ''}`);
  if (costStr) statusParts.push(costStr);
  if (contextUsed > 0) {
    const bar = contextBar(contextUsed, contextWindow, 8);
    statusParts.push(`${bar} ${formatTokens(contextUsed)}/${formatTokens(contextWindow)} (${pct}%)`);
  }
  const rightStatus = statusParts.join(' │ ');

  // Left side: activity
  const needsSpinner = isLoading || running.length > 0;
  const leftContent = activityText;
  const spinnerWidth = needsSpinner ? 2 : 0;
  const leftWidth = leftContent.length + spinnerWidth;
  const rightWidth = rightStatus.length;
  const fillWidth = Math.max(0, cols - 4 - leftWidth - rightWidth - (leftContent ? 3 : 0));

  // --- Status lines (tasks + notifications) ---
  const statusLines: React.JSX.Element[] = [];

  for (const task of running) {
    const short = task.description.length > cols - 15
      ? task.description.slice(0, cols - 15) + '…'
      : task.description;
    statusLines.push(
      <Box key={task.id}>
        <Text color={borderColor}>│ </Text>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text color="gray"> {short} </Text>
        <Text color="gray" dimColor>({elapsed(task.startedAt)})</Text>
      </Box>
    );
  }

  for (let i = 0; i < notifications.length; i++) {
    statusLines.push(
      <Box key={`note-${i}`}>
        <Text color={borderColor}>│ </Text>
        <Text color="yellow" dimColor>  {notifications[i]!.slice(0, cols - 6)}</Text>
      </Box>
    );
  }

  // Pad to max height to prevent shrinking
  if (statusLines.length > maxStatusLinesRef.current) {
    maxStatusLinesRef.current = statusLines.length;
  }
  while (statusLines.length < maxStatusLinesRef.current) {
    statusLines.push(
      <Box key={`pad-${statusLines.length}`}>
        <Text color={borderColor}>│</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">
            {suggestions.map((s) => s.trimEnd()).join('  ')}
          </Text>
        </Box>
      )}
      {/* Top border */}
      <Box>
        <Text color={borderColor}>┌─</Text>
        {needsSpinner && <Text color="magenta"><Spinner type="dots" /></Text>}
        {needsSpinner && <Text> </Text>}
        {leftContent && <Text color={isLoading ? 'magenta' : 'gray'}>{leftContent}</Text>}
        {leftContent && <Text color="gray"> │ </Text>}
        <Text color={borderColor}>{'─'.repeat(fillWidth)} </Text>
        <Text color="gray">{rightStatus}</Text>
        <Text color={borderColor}> ┐</Text>
      </Box>

      {/* Status lines (tasks, notifications) */}
      {statusLines}

      {/* Separator if we have status lines */}
      {maxStatusLinesRef.current > 0 && (
        <Box>
          <Text color={borderColor}>├{'─'.repeat(Math.max(0, cols - 2))}┤</Text>
        </Box>
      )}

      {/* Input line */}
      <Box>
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
      <Text color={borderColor}>└{'─'.repeat(Math.max(0, cols - 2))}┘</Text>
    </Box>
  );
}
