import { Box, Text, Static, useStdout } from 'ink';
import { renderMarkdown } from './Markdown.js';
import type { Message } from './App.js';

interface ChatViewProps {
  messages: Message[];
}

function UserMessage({ content, cols }: { content: string; cols: number }): React.JSX.Element {
  const maxWidth = Math.min(Math.floor(cols * 0.7), cols - 4);

  return (
    <Box justifyContent="flex-end" marginY={0}>
      <Box flexDirection="column" width={maxWidth}>
        <Box justifyContent="flex-end">
          <Text color="cyan" dimColor>{content}</Text>
        </Box>
      </Box>
      <Text color="cyan" dimColor> ▎</Text>
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
