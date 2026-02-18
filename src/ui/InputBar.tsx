import { useState, useCallback, useEffect } from 'react';
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
  runningTasks?: number | undefined;
  ctrlCHint?: boolean | undefined;
  // Status content — lives inside the box
  isThinking?: boolean | undefined;
  thinkingText?: string | undefined;
  activeTools?: ToolExecution[] | undefined;
  toolOutput?: string | undefined;
  streaming?: boolean | undefined;
  tasks?: BackgroundTaskInfo[] | undefined;
  notifications?: string[] | undefined;
}

export function InputBar({
  value, onChange, onSubmit, isLoading, thinking, usage,
  runningTasks = 0, ctrlCHint = false,
  isThinking = false, thinkingText = '', activeTools = [],
  toolOutput = '', streaming = false, tasks = [], notifications = [],
}: InputBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const borderColor = isLoading ? 'gray' : 'cyan';
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const innerWidth = Math.max(0, cols - 4); // space inside the box borders

  const running = tasks.filter((t) => t.status === 'running');

  // Tick every second to update task elapsed times
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

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

  // Status parts for the top border
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;
  const rText = effortLetter ? 'on' : 'off';

  const contextUsed = usage?.contextTokens ?? 0;
  const contextWindow = 200_000;
  const pct = contextUsed > 0 ? Math.round((contextUsed / contextWindow) * 100) : 0;
  const bar = contextBar(contextUsed, contextWindow, 12);
  const usedStr = formatTokens(contextUsed);
  const totalStr = formatTokens(contextWindow);
  const cost = usage?.cost ?? 0;
  const costStr = cost > 0 ? (cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`) : '';
  const taskStr = runningTasks > 0 ? `${runningTasks} task${runningTasks > 1 ? 's' : ''}` : '';

  let statusLen = 2 + rText.length;
  if (effortLetter) statusLen += 2;
  if (taskStr) statusLen += 3 + taskStr.length;
  if (costStr) statusLen += 3 + costStr.length;
  if (contextUsed > 0) {
    statusLen += 3 + 12 + 1 + usedStr.length + 1 + totalStr.length + 2 + String(pct).length + 2;
  }

  const fill = Math.max(0, cols - 4 - statusLen);

  // Build status lines that go inside the box
  const statusLines: React.JSX.Element[] = [];

  // Thinking
  if (isThinking && thinkingText) {
    const lines = thinkingText.split('\n').slice(-3);
    statusLines.push(
      <Box key="thinking" flexDirection="column">
        <Box>
          <Text color={borderColor}>│ </Text>
          <Text color="gray" dimColor><Spinner type="dots" /> thinking</Text>
          <Box flexGrow={1} />
          <Text color={borderColor}> │</Text>
        </Box>
        {lines.map((line, i) => (
          <Box key={`t-${i}`}>
            <Text color={borderColor}>│ </Text>
            <Text color="gray" dimColor>  {line.slice(0, innerWidth)}</Text>
            <Box flexGrow={1} />
            <Text color={borderColor}> │</Text>
          </Box>
        ))}
      </Box>
    );
  }

  // Active tools
  if (activeTools.length > 0) {
    for (let i = 0; i < activeTools.length; i++) {
      const tool = activeTools[i]!;
      statusLines.push(
        <Box key={`tool-${i}`}>
          <Text color={borderColor}>│ </Text>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="gray"> {tool.summary.slice(0, innerWidth - 2)}</Text>
          <Box flexGrow={1} />
          <Text color={borderColor}> │</Text>
        </Box>
      );
    }
  }

  // Tool output
  if (toolOutput && activeTools.length > 0) {
    const lines = toolOutput.split('\n').slice(-4);
    for (let i = 0; i < lines.length; i++) {
      statusLines.push(
        <Box key={`tout-${i}`}>
          <Text color={borderColor}>│ </Text>
          <Text color="gray" dimColor>  {(lines[i] ?? '').slice(0, innerWidth)}</Text>
          <Box flexGrow={1} />
          <Text color={borderColor}> │</Text>
        </Box>
      );
    }
  }

  // Loading spinner (no streaming, no tools, no thinking)
  if (isLoading && !streaming && activeTools.length === 0 && !isThinking) {
    statusLines.push(
      <Box key="loading">
        <Text color={borderColor}>│ </Text>
        <Text color="magenta"><Spinner type="dots" /></Text>
        <Text color="gray"> thinking...</Text>
        <Box flexGrow={1} />
        <Text color={borderColor}> │</Text>
      </Box>
    );
  }

  // Thinking spinner (no text yet)
  if (isLoading && isThinking && !thinkingText) {
    statusLines.push(
      <Box key="reasoning">
        <Text color={borderColor}>│ </Text>
        <Text color="magenta"><Spinner type="dots" /></Text>
        <Text color="gray"> reasoning...</Text>
        <Box flexGrow={1} />
        <Text color={borderColor}> │</Text>
      </Box>
    );
  }

  // Running background tasks
  for (const task of running) {
    const desc = task.description.slice(0, innerWidth - 10);
    statusLines.push(
      <Box key={task.id}>
        <Text color={borderColor}>│ </Text>
        <Text color="cyan"><Spinner type="dots" /></Text>
        <Text color="gray"> {desc} </Text>
        <Text color="gray" dimColor>({elapsed(task.startedAt)})</Text>
        <Box flexGrow={1} />
        <Text color={borderColor}> │</Text>
      </Box>
    );
  }

  // Notifications
  for (let i = 0; i < notifications.length; i++) {
    statusLines.push(
      <Box key={`note-${i}`}>
        <Text color={borderColor}>│ </Text>
        <Text color="yellow" dimColor>{notifications[i]!.slice(0, innerWidth)}</Text>
        <Box flexGrow={1} />
        <Text color={borderColor}> │</Text>
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
      {/* Top border with status indicators */}
      <Box>
        <Text color={borderColor}>{'\u250c'}{'\u2500'.repeat(fill)}{' '}</Text>
        <Text color="gray">r:<Text color="white">{rText}</Text></Text>
        {effortLetter && <Text color="gray"> {effortLetter}</Text>}
        {taskStr && (
          <>
            <Text color="gray">{' | '}</Text>
            <Text color="cyan">{taskStr}</Text>
          </>
        )}
        {costStr && (
          <>
            <Text color="gray">{' | '}</Text>
            <Text color="yellow">{costStr}</Text>
          </>
        )}
        {contextUsed > 0 && (
          <>
            <Text color="gray">{' | '}</Text>
            <Text color={pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green'}>{bar}</Text>
            <Text color="gray"> <Text color="white">{usedStr}</Text>/{totalStr} ({pct}%)</Text>
          </>
        )}
        <Text color={borderColor}>{' \u2510'}</Text>
      </Box>

      {/* Status lines inside the box */}
      {statusLines}

      {/* Separator if there are status lines */}
      {statusLines.length > 0 && (
        <Box>
          <Text color={borderColor}>├{'─'.repeat(Math.max(0, cols - 2))}┤</Text>
        </Box>
      )}

      {/* Input line */}
      <Box>
        <Text color={borderColor}>{'\u2502 '}</Text>
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
        <Text color={borderColor}>{' \u2502'}</Text>
      </Box>
      <Text color={borderColor}>{'\u2514'}{'\u2500'.repeat(Math.max(0, cols - 2))}{'\u2518'}</Text>
    </Box>
  );
}
