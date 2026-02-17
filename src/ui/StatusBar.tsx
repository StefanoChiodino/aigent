import React from 'react';
import { Box, Text } from 'ink';
import type { TokenUsage } from '../agent.js';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

interface StatusBarProps {
  thinking?: string | undefined;
  usage: TokenUsage;
}

export function StatusBar({ thinking, usage }: StatusBarProps): React.JSX.Element {
  const totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

  const parts: string[] = [];
  if (thinking && thinking !== 'off') parts.push(`reasoning:${thinking}`);
  if (totalTokens > 0) {
    let tokens = `in:${formatTokens(usage.input)} out:${formatTokens(usage.output)}`;
    if (usage.cacheRead > 0) tokens += ` cache:${formatTokens(usage.cacheRead)}`;
    parts.push(tokens);
  }
  parts.push('/help');

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="gray">{parts.join(' | ')}</Text>
    </Box>
  );
}
