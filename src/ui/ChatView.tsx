import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { Message, ToolExecution } from './App.js';

interface ChatViewProps {
  messages: Message[];
  streaming: string;
  isLoading: boolean;
  activeTools: ToolExecution[];
}

function MessageBubble({ message }: { message: Message }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <Box marginY={0} marginLeft={1}>
        <Text>
          <Text color="blue" bold>you</Text>
          <Text color="gray"> {'>'} </Text>
          <Text>{message.content}</Text>
        </Text>
      </Box>
    );
  }

  if (message.role === 'system') {
    return (
      <Box marginY={0} marginLeft={1}>
        <Text color="yellow" dimColor>{message.content}</Text>
      </Box>
    );
  }

  // Assistant
  return (
    <Box flexDirection="column" marginY={0} marginLeft={1}>
      <Text>
        <Text color="magenta" bold>agent</Text>
        <Text color="gray"> {'>'} </Text>
        <Text>{message.content}</Text>
      </Text>
      {message.elapsed !== undefined && (
        <Text color="gray" dimColor>      ({message.elapsed.toFixed(1)}s)</Text>
      )}
    </Box>
  );
}

export function ChatView({ messages, streaming, isLoading, activeTools }: ChatViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg, i) => (
        <MessageBubble key={`msg-${i}-${msg.role}`} message={msg} />
      ))}

      {/* Active tool executions */}
      {activeTools.length > 0 && (
        <Box flexDirection="column" marginLeft={3}>
          {activeTools.map((tool, i) => (
            <Text key={`tool-${i}-${tool.name}`} color="gray" dimColor>
              {tool.summary}
            </Text>
          ))}
        </Box>
      )}

      {/* Streaming text */}
      {streaming && (
        <Box marginLeft={1}>
          <Text>
            <Text color="magenta" bold>agent</Text>
            <Text color="gray"> {'>'} </Text>
            <Text>{streaming}</Text>
            <Text color="gray">_</Text>
          </Text>
        </Box>
      )}

      {/* Loading spinner */}
      {isLoading && !streaming && activeTools.length === 0 && (
        <Box marginLeft={3}>
          <Text color="magenta">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> thinking...</Text>
        </Box>
      )}
    </Box>
  );
}
