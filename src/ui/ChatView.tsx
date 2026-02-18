import { Box, Text, Static, useStdout } from 'ink';
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
  toolOutput: string;
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const lines = text.split('\n');
  const maxLines = 6;
  const shown = lines.length > maxLines
    ? ['...', ...lines.slice(-maxLines)]
    : lines;

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color="gray" dimColor bold>thinking</Text>
      {shown.map((line, i) => (
        <Text key={i} color="gray" dimColor>  {line}</Text>
      ))}
    </Box>
  );
}

function UserMessage({ content, cols }: { content: string; cols: number }): React.JSX.Element {
  // Right-aligned, with a max width
  const maxWidth = Math.min(Math.floor(cols * 0.7), cols - 4);

  return (
    <Box justifyContent="flex-end" paddingRight={1} marginY={0}>
      <Box flexDirection="column" width={maxWidth}>
        <Box justifyContent="flex-end">
          <Text color="blue" dimColor>you</Text>
        </Box>
        <Box justifyContent="flex-end">
          <Text color="white">{content}</Text>
        </Box>
      </Box>
    </Box>
  );
}

function AssistantMessage({ content, elapsed }: { content: string; elapsed?: number | undefined }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginY={0} paddingLeft={1}>
      <Text color="magenta" dimColor>agent</Text>
      <Box marginLeft={1}>
        <Text>{renderMarkdown(content)}</Text>
      </Box>
      {elapsed !== undefined && (
        <Text color="gray" dimColor> ({elapsed.toFixed(1)}s)</Text>
      )}
    </Box>
  );
}

function SystemMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <Box justifyContent="center" marginY={0}>
      <Text color="yellow" dimColor>{content}</Text>
    </Box>
  );
}

function MessageBubble({ message, cols }: { message: Message; cols: number }): React.JSX.Element {
  if (message.role === 'user') {
    return <UserMessage content={message.content} cols={cols} />;
  }
  if (message.role === 'system') {
    return <SystemMessage content={message.content} />;
  }
  return <AssistantMessage content={message.content} elapsed={message.elapsed} />;
}

export function ChatView({ messages, streaming, thinkingText, isLoading, isThinking, activeTools, toolOutput }: ChatViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  // Completed messages are rendered once via <Static> and pushed into
  // terminal scrollback. This prevents re-renders from yanking the viewport
  // when the user has scrolled up to read older messages.
  const staticMessages = messages.map((msg, i) => ({
    id: `msg-${i}-${msg.role}-${msg.timestamp.getTime()}`,
    msg,
  }));

  return (
    <Box flexDirection="column" flexGrow={1}>
      {/* Completed messages — rendered once, never re-rendered */}
      <Static items={staticMessages}>
        {(item) => (
          <Box key={item.id} width={cols}>
            <MessageBubble message={item.msg} cols={cols} />
          </Box>
        )}
      </Static>

      {/* Active content below — this is the only part that re-renders */}

      {/* Thinking text */}
      {isThinking && thinkingText && (
        <ThinkingBlock text={thinkingText} />
      )}

      {/* Active tool executions */}
      {activeTools.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {activeTools.map((tool, i) => (
            <Text key={`tool-${i}-${tool.name}`} color="gray" dimColor>
              {tool.summary}
            </Text>
          ))}
        </Box>
      )}

      {/* Streaming tool output (e.g. exec) */}
      {toolOutput && activeTools.length > 0 && (
        <Box flexDirection="column" marginLeft={4}>
          {toolOutput.split('\n').slice(-8).map((line, i) => (
            <Text key={`tout-${i}`} color="gray" dimColor>{line}</Text>
          ))}
        </Box>
      )}

      {/* Streaming text */}
      {streaming && (
        <Box flexDirection="column" paddingLeft={1}>
          <Text color="magenta" dimColor>agent</Text>
          <Box marginLeft={1}>
            <Text>{streaming}</Text>
            <Text color="gray">_</Text>
          </Box>
        </Box>
      )}

      {/* Loading spinner */}
      {isLoading && !streaming && activeTools.length === 0 && !isThinking && (
        <Box marginLeft={2}>
          <Text color="magenta">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> waiting...</Text>
        </Box>
      )}

      {/* Thinking spinner (no text yet) */}
      {isLoading && isThinking && !thinkingText && (
        <Box marginLeft={2}>
          <Text color="magenta">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> reasoning...</Text>
        </Box>
      )}
    </Box>
  );
}
