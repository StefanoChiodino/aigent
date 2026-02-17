import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import type { AgentClient } from '../client.js';
import type { TokenUsage, ThinkingLevel } from '../agent.js';
import type { DisplayMessage, ServerState } from '../protocol.js';

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
  client: AgentClient;
}

function toUIMessage(dm: DisplayMessage): Message {
  return {
    role: dm.role,
    content: dm.content,
    timestamp: new Date(dm.timestamp),
    elapsed: dm.elapsed,
  };
}

export function App({ client }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [currentThinking, setCurrentThinking] = useState<ThinkingLevel>('high');
  const [inputValue, setInputValue] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const ctrlCPending = useRef(false);
  const hasEverConnected = useRef(false);

  // Wire up client events
  useEffect(() => {
    const onConnected = (state: ServerState) => {
      // Clear screen on first connection to wipe startup artifacts
      if (!hasEverConnected.current) {
        hasEverConnected.current = true;
        process.stdout.write('\x1B[2J\x1B[H');
      }
      setConnectionStatus('connected');
      setMessages(state.messages.map(toUIMessage));
      setUsage(state.usage);
      setCurrentThinking(state.thinking);
      setIsLoading(state.isLoading);
      setError(null);
    };

    const onDisconnected = () => {
      setConnectionStatus('reconnecting');
      setIsLoading(false);
      setStreaming('');
      setActiveTools([]);
    };

    const onReconnecting = (_attempt: number) => {
      setConnectionStatus('reconnecting');
    };

    const onMessage = (dm: DisplayMessage) => {
      setMessages((prev) => [...prev, toUIMessage(dm)]);
      // Clear streaming when assistant message arrives
      if (dm.role === 'assistant') {
        setStreaming('');
        setActiveTools([]);
      }
    };

    const onSystem = (content: string) => {
      setMessages((prev) => [...prev, {
        role: 'system' as const,
        content,
        timestamp: new Date(),
      }]);
    };

    const onText = (content: string) => {
      setIsThinking(false);
      setStreaming(content);
    };

    const onThinking = (_content: string) => {
      setIsThinking(true);
    };

    const onToolStart = (name: string, input: string, summary: string) => {
      setActiveTools((prev) => [...prev, { name, input, summary }]);
    };

    const onToolEnd = () => {
      setActiveTools([]);
      setStreaming('');
    };

    const onUsage = (u: TokenUsage) => {
      setUsage(u);
    };

    const onLoading = (loading: boolean) => {
      setIsLoading(loading);
      if (!loading) {
        setStreaming('');
        setActiveTools([]);
        setIsThinking(false);
      }
    };

    const onError = (message: string) => {
      setError(message);
    };

    const onState = (partial: { thinking?: ThinkingLevel; profile?: string }) => {
      if (partial.thinking) setCurrentThinking(partial.thinking);
    };

    client.on('connected', onConnected);
    client.on('disconnected', onDisconnected);
    client.on('reconnecting', onReconnecting);
    client.on('message', onMessage);
    client.on('system', onSystem);
    client.on('text', onText);
    client.on('thinking', onThinking);
    client.on('tool_start', onToolStart);
    client.on('tool_end', onToolEnd);
    client.on('usage', onUsage);
    client.on('loading', onLoading);
    client.on('error', onError);
    client.on('state', onState);

    return () => {
      client.removeListener('connected', onConnected);
      client.removeListener('disconnected', onDisconnected);
      client.removeListener('reconnecting', onReconnecting);
      client.removeListener('message', onMessage);
      client.removeListener('system', onSystem);
      client.removeListener('text', onText);
      client.removeListener('thinking', onThinking);
      client.removeListener('tool_start', onToolStart);
      client.removeListener('tool_end', onToolEnd);
      client.removeListener('usage', onUsage);
      client.removeListener('loading', onLoading);
      client.removeListener('error', onError);
      client.removeListener('state', onState);
    };
  }, [client]);

  useInput((_input, key) => {
    // Esc — cancel
    if (key.escape) {
      if (isLoading) {
        client.cancel();
        return;
      }
      if (inputValue.length > 0) {
        setInputValue('');
        return;
      }
      return;
    }

    // Ctrl+D on empty input — exit (standard EOF behavior)
    if (key.ctrl && _input === 'd' && inputValue.length === 0) {
      client.disconnect();
      exit();
      process.exit(0);
    }

    if (key.ctrl && _input === 'c') {
      // Double-tap Ctrl+C to exit
      if (ctrlCPending.current) {
        client.disconnect();
        exit();
        process.exit(0);
      }
      // First Ctrl+C: cancel or clear
      if (isLoading) {
        client.cancel();
      } else if (inputValue.length > 0) {
        setInputValue('');
      }
      ctrlCPending.current = true;
      setTimeout(() => {
        ctrlCPending.current = false;
      }, 2000);
      return;
    }
    ctrlCPending.current = false;
  });

  const handleSubmit = useCallback((input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // /refresh is client-side only
    if (trimmed === '/refresh' || trimmed === '/refesh') {
      process.stdout.write('\x1B[2J\x1B[H');
      return;
    }

    // Everything else goes to the server
    client.sendMessage(trimmed);
  }, [client]);

  // Only show reconnection banner after we've been connected at least once
  const showReconnecting = connectionStatus === 'reconnecting' && hasEverConnected.current;

  return (
    <Box flexDirection="column" width="100%">
      {showReconnecting && (
        <Box marginLeft={1}>
          <Text color="yellow">Reconnecting to server...</Text>
        </Box>
      )}
      <ChatView
        messages={messages}
        streaming={streaming}
        isLoading={isLoading}
        isThinking={isThinking}
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
        thinking={currentThinking}
        usage={usage}
      />
    </Box>
  );
}
