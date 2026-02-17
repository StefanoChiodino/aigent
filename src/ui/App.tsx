import { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import type { Agent } from '../agent.js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  elapsed?: number;
}

export interface ToolExecution {
  name: string;
  input: string;
}

interface AppProps {
  agent: Agent;
  model: string;
  thinking?: string;
}

export function App({ agent, model, thinking }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      exit();
      process.exit(0);
    }
  });

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Handle commands
    if (trimmed === '/reset') {
      agent.reset();
      setMessages([{ role: 'system', content: '🔄 Conversation reset.', timestamp: new Date() }]);
      return;
    }

    if (trimmed === '/help') {
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: '/reset — Clear history\n/status — Show info\n/help — This message\nCtrl+C — Exit',
          timestamp: new Date(),
        },
      ]);
      return;
    }

    if (trimmed === '/status') {
      setMessages((prev) => [
        ...prev,
        {
          role: 'system',
          content: `Model: ${model}\nMessages: ${agent.conversationLength}`,
          timestamp: new Date(),
        },
      ]);
      return;
    }

    // Add user message
    setMessages((prev) => [...prev, { role: 'user', content: trimmed, timestamp: new Date() }]);
    setIsLoading(true);
    setError(null);
    setStreaming('');
    setActiveTools([]);

    const startTime = Date.now();

    try {
      const response = await agent.chat(trimmed, {
        onText: (text) => {
          setStreaming(text);
        },
        onToolStart: (name, toolInput) => {
          setActiveTools((prev) => [...prev, { name, input: toolInput }]);
        },
        onToolEnd: () => {
          setActiveTools([]);
          setStreaming('');
        },
      });

      const elapsed = (Date.now() - startTime) / 1000;
      setStreaming('');
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: response, timestamp: new Date(), elapsed },
      ]);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      let errorMsg = e.message ?? 'Unknown error';
      if (e.status === 401) errorMsg = 'Authentication failed. Check ANTHROPIC_API_KEY.';
      if (e.status === 429) errorMsg = 'Rate limited. Wait a moment.';
      setError(errorMsg);
    } finally {
      setIsLoading(false);
      setActiveTools([]);
    }
  }, [agent, model, exit]);

  return (
    <Box flexDirection="column" width="100%">
      <StatusBar model={model} messageCount={agent.conversationLength} thinking={thinking} />
      <ChatView
        messages={messages}
        streaming={streaming}
        isLoading={isLoading}
        activeTools={activeTools}
      />
      {error && (
        <Box marginLeft={1}>
          <Text color="red">❌ {error}</Text>
        </Box>
      )}
      <InputBar onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  );
}
