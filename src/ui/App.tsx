import { useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
import type { Agent, TokenUsage, ThinkingLevel } from '../agent.js';

const VALID_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  elapsed?: number | undefined;
}

export interface ToolExecution {
  name: string;
  input: string;
}

interface AppProps {
  agent: Agent;
  thinking?: string | undefined;
}

export function App({ agent, thinking: initialThinking }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? 'medium');

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      exit();
      process.exit(0);
    }
  });

  const addSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: 'system', content, timestamp: new Date() }]);
  }, []);

  const handleCommand = useCallback((trimmed: string): boolean => {
    if (trimmed === '/reset') {
      agent.reset();
      setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      addSystemMessage('Conversation reset.');
      return true;
    }

    // /thinking or /reasoning — same command
    if (trimmed === '/thinking' || trimmed === '/reasoning') {
      addSystemMessage(`Reasoning: ${currentThinking}\nLevels: ${VALID_THINKING_LEVELS.join(', ')}\nUsage: /thinking <level>`);
      return true;
    }

    if (trimmed.startsWith('/thinking ') || trimmed.startsWith('/reasoning ')) {
      const level = trimmed.split(' ')[1] as ThinkingLevel;
      if (VALID_THINKING_LEVELS.includes(level)) {
        agent.thinkingLevel = level;
        setCurrentThinking(level);
        addSystemMessage(`Reasoning set to: ${level}`);
      } else {
        addSystemMessage(`Invalid level. Options: ${VALID_THINKING_LEVELS.join(', ')}`);
      }
      return true;
    }

    if (trimmed === '/help') {
      addSystemMessage(
        'Commands:\n' +
        '  /reset              Clear conversation\n' +
        '  /thinking <level>   Set reasoning (off/low/medium/high/max)\n' +
        '  /reasoning <level>  Same as /thinking\n' +
        '  Ctrl+C              Exit'
      );
      return true;
    }

    return false;
  }, [agent, currentThinking, addSystemMessage]);

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (handleCommand(trimmed)) return;

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
        onUsage: (u) => {
          setUsage(u);
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
  }, [agent, handleCommand]);

  return (
    <Box flexDirection="column" width="100%">
      <StatusBar thinking={currentThinking} usage={usage} />
      <ChatView
        messages={messages}
        streaming={streaming}
        isLoading={isLoading}
        activeTools={activeTools}
      />
      {error && (
        <Box marginLeft={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
      <InputBar onSubmit={handleSubmit} isLoading={isLoading} />
    </Box>
  );
}
