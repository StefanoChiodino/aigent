import { useState, useCallback, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { ChatView } from './ChatView.js';
import { InputBar } from './InputBar.js';
import { StatusBar } from './StatusBar.js';
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
  const [currentThinking, setCurrentThinking] = useState(initialThinking ?? 'medium');
  const [inputValue, setInputValue] = useState('');
  const [currentProfile, setCurrentProfile] = useState('default');
  const [currentSessionId, setCurrentSessionId] = useState(generateSessionId());
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

    if (trimmed === '/help') {
      addSystemMessage(
        'Commands:\n' +
        '  /reset              Clear conversation\n' +
        '  /reasoning on|off   Toggle reasoning\n' +
        '  /effort <level>     Set effort (low/medium/high/max)\n' +
        '  /profiles           List profiles\n' +
        '  /profile <name>     Switch profile\n' +
        '  /profile create <n> Create new profile\n' +
        '  /save               Save current session\n' +
        '  /sessions           List saved sessions\n' +
        '  /load <id>          Load a saved session\n' +
        '  Ctrl+C              Clear input / exit'
      );
      return true;
    }

    return false;
  }, [agent, currentThinking, currentProfile, currentSessionId, workspacePath, addSystemMessage]);

  const handleSubmit = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;

    if (handleCommand(trimmed)) return;

    setMessages((prev) => [...prev, { role: 'user', content: trimmed, timestamp: new Date() }]);
    setIsLoading(true);
    setIsThinking(false);
    setError(null);
    setStreaming('');
    setActiveTools([]);

    const startTime = Date.now();

    try {
      const response = await agent.chat(trimmed, {
        onText: (text) => {
          setIsThinking(false);
          setStreaming(text);
        },
        onThinking: () => {
          setIsThinking(true);
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
      <StatusBar thinking={currentThinking} usage={usage} model={model} />
      <InputBar
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isLoading={isLoading}
      />
    </Box>
  );
}
