import React from 'react';
import { Box, Text } from 'ink';
import type { TokenUsage } from '../agent.js';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Context window sizes by model family
const CONTEXT_WINDOWS: Record<string, number> = {
  'opus-4-6': 200_000,
  'opus-4.6': 200_000,
  'sonnet': 200_000,
  'haiku': 200_000,
};

function getContextWindow(model: string): number {
  for (const [key, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (model.includes(key)) return size;
  }
  return 200_000; // default
}

function contextBar(used: number, total: number, width: number): string {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  return bar;
}

interface StatusBarProps {
  thinking?: string | undefined;
  usage: TokenUsage;
  model?: string | undefined;
}

export function StatusBar({ thinking, usage, model }: StatusBarProps): React.JSX.Element {
  const contextUsed = usage.input + usage.output;
  const contextWindow = getContextWindow(model ?? '');
  const pct = contextUsed > 0 ? Math.round((contextUsed / contextWindow) * 100) : 0;

  const thinkingLabel = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? thinking
    : null;

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Text>
        {thinkingLabel && (
          <Text color="gray">reasoning:<Text color="white">{thinkingLabel}</Text></Text>
        )}
        {contextUsed > 0 && (
          <Text color="gray">
            {thinkingLabel ? ' | ' : ''}
            <Text color={pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green'}>{contextBar(contextUsed, contextWindow, 12)}</Text>
            {' '}
            <Text color="white">{formatTokens(contextUsed)}</Text>
            /{formatTokens(contextWindow)} ({pct}%)
          </Text>
        )}
      </Text>
      <Text color="gray">/help</Text>
    </Box>
  );
}
