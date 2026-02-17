import { useState, useCallback, useRef } from 'react';
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
  summary: string;
}

interface AppProps {
  agent: Agent;
  thinking?: string | undefined;
  model?: string | undefined;
}

export function App({ agent, thinking: initialThinking, model }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? 'medium');
  const [inputValue, setInputValue] = useState('');
  const ctrlCPending = useRef(false);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      // First Ctrl+C: clear input if there's text
      if (inputValue.length > 0) {
        setInputValue('');
        ctrlCPending.current = false;
        return;
      }
      // Second Ctrl+C (or first with empty input): exit
      if (ctrlCPending.current) {
        exit();
        process.exit(0);
      }
      ctrlCPending.current = true;
      // Show hint
      setMessages((prev) => [
        ...prev,
        { role: 'system', content: 'Press Ctrl+C again to exit.', timestamp: new Date() },
      ]);
      // Reset after 2 seconds
      setTimeout(() => {
        ctrlCPending.current = false;
      }, 2000);
      return;
    }
    // Any other key resets the Ctrl+C pending state
    ctrlCPending.current = false;
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
        '  Ctrl+C              Clear input / exit'
      );
      return true;
    }

    return false;
  }, [agent, currentThinking, addSystemMessage]);

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (handleCommand(trimmed)) return;

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
        onToolStart: (name, toolInput, summary) => {
          setActiveTools((prev) => [...prev, { name, input: toolInput, summary }]);
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
      <StatusBar thinking={currentThinking} usage={usage} model={model} />
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
      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isLoading={isLoading}
      />
    </Box>
  );
}
