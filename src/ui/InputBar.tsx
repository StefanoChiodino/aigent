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
  ctrlCHint?: boolean | undefined;
  // Status — shown in the top border, single line
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

  // --- Build status segments for the top border ---
  const segments: Array<{ text: string; color: string }> = [];

  // Activity indicator
  if (isLoading && !streaming && activeTools.length === 0 && !isThinking) {
    segments.push({ text: 'thinking…', color: 'magenta' });
  } else if (isThinking) {
    segments.push({ text: 'reasoning…', color: 'magenta' });
  } else if (activeTools.length > 0) {
    const tool = activeTools[activeTools.length - 1]!;
    const desc = tool.summary.length > 30 ? tool.summary.slice(0, 30) + '…' : tool.summary;
    segments.push({ text: desc, color: 'gray' });
  }

  // Running tasks
  if (running.length > 0) {
    const taskDescs = running.map((t) => {
      const short = t.description.length > 20 ? t.description.slice(0, 20) + '…' : t.description;
      return `${short} (${elapsed(t.startedAt)})`;
    });
    segments.push({ text: `${running.length} task${running.length > 1 ? 's' : ''}: ${taskDescs.join(', ')}`, color: 'cyan' });
  }

  // Notifications (most recent only)
  if (notifications.length > 0) {
    const note = notifications[notifications.length - 1]!;
    const short = note.length > 40 ? note.slice(0, 40) + '…' : note;
    segments.push({ text: short, color: 'yellow' });
  }

  // Reasoning level
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;
  const rText = effortLetter ? 'on' : 'off';
  segments.push({ text: `r:${rText}${effortLetter ? ' ' + effortLetter : ''}`, color: 'gray' });

  // Cost
  const cost = usage?.cost ?? 0;
  if (cost > 0) {
    const costStr = cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
    segments.push({ text: costStr, color: 'yellow' });
  }

  // Context bar
  const contextUsed = usage?.contextTokens ?? 0;
  const contextWindow = 200_000;
  if (contextUsed > 0) {
    const pct = Math.round((contextUsed / contextWindow) * 100);
    const bar = contextBar(contextUsed, contextWindow, 10);
    const usedStr = formatTokens(contextUsed);
    const totalStr = formatTokens(contextWindow);
    segments.push({ text: `${bar} ${usedStr}/${totalStr} (${pct}%)`, color: pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green' });
  }

  // Calculate total status text length for border fill
  const statusText = segments.map((s) => s.text).join(' │ ');
  const fill = Math.max(0, cols - 4 - statusText.length - (segments.length - 1) * 0); // separators already in statusText

  // Render status with spinners for active items
  const needsSpinner = isLoading || running.length > 0;

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">
            {suggestions.map((s) => s.trimEnd()).join('  ')}
          </Text>
        </Box>
      )}
      {/* Top border with all status info */}
      <Box>
        <Text color={borderColor}>┌{'─'.repeat(Math.max(0, fill))}{' '}</Text>
        {needsSpinner && <Text color="magenta"><Spinner type="dots" /></Text>}
        {needsSpinner && <Text> </Text>}
        {segments.map((seg, i) => (
          <Text key={i}>
            {i > 0 && <Text color="gray"> │ </Text>}
            <Text color={seg.color}>{seg.text}</Text>
          </Text>
        ))}
        <Text color={borderColor}>{' ┐'}</Text>
      </Box>

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
