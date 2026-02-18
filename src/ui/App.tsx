import { useState, useCallback, useRef, useEffect } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar, type ToolExecution } from './InputBar.js';
import type { AgentClient } from '../client.js';
import type { ThinkingLevel } from '../agent.js';
import type { DisplayMessage, ServerState, TokenUsage, BackgroundTaskInfo } from '../protocol.js';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  elapsed?: number | undefined;
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
  const [_thinkingText, setThinkingText] = useState('');  // eslint-disable-line @typescript-eslint/no-unused-vars
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [_toolOutput, setToolOutput] = useState('');  // eslint-disable-line @typescript-eslint/no-unused-vars
  const [_runningTasks, setRunningTasks] = useState(0);  // eslint-disable-line @typescript-eslint/no-unused-vars
  const [taskList, setTaskList] = useState<BackgroundTaskInfo[]>([]);
  const [notifications, setNotifications] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [currentThinking, setCurrentThinking] = useState<ThinkingLevel>('high');
  const [inputValue, setInputValue] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [ctrlCHint, setCtrlCHint] = useState(false);
  const ctrlCPending = useRef(false);
  const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasEverConnected = useRef(false);

  // Wire up client events
  useEffect(() => {
    const onConnected = (state: ServerState) => {
      // Clear screen on every (re)connection — wipe stale output
      hasEverConnected.current = true;
      process.stdout.write('\x1B[2J\x1B[H');
      setConnectionStatus('connected');
      setMessages(state.messages.map(toUIMessage));
      setUsage(state.usage);
      setCurrentThinking(state.thinking);
      setIsLoading(state.isLoading);
      setTaskList(state.tasks ?? []);
      setRunningTasks(state.tasks?.filter((t) => t.status === 'running').length ?? 0);
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
      // Clear streaming/thinking when assistant message arrives
      if (dm.role === 'assistant') {
        setStreaming('');
        setThinkingText('');
        setActiveTools([]);
      }
    };

    const onSystem = (content: string) => {
      // Persistent system messages go to chat, transient ones to notifications
      const isTransient = content.startsWith('Cancelled') ||
        content.startsWith('Context compacted') ||
        content.startsWith('Task completed') ||
        content.startsWith('Task FAILED') ||
        content.includes('background task');

      if (isTransient) {
        setNotifications((prev) => [...prev.slice(-2), content]); // keep last 3
        // Auto-clear after 5 seconds
        setTimeout(() => {
          setNotifications((prev) => prev.filter((n) => n !== content));
        }, 5000);
      } else {
        setMessages((prev) => [...prev, {
          role: 'system' as const,
          content,
          timestamp: new Date(),
        }]);
      }
    };

    const onText = (content: string) => {
      setIsThinking(false);
      setStreaming(content);
    };

    const onThinking = (content: string) => {
      setIsThinking(true);
      setThinkingText(content);
    };

    const onToolStart = (name: string, input: string, summary: string) => {
      setToolOutput(''); // Clear output for new tool
      setActiveTools((prev) => [...prev, { name, input, summary }]);
    };

    const onToolOutput = (content: string) => {
      setToolOutput((prev) => prev + content);
    };

    const onToolEnd = () => {
      setActiveTools([]);
      setToolOutput('');
      setStreaming('');
    };

    const onTaskUpdate = (task: BackgroundTaskInfo) => {
      setTaskList((prev) => {
        const idx = prev.findIndex((t) => t.id === task.id);
        if (idx >= 0) {
          const updated = [...prev];
          updated[idx] = task;
          return updated;
        }
        return [...prev, task];
      });
      if (task.status === 'running') {
        setRunningTasks((prev) => prev + 1);
      } else {
        setRunningTasks((prev) => Math.max(0, prev - 1));
      }
    };

    const onUsage = (u: TokenUsage) => {
      setUsage(u);
    };

    const onLoading = (loading: boolean) => {
      setIsLoading(loading);
      // Reset all streaming state on both transitions
      setStreaming('');
      setThinkingText('');
      setActiveTools([]);
      setToolOutput('');
      setIsThinking(false);
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
    client.on('tool_output', onToolOutput);
    client.on('tool_end', onToolEnd);
    client.on('task_update', onTaskUpdate);
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
      client.removeListener('tool_output', onToolOutput);
      client.removeListener('tool_end', onToolEnd);
      client.removeListener('task_update', onTaskUpdate);
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
      // Second Ctrl+C within 2 seconds — exit
      if (ctrlCPending.current) {
        client.disconnect();
        exit();
        process.exit(0);
      }

      if (isLoading) {
        // Cancel running agent, arm exit on next quick Ctrl+C
        client.cancel();
        ctrlCPending.current = true;
        setCtrlCHint(true);
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
        ctrlCTimer.current = setTimeout(() => {
          ctrlCPending.current = false;
          setCtrlCHint(false);
        }, 2000);
      } else if (inputValue.length > 0) {
        // Clear text — just like a normal terminal, no exit state
        setInputValue('');
      } else {
        // Empty input, not loading — show hint
        ctrlCPending.current = true;
        setCtrlCHint(true);
        if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
        ctrlCTimer.current = setTimeout(() => {
          ctrlCPending.current = false;
          setCtrlCHint(false);
        }, 2000);
      }
      return;
    }
    // Any other key resets the Ctrl+C state
    if (ctrlCPending.current) {
      ctrlCPending.current = false;
      setCtrlCHint(false);
      if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
    }
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
        ctrlCHint={ctrlCHint}
        isThinking={isThinking}
        activeTools={activeTools}
        streaming={!!streaming}
        tasks={taskList}
        notifications={notifications}
      />
    </Box>
  );
}
