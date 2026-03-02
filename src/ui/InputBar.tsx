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
  '/grant ', '/deny ',
  '/approve ', '/reject ', '/preview ',
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
  streaming?: string | undefined;
  tasks?: BackgroundTaskInfo[] | undefined;
  notifications?: string[] | undefined;
  error?: string | undefined;
}

/**
 * InputBar — FIXED 4-LINE component. The ONLY live (non-Static) element.
 *
 * Line 1: ┌── status ─── context/cost ┐
 * Line 2: │ streaming preview / status │
 * Line 3: │ > input                   │
 * Line 4: └───────────────────────────┘
 *
 * Height NEVER changes. This prevents ink re-render artifacts.
 */
export function InputBar({
  value, onChange, onSubmit, isLoading, thinking, usage,
  ctrlCHint = false,
  isThinking = false, activeTools = [],
  streaming, tasks = [], notifications = [],
  error,
}: InputBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const borderColor = isLoading ? 'gray' : 'cyan';
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const innerWidth = cols - 4; // space between │ and │

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

  // --- Top border status (right side) ---
  const effortLetter = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? '?'
    : null;

  const statusParts: string[] = [];
  statusParts.push(`r:${effortLetter ? 'on ' + effortLetter : 'off'}`);
  if (running.length > 0) statusParts.push(`${running.length} task${running.length > 1 ? 's' : ''}`);
  const cost = usage?.cost ?? 0;
  if (cost > 0) statusParts.push(cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`);
  const contextUsed = usage?.contextTokens ?? 0;
  const contextWindow = (() => { const e = process.env['AIGENT_CONTEXT_WINDOW']; if (e) { const n = parseInt(e, 10); if (!isNaN(n) && n > 0) return n; } return 200_000; })();
  if (contextUsed > 0) {
    const pct = Math.round((contextUsed / contextWindow) * 100);
    statusParts.push(`${contextBar(contextUsed, contextWindow, 8)} ${formatTokens(contextUsed)}/${formatTokens(contextWindow)} (${pct}%)`);
  }
  const rightStatus = statusParts.join(' │ ');
  const fillW = Math.max(0, cols - 4 - rightStatus.length);

  // --- Middle line: streaming preview OR status info ---
  let middleContent: React.JSX.Element;
  if (error) {
    const errText = error.length > innerWidth ? error.slice(0, innerWidth - 1) + '…' : error;
    middleContent = <Text color="yellow">{errText}</Text>;
  } else if (streaming) {
    // Show last line of streaming text, truncated to fit
    const lines = streaming.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    const preview = lastLine.length > innerWidth - 2
      ? lastLine.slice(lastLine.length - innerWidth + 2)
      : lastLine;
    middleContent = (
      <>
        <Text color="magenta" dimColor>{'▸ '}</Text>
        <Text>{preview}</Text>
        <Text color="gray">_</Text>
      </>
    );
  } else if (isLoading) {
    // Show what we're doing
    let activity = '⟳ thinking…';
    if (isThinking) {
      activity = '⟳ reasoning…';
    } else if (activeTools.length > 0) {
      const tool = activeTools[activeTools.length - 1]!;
      const desc = tool.summary.length > innerWidth - 4 ? tool.summary.slice(0, innerWidth - 5) + '…' : tool.summary;
      activity = '⟳ ' + desc;
    }

    middleContent = <Text color="magenta">{activity}</Text>;
  } else if (notifications.length > 0) {
    const note = notifications[notifications.length - 1]!;
    const short = note.length > innerWidth ? note.slice(0, innerWidth - 1) + '…' : note;
    middleContent = <Text color="yellow" dimColor>{short}</Text>;
  } else {
    middleContent = <Text> </Text>;
  }

  return (
    <Box flexDirection="column" width={cols}>
      {suggestions.length > 0 && (
        <Box paddingX={2}>
          <Text color="gray">{suggestions.map((s) => s.trimEnd()).join('  ')}</Text>
        </Box>
      )}

      {/* Line 1: Top border */}
      <Box width={cols}>
        <Text color={borderColor}>{'┌' + '─'.repeat(fillW) + ' '}</Text>
        <Text color="gray">{rightStatus}</Text>
        <Text color={borderColor}>{' ┐'}</Text>
      </Box>

      {/* Line 2: Status / streaming preview */}
      <Box width={cols}>
        <Text color={borderColor}>{'│ '}</Text>
        <Box flexGrow={1} width={innerWidth}>
          {middleContent}
        </Box>
        <Text color={borderColor}>{' │'}</Text>
      </Box>

      {/* Line 3: Input */}
      <Box width={cols}>
        <Text color={borderColor}>{'│ '}</Text>
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
        <Text color={borderColor}>{' │'}</Text>
      </Box>

      {/* Line 4: Bottom border */}
      <Box width={cols}>
        <Text color={borderColor}>{'└' + '─'.repeat(Math.max(0, cols - 2)) + '┘'}</Text>
      </Box>
    </Box>
  );
}
