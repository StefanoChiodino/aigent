import { Box, Text } from 'ink';

interface StatusBarProps {
  model: string;
  messageCount: number;
}

export function StatusBar({ model, messageCount }: StatusBarProps): React.JSX.Element {
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
      </Text>
      <Text color="gray">
        msgs: {messageCount} | /help | Ctrl+C to exit
      </Text>
    </Box>
  );
}
