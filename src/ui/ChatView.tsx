import { Box, Text, Static, useStdout } from 'ink';
import { renderMarkdown } from './Markdown.js';
import type { Message } from './App.js';

interface ChatViewProps {
  messages: Message[];
}

function UserMessage({ content, cols }: { content: string; cols: number }): React.JSX.Element {
  const maxWidth = Math.min(Math.floor(cols * 0.7), cols - 4);

  return (
    <Box flexDirection="column" marginY={0}>
      <Box justifyContent="flex-end">
        <Text color="cyan" dimColor>you</Text>
      </Box>
      <Box justifyContent="flex-end">
        <Box
          flexDirection="column"
          width={maxWidth}
          borderStyle="bold"
          borderRight
          borderLeft={false}
          borderTop={false}
          borderBottom={false}
          borderColor="cyan"
          borderDimColor
        >
          <Box justifyContent="flex-end">
            <Text>{renderMarkdown(content)}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function AssistantMessage({ content, elapsed, cols }: { content: string; elapsed?: number | undefined; cols: number }): React.JSX.Element {
  const maxWidth = Math.min(Math.floor(cols * 0.7), cols - 4);

  return (
    <Box flexDirection="column" marginY={0}>
      <Box>
        <Text color="magenta" dimColor>
          agent
          {elapsed !== undefined && (
            <Text color="gray" dimColor> ({elapsed.toFixed(1)}s)</Text>
          )}
        </Text>
      </Box>
      <Box
        width={maxWidth}
        borderStyle="bold"
        borderLeft
        borderRight={false}
        borderTop={false}
        borderBottom={false}
        borderColor="magenta"
        borderDimColor
        paddingLeft={1}
      >
        <Text>{renderMarkdown(content)}</Text>
      </Box>
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
  return <AssistantMessage content={message.content} elapsed={message.elapsed} cols={cols} />;
}

export function ChatView({ messages }: ChatViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  const staticMessages = messages.map((msg, i) => ({
    id: `msg-${i}-${msg.role}-${msg.timestamp.getTime()}`,
    msg,
  }));

  return (
    <Box flexDirection="column">
      {/* Completed messages — rendered once, pushed to scrollback */}
      <Static items={staticMessages}>
        {(item) => (
          <Box key={item.id} width={cols}>
            <MessageBubble message={item.msg} cols={cols} />
          </Box>
        )}
      </Static>
    </Box>
  );
}
