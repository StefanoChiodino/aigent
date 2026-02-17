import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  model: string;
  messageCount: number;
  thinking?: string | undefined;
}

export function StatusBar({ model, messageCount, thinking }: StatusBarProps): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      justifyContent="space-between"
    >
      <Text>
        <Text color="magenta" bold>🌸 aigent</Text>
        <Text color="gray"> — </Text>
        <Text color="cyan">{model}</Text>
        {thinking && thinking !== 'off' && (
          <Text color="gray"> — thinking: <Text color="yellow">{thinking}</Text></Text>
        )}
      </Text>
      <Text color="gray">
        msgs: {messageCount} | /help | Ctrl+C to exit
      </Text>
    </Box>
  );
}
