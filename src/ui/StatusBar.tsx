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

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>
        <Text bold>aigent</Text>
        {thinking && thinking !== 'off' && (
          <>
            <Text color="gray"> | reasoning: </Text>
            <Text color="yellow">{thinking}</Text>
          </>
        )}
      </Text>
      <Text color="gray">
        {totalTokens > 0 && (
          <>
            <Text color="green">in:{formatTokens(usage.input)}</Text>
            <Text> </Text>
            <Text color="cyan">out:{formatTokens(usage.output)}</Text>
            {usage.cacheRead > 0 && (
              <>
                <Text> </Text>
                <Text color="gray">cache:{formatTokens(usage.cacheRead)}</Text>
              </>
            )}
            <Text> | </Text>
          </>
        )}
        /help | Ctrl+C
      </Text>
    </Box>
  );
}
