import { useState, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import type { Agent, TokenUsage, ThinkingLevel } from '../agent.js';
import { listProfiles, getProfilePath, listSessions, saveSession, loadSession, generateSessionId } from '../profiles.js';

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
  workspacePath?: string | undefined;
}

export function App({ agent, thinking: initialThinking, model, workspacePath: wp }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const workspacePath = wp ?? process.env['AIGENT_WORKSPACE'] ?? '/workspace';
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [activeTools, setActiveTools] = useState<ToolExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<TokenUsage>({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? 'high');
  const [inputValue, setInputValue] = useState('');
  const [currentProfile, setCurrentProfile] = useState('default');
  const [currentSessionId, setCurrentSessionId] = useState(generateSessionId());
  const ctrlCPending = useRef(false);
  const messageQueue = useRef<string[]>([]);
  const abortController = useRef<AbortController | null>(null);
  const processingQueue = useRef(false);

  useInput((_input, key) => {
    // Esc — cancel current generation or clear input
    if (key.escape) {
      if (isLoading && abortController.current) {
        abortController.current.abort();
        abortController.current = null;
        messageQueue.current = [];
        setIsLoading(false);
        setStreaming('');
        setActiveTools([]);
        addSystemMessage('Cancelled.');
        return;
      }
      if (inputValue.length > 0) {
        setInputValue('');
        return;
      }
      return;
    }

    if (key.ctrl && _input === 'c') {
      // If generating, cancel first
      if (isLoading && abortController.current) {
        abortController.current.abort();
        abortController.current = null;
        messageQueue.current = [];
        setIsLoading(false);
        setStreaming('');
        setActiveTools([]);
        addSystemMessage('Cancelled.');
        return;
      }
      // Clear input if there's text
      if (inputValue.length > 0) {
        setInputValue('');
        ctrlCPending.current = false;
        return;
      }
      // Double-tap to exit
      if (ctrlCPending.current) {
        exit();
        process.exit(0);
      }
      ctrlCPending.current = true;
      addSystemMessage('Press Ctrl+C again to exit.');
      setTimeout(() => {
        ctrlCPending.current = false;
      }, 2000);
      return;
    }
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

    // /reasoning on|off — toggle reasoning
    if (trimmed === '/reasoning') {
      const isOn = currentThinking !== 'off';
      addSystemMessage(`Reasoning: ${isOn ? 'on' : 'off'}\nUsage: /reasoning on | /reasoning off`);
      return true;
    }

    if (trimmed === '/reasoning on') {
      if (currentThinking === 'off') {
        agent.thinkingLevel = 'medium';
        setCurrentThinking('medium');
      }
      addSystemMessage('Reasoning: on');
      return true;
    }

    if (trimmed === '/reasoning off') {
      agent.thinkingLevel = 'off';
      setCurrentThinking('off');
      addSystemMessage('Reasoning: off');
      return true;
    }

    // /effort <level> — set thinking effort
    if (trimmed === '/effort') {
      const effortLevels = VALID_THINKING_LEVELS.filter((l) => l !== 'off');
      addSystemMessage(`Effort: ${currentThinking === 'off' ? '(reasoning off)' : currentThinking}\nLevels: ${effortLevels.join(', ')}\nUsage: /effort <level>`);
      return true;
    }

    if (trimmed.startsWith('/effort ')) {
      const level = trimmed.split(' ')[1] as ThinkingLevel;
      const effortLevels: ThinkingLevel[] = ['low', 'medium', 'high', 'max'];
      if (effortLevels.includes(level)) {
        agent.thinkingLevel = level;
        setCurrentThinking(level);
        addSystemMessage(`Effort: ${level}`);
      } else {
        addSystemMessage(`Invalid effort. Options: ${effortLevels.join(', ')}`);
      }
      return true;
    }

    // Profile commands
    if (trimmed === '/profiles' || trimmed === '/profile list') {
      const profiles = listProfiles(workspacePath);
      if (profiles.length === 0) {
        addSystemMessage(`No profiles yet. Current: ${currentProfile}\nCreate one: /profile create <name>`);
      } else {
        const list = profiles.map((p) => `  ${p.name === currentProfile ? '>' : ' '} ${p.name}`).join('\n');
        addSystemMessage(`Profiles:\n${list}`);
      }
      return true;
    }

    if (trimmed.startsWith('/profile create ')) {
      const name = trimmed.slice('/profile create '.length).trim();
      if (!name || name.includes('/') || name.includes('..')) {
        addSystemMessage('Invalid profile name.');
        return true;
      }
      getProfilePath(workspacePath, name);
      addSystemMessage(`Profile "${name}" created. Switch to it: /profile ${name}`);
      return true;
    }

    if (trimmed.startsWith('/profile ') && !trimmed.startsWith('/profile list') && !trimmed.startsWith('/profile create')) {
      const name = trimmed.slice('/profile '.length).trim();
      const profileDir = getProfilePath(workspacePath, name);
      agent.reset();
      agent.reloadWorkspace(profileDir);
      setCurrentProfile(name);
      setCurrentSessionId(generateSessionId());
      setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      addSystemMessage(`Switched to profile: ${name}`);
      return true;
    }

    // Session commands
    if (trimmed === '/save') {
      saveSession(workspacePath, currentProfile, currentSessionId, agent.getMessages());
      addSystemMessage(`Session saved: ${currentSessionId}`);
      return true;
    }

    if (trimmed === '/sessions') {
      const sessions = listSessions(workspacePath, currentProfile);
      if (sessions.length === 0) {
        addSystemMessage('No saved sessions. Use /save to save current session.');
      } else {
        const list = sessions.map((s) =>
          `  ${s.id === currentSessionId ? '>' : ' '} ${s.id} (${s.messageCount} msgs, ${s.lastActiveAt.slice(0, 10)})`
        ).join('\n');
        addSystemMessage(`Sessions (${currentProfile}):\n${list}`);
      }
      return true;
    }

    if (trimmed.startsWith('/load ')) {
      const sessionId = trimmed.slice('/load '.length).trim();
      const data = loadSession(workspacePath, currentProfile, sessionId);
      if (!data) {
        addSystemMessage(`Session not found: ${sessionId}`);
        return true;
      }
      agent.setMessages(data.messages as Parameters<typeof agent.setMessages>[0]);
      setCurrentSessionId(sessionId);
      setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      addSystemMessage(`Loaded session: ${sessionId} (${data.messages.length} messages)`);
      return true;
    }

    if (trimmed === '/refresh' || trimmed === '/refesh') {
      // Clear screen and force re-render
      process.stdout.write('\x1B[2J\x1B[H');
      addSystemMessage('Refreshed.');
      return true;
    }

    if (trimmed === '/help') {
      addSystemMessage(
        'Commands:\n' +
        '  /refresh            Refresh screen\n' +
        '  /reset              Clear conversation\n' +
        '  /reasoning on|off   Toggle reasoning\n' +
        '  /effort <level>     Set effort (low/medium/high/max)\n' +
        '  /profiles           List profiles\n' +
        '  /profile <name>     Switch profile\n' +
        '  /profile create <n> Create new profile\n' +
        '  /save               Save current session\n' +
        '  /sessions           List saved sessions\n' +
        '  /load <id>          Load a saved session\n' +
        '  Esc                 Cancel generation / clear input\n' +
        '  Ctrl+C              Clear input / exit'
      );
      return true;
    }

    return false;
  }, [agent, currentThinking, currentProfile, currentSessionId, workspacePath, addSystemMessage]);

  const processMessage = useCallback(async (trimmed: string) => {
    setMessages((prev) => [...prev, { role: 'user', content: trimmed, timestamp: new Date() }]);
    setIsLoading(true);
    setIsThinking(false);
    setError(null);
    setStreaming('');
    setActiveTools([]);

    const controller = new AbortController();
    abortController.current = controller;
    const startTime = Date.now();

    try {
      const response = await agent.chat(trimmed, {
        onText: (text) => {
          if (controller.signal.aborted) return;
          setIsThinking(false);
          setStreaming(text);
        },
        onThinking: () => {
          if (controller.signal.aborted) return;
          setIsThinking(true);
        },
        onToolStart: (name, toolInput, summary) => {
          if (controller.signal.aborted) return;
          setActiveTools((prev) => [...prev, { name, input: toolInput, summary }]);
        },
        onToolEnd: () => {
          if (controller.signal.aborted) return;
          setActiveTools([]);
          setStreaming('');
        },
        onUsage: (u) => {
          setUsage(u);
        },
      });

      if (!controller.signal.aborted) {
        const elapsed = (Date.now() - startTime) / 1000;
        setStreaming('');
        setMessages((prev) => [
          ...prev,
          { role: 'assistant', content: response, timestamp: new Date(), elapsed },
        ]);
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        const e = err as { status?: number; message?: string };
        let errorMsg = e.message ?? 'Unknown error';
        if (e.status === 401) errorMsg = 'Authentication failed. Check ANTHROPIC_API_KEY.';
        if (e.status === 429) errorMsg = 'Rate limited. Wait a moment.';
        setError(errorMsg);
      }
    } finally {
      abortController.current = null;
      setIsLoading(false);
      setActiveTools([]);
    }
  }, [agent]);

  const processQueue = useCallback(async () => {
    if (processingQueue.current) return;
    processingQueue.current = true;

    while (messageQueue.current.length > 0) {
      const next = messageQueue.current.shift();
      if (next) await processMessage(next);
    }

    processingQueue.current = false;
  }, [processMessage]);

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (handleCommand(trimmed)) return;

    if (isLoading) {
      // Queue the message — show it in chat immediately
      messageQueue.current.push(trimmed);
      setMessages((prev) => [...prev, { role: 'user', content: `[queued] ${trimmed}`, timestamp: new Date() }]);
      return;
    }

    messageQueue.current.push(trimmed);
    await processQueue();
  }, [handleCommand, isLoading, processQueue]);

  return (
    <Box flexDirection="column" width="100%">
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
        model={model}
      />
    </Box>
  );
}
