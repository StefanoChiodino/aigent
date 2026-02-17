import { Box, Text } from 'ink';
import { TextInput } from './TextInput.js';
import type { TokenUsage } from '../agent.js';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function getContextWindow(_model: string): number {
  return 200_000; // all current Claude models
}

function contextBar(used: number, total: number, width: number): string {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  isLoading: boolean;
  thinking?: string | undefined;
  usage?: TokenUsage | undefined;
  model?: string | undefined;
}

export function InputBar({ value, onChange, onSubmit, isLoading, thinking, usage, model }: InputBarProps): React.JSX.Element {
  const handleSubmit = (input: string): void => {
    if (isLoading) return;
    onChange('');
    onSubmit(input);
  };

  const contextUsed = (usage?.input ?? 0) + (usage?.output ?? 0);
  const contextWindow = getContextWindow(model ?? '');
  const pct = contextUsed > 0 ? Math.round((contextUsed / contextWindow) * 100) : 0;

  const effortLabel = thinking && thinking !== 'off'
    ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[thinking] ?? thinking
    : null;

  // Build compact status string for the right side
  const statusParts: React.JSX.Element[] = [];

  if (effortLabel) {
    statusParts.push(
      <Text key="r" color="gray">r:<Text color="white">{effortLabel}</Text></Text>
    );
  } else {
    statusParts.push(
      <Text key="r" color="gray">r:<Text color="white">off</Text></Text>
    );
  }

  if (contextUsed > 0) {
    statusParts.push(
      <Text key="ctx" color="gray">
        {' '}
        <Text color={pct > 80 ? 'red' : pct > 50 ? 'yellow' : 'green'}>{contextBar(contextUsed, contextWindow, 8)}</Text>
        {' '}<Text color="white">{formatTokens(contextUsed)}</Text>
        <Text color="gray">/{formatTokens(contextWindow)}</Text>
      </Text>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={isLoading ? 'gray' : 'cyan'} paddingX={1}>
      <Box justifyContent="space-between">
        <Box flexGrow={1}>
          <Text color={isLoading ? 'gray' : 'cyan'} bold>{'> '}</Text>
          {isLoading ? (
            <Text color="gray" dimColor>waiting for response...</Text>
          ) : (
            <TextInput
              value={value}
              onChange={onChange}
              onSubmit={handleSubmit}
              placeholder="Type a message..."
            />
          )}
        </Box>
        <Box flexShrink={0} marginLeft={1}>
          {statusParts}
        </Box>
      </Box>
    </Box>
  );
}
