/**
 * TaskResultPanel — task inspect modal for all delivery modes.
 *
 * Behaviour under test:
 * - Panel is hidden when taskResultTask is null
 * - Shows task description and metadata
 * - Renders result as markdown when available
 * - user-pull completed tasks: Defer + Discuss buttons
 * - agent-review / other tasks: only a Close button, no Discuss button
 * - Close (×) button always present
 * - Defer/Close button clears the task without sending a message
 * - Discuss button clears the task AND sends a short reference message (not the full result)
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

  it('renders hidden placeholder when taskResultTask is null', () => {
    render(<TaskResultPanel />);
    const panel = document.getElementById('task-result-panel');
    expect(panel).not.toBeNull();
    expect(panel!.classList.contains('hidden')).toBe(true);
  });

  it('shows task description as title', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ description: 'Security scan' }));
    });
    expect(screen.getByText('Security scan')).toBeTruthy();
  });

  it('has a Defer button (no × close button)', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(document.querySelector('.task-result-close')).toBeNull();
    expect(document.querySelector('.task-result-defer')).not.toBeNull();
  });

  it('shows metadata row', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ id: 'task-abc', model: 'claude-haiku-4-5-20251001' }));
    });
    expect(screen.getByText('task-abc')).toBeTruthy();
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

  it('shows empty-state placeholder when result is absent', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ result: undefined, delivery: 'agent-review' }));
    });
    const body = document.querySelector('.task-result-empty');
    expect(body).not.toBeNull();
  });

  // user-pull completed task
  it('has a Defer button for user-pull completed task', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(screen.getByText('Defer')).toBeTruthy();
  });

  it('has a Discuss button for user-pull completed task', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(screen.getByText('Discuss with agent')).toBeTruthy();
  });

  // agent-review task
  it('shows only Close button (no Discuss) for agent-review task', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ delivery: 'agent-review', result: 'some result' }));
    });
    expect(screen.getByText('Close')).toBeTruthy();
    expect(screen.queryByText('Discuss with agent')).toBeNull();
  });

  it('shows only Close button (no Discuss) for running task', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ status: 'running', result: undefined, completedAt: undefined }));
    });
    expect(screen.getByText('Close')).toBeTruthy();
    expect(screen.queryByText('Discuss with agent')).toBeNull();
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

  it('Close button hides the panel without sending a message (agent-review)', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask({ delivery: 'agent-review', result: 'x' }));
    });
    await act(async () => {
      screen.getByText('Close').click();
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

  it('renders the panel when a task is set', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(document.getElementById('task-result-panel')).not.toBeNull();
  });

  it('closes on Escape key', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    expect(document.getElementById('task-result-panel')).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUIStore.getState().taskResultTask).toBeNull();
    const panelAfterEsc = document.getElementById('task-result-panel');
    expect(panelAfterEsc).not.toBeNull();
    expect(panelAfterEsc!.classList.contains('hidden')).toBe(true);
  });

  it('closes on backdrop click', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    const backdrop = document.querySelector('.task-result-backdrop');
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useUIStore.getState().taskResultTask).toBeNull();
  });

  it('does not close when clicking inside the modal', async () => {
    render(<TaskResultPanel />);
    await act(async () => {
      useUIStore.getState().setTaskResultTask(makeTask());
    });
    const panel = document.getElementById('task-result-panel')!;
    await act(async () => {
      panel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(useUIStore.getState().taskResultTask).not.toBeNull();
  });
});
