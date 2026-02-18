/**
 * TaskList — shows running background tasks above the input bar.
 * Each task gets a spinner and elapsed time. Compact, always visible.
 */

import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import type { BackgroundTaskInfo } from '../protocol.js';

interface TaskListProps {
  tasks: BackgroundTaskInfo[];
}

function elapsed(startedAt: string): string {
  const secs = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem > 0 ? `${rem}s` : ''}`;
}

export function TaskList({ tasks }: TaskListProps): React.JSX.Element | null {
  const running = tasks.filter((t) => t.status === 'running');

  // Tick every second to update elapsed times
  const [, setTick] = useState(0);
  useEffect(() => {
    if (running.length === 0) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [running.length]);

  if (running.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1}>
      {running.map((task) => (
        <Box key={task.id}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="gray"> {task.description} </Text>
          <Text color="gray" dimColor>({elapsed(task.startedAt)})</Text>
        </Box>
      ))}
    </Box>
  );
}
