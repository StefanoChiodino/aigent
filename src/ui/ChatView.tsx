import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { renderMarkdown } from './Markdown.js';
import type { Message, ToolExecution } from './App.js';

interface ChatViewProps {
  messages: Message[];
  streaming: string;
  thinkingText: string;
  isLoading: boolean;
  isThinking: boolean;
  activeTools: ToolExecution[];
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  // Show last few lines of thinking, dimmed
  const lines = text.split('\n');
  const maxLines = 6;
  const shown = lines.length > maxLines
    ? ['...', ...lines.slice(-maxLines)]
    : lines;

  return (
    <Box flexDirection="column" marginLeft={3} marginBottom={0}>
      <Text color="gray" dimColor bold>thinking</Text>
      {shown.map((line, i) => (
        <Text key={i} color="gray" dimColor>  {line}</Text>
      ))}
    </Box>
  );
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

  // Assistant — render with markdown
  return (
    <Box flexDirection="column" marginY={0} marginLeft={1}>
      <Box>
        <Text color="magenta" bold>agent</Text>
        <Text color="gray"> {'>'} </Text>
      </Box>
      <Box marginLeft={2}>
        <Text>{renderMarkdown(message.content)}</Text>
      </Box>
      {message.elapsed !== undefined && (
        <Text color="gray" dimColor>  ({message.elapsed.toFixed(1)}s)</Text>
      )}
    </Box>
  );
}

export function ChatView({ messages, streaming, thinkingText, isLoading, isThinking, activeTools }: ChatViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg, i) => (
        <MessageBubble key={`msg-${i}-${msg.role}`} message={msg} />
      ))}

      {/* Thinking text — shown while reasoning */}
      {isThinking && thinkingText && (
        <ThinkingBlock text={thinkingText} />
      )}

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

      {/* Streaming text — render raw during streaming, markdown applied on completion */}
      {streaming && (
        <Box flexDirection="column" marginLeft={1}>
          <Box>
            <Text color="magenta" bold>agent</Text>
            <Text color="gray"> {'>'} </Text>
          </Box>
          <Box marginLeft={2}>
            <Text>{streaming}</Text>
            <Text color="gray">_</Text>
          </Box>
        </Box>
      )}

      {/* Loading spinner */}
      {isLoading && !streaming && activeTools.length === 0 && !isThinking && (
        <Box marginLeft={3}>
          <Text color="magenta">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> waiting...</Text>
        </Box>
      )}

      {/* Thinking spinner (no text yet) */}
      {isLoading && isThinking && !thinkingText && (
        <Box marginLeft={3}>
          <Text color="magenta">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> reasoning...</Text>
        </Box>
      )}
    </Box>
  );
}
