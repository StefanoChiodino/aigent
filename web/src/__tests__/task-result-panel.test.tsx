/**
 * TaskResultPanel — markdown rendering, Defer button, Discuss button.
 *
 * Behaviour under test:
 * - Panel is hidden when taskResultTask is null
 * - Shows task description and renders result as markdown
 * - Defer button clears the task (hides panel) without sending a message
 * - Discuss button clears the task AND sends a short reference message
 *   (does NOT paste the full result body)
 * - No legacy close (×) button
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';
import { useUIStore } from '../stores/ui';
import { useConnectionStore } from '../stores/connection';
import { TaskResultPanel } from '../components/modals/TaskResultPanel';
import type { BackgroundTaskInfo } from '../types';

function fakeWs() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
}

function sentPayloads(ws: WebSocket): Record<string, unknown>[] {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
  );
}

function makeTask(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: 'task-1',
    description: 'Test task description',
    status: 'completed',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    delivery: 'user-pull',
    result: 'Task result text here.',
    ...overrides,
  };
}

describe('TaskResultPanel', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    useUIStore.setState({ taskResultTask: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('is hidden when taskResultTask is null', () => {
    render(<TaskResultPanel />);
    const panel = document.getElementById('task-result-panel');
    expect(panel?.className).toContain('hidden');
  });

  it('shows task description as title', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ description: 'Security scan' }));
    });
    expect(screen.getByText('Security scan')).toBeTruthy();
  });

  it('renders result body as markdown (bold)', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ result: '**bold result**' }));
    });
    const body = document.querySelector('.task-result-body');
    expect(body?.innerHTML).toContain('<strong>bold result</strong>');
  });

  it('renders result body as markdown (inline code)', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ result: 'Use `npm test`' }));
    });
    const body = document.querySelector('.task-result-body');
    expect(body?.innerHTML).toContain('<code>npm test</code>');
  });

  it('has a Defer button', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(screen.getByText('Defer')).toBeTruthy();
  });

  it('has a Discuss button', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(screen.getByText('Discuss with agent')).toBeTruthy();
  });

  it('has no close (×) button', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(document.querySelector('.task-result-close')).toBeNull();
  });

  it('Defer hides the panel without sending a message', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    await act(async () => {
      screen.getByText('Defer').click();
    });
    expect(useUIStore.getState().taskResultTask).toBeNull();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('Discuss hides the panel', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ description: 'My task' }));
    });
    await act(async () => {
      screen.getByText('Discuss with agent').click();
    });
    expect(useUIStore.getState().taskResultTask).toBeNull();
  });

  it('Discuss sends a message referencing the task description', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ description: 'Architecture review' }));
    });
    await act(async () => {
      screen.getByText('Discuss with agent').click();
    });
    const payloads = sentPayloads(ws);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].type).toBe('message');
    expect(payloads[0].content as string).toContain('Architecture review');
  });

  it('Discuss does NOT paste the full result body into the message', async () => {
    const result = 'Unique-result-xyz-should-not-appear-in-message';
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ description: 'Task', result }));
    });
    await act(async () => {
      screen.getByText('Discuss with agent').click();
    });
    const payloads = sentPayloads(ws);
    expect(payloads[0].content as string).not.toContain(result);
  });

  it('panel is not hidden when a task is set', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    const panel = document.getElementById('task-result-panel');
    expect(panel?.className).not.toContain('hidden');
  });
});
