/**
 * StatusBar — persistent status area between chat and input.
 * Shows: active tools, thinking, loading spinner, task notifications.
 * Separated from chat to prevent interleaving with streamed text.
 */

import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { BackgroundTaskInfo } from '../protocol.js';
import type { ToolExecution } from './App.js';

interface StatusBarProps {
  isLoading: boolean;
  isThinking: boolean;
  thinkingText: string;
  activeTools: ToolExecution[];
  toolOutput: string;
  streaming: boolean;  // whether we're actively streaming text
  tasks: BackgroundTaskInfo[];
  notifications: string[];  // recent system notifications
}

function elapsed(startedAt: string): string {
  const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem > 0 ? `${rem}s` : ''}`;
}

export function StatusBar({ isLoading, isThinking, thinkingText, activeTools, toolOutput, streaming, tasks, notifications }: StatusBarProps): React.JSX.Element | null {
  const running = tasks.filter((t) => t.status === 'running');

  // Tick every second to update elapsed times
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  const hasContent = isLoading || running.length > 0 || notifications.length > 0;
  if (!hasContent) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Thinking indicator */}
      {isThinking && thinkingText && (
        <Box flexDirection="column">
          <Text color="gray" dimColor bold>
            <Spinner type="dots" /> thinking
          </Text>
          {thinkingText.split('\n').slice(-4).map((line, i) => (
            <Text key={i} color="gray" dimColor>  {line}</Text>
          ))}
        </Box>
      )}

      {/* Active tool executions */}
      {activeTools.length > 0 && (
        <Box flexDirection="column">
          {activeTools.map((tool, i) => (
            <Text key={`tool-${i}-${tool.name}`} color="gray">
              <Text color="cyan"><Spinner type="dots" /></Text> {tool.summary}
            </Text>
          ))}
        </Box>
      )}

      {/* Streaming tool output (e.g. exec) */}
      {toolOutput && activeTools.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {toolOutput.split('\n').slice(-6).map((line, i) => (
            <Text key={`tout-${i}`} color="gray" dimColor>{line}</Text>
          ))}
        </Box>
      )}

      {/* Loading spinner (no streaming, no tools, no thinking) */}
      {isLoading && !streaming && activeTools.length === 0 && !isThinking && (
        <Text color="gray">
          <Text color="magenta"><Spinner type="dots" /></Text> thinking...
        </Text>
      )}

      {/* Thinking spinner (no text yet) */}
      {isLoading && isThinking && !thinkingText && (
        <Text color="gray">
          <Text color="magenta"><Spinner type="dots" /></Text> reasoning...
        </Text>
      )}

      {/* Running background tasks */}
      {running.map((task) => (
        <Box key={task.id}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="gray"> {task.description} </Text>
          <Text color="gray" dimColor>({elapsed(task.startedAt)})</Text>
        </Box>
      ))}

      {/* Recent notifications */}
      {notifications.map((note, i) => (
        <Text key={`note-${i}`} color="yellow" dimColor>{note}</Text>
      ))}
    </Box>
  );
}
