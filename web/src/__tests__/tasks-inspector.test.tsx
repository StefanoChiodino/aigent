/**
 * TasksInspector modal — unit tests for visibility, content, and close behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';
import { useUIStore } from '../stores/ui';
import { useChatStore } from '../stores/chat';
import { TasksInspector } from '../components/modals/TasksInspector';
import type { BackgroundTaskInfo } from '../types';

function makeTask(overrides: Partial<BackgroundTaskInfo> = {}): BackgroundTaskInfo {
  return {
    id: 'task-1-abc',
    description: 'Analyze codebase',
    status: 'completed',
    startedAt: '2026-01-15T10:00:00.000Z',
    completedAt: '2026-01-15T10:00:30.000Z',
    model: 'claude-haiku-4-5-20251001',
    inputTokens: 5000,
    outputTokens: 1200,
    cost: 0.0042,
    delivery: 'agent-batch',
    result: 'Analysis complete. Found 3 issues.',
    ...overrides,
  };
}

describe('TasksInspector', () => {
  beforeEach(() => {
    useUIStore.setState({ tasksInspectorOpen: false });
    useChatStore.setState({ taskHistory: [] });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when tasksInspectorOpen is false', () => {
    const { container } = render(<TasksInspector />);
    expect(container.firstChild).toBeNull();
  });

  it('shows modal when tasksInspectorOpen is true', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(document.querySelector('.tski-modal')).not.toBeNull();
  });

  it('shows "Tasks Inspector" header label', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(screen.getByText('Tasks Inspector')).toBeTruthy();
  });

  it('shows empty state when no tasks', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(screen.getByText('No tasks dispatched yet.')).toBeTruthy();
  });

  it('shows task row with description', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(screen.getByText('Analyze codebase')).toBeTruthy();
  });

  it('shows summary with task count and tokens', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    const summary = document.querySelector('.tski-summary');
    expect(summary?.textContent).toContain('1 task');
    expect(summary?.textContent).toContain('6,200 tokens');
  });

  it('shows model display name in row', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(screen.getByText('Haiku 4.5')).toBeTruthy();
  });

  it('clicking task row opens detail modal', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    expect(document.querySelector('.tski-dm-panel')).not.toBeNull();
  });

  it('detail modal shows task description in header', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    expect(document.querySelector('.tski-dm-title')?.textContent).toBe('Analyze codebase');
  });

  it('detail modal shows Prompt and Result sections', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    expect(screen.getByText('Prompt')).toBeTruthy();
    expect(screen.getByText('Result')).toBeTruthy();
  });

  it('detail modal shows task ID in metadata', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    expect(screen.getByText('task-1-abc')).toBeTruthy();
  });

  it('detail modal shows context in prompt when available', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask({ context: 'Files: src/main.ts' }));
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    const promptSection = document.querySelector('.tski-section-body');
    expect(promptSection?.textContent).toContain('Context: Files: src/main.ts');
  });

  it('first Escape closes detail modal but keeps inspector open', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    // Open detail
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    expect(document.querySelector('.tski-dm-panel')).not.toBeNull();
    // First Escape: close detail
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.tski-dm-panel')).toBeNull();
    expect(useUIStore.getState().tasksInspectorOpen).toBe(true);
  });

  it('second Escape closes inspector when detail is not open', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(useUIStore.getState().tasksInspectorOpen).toBe(false);
  });

  it('clicking detail backdrop closes detail, keeps inspector open', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    expect(document.querySelector('.tski-dm-backdrop')).not.toBeNull();
    await act(async () => {
      (document.querySelector('.tski-dm-backdrop') as HTMLElement)?.click();
    });
    expect(document.querySelector('.tski-dm-panel')).toBeNull();
    expect(useUIStore.getState().tasksInspectorOpen).toBe(true);
  });

  it('clicking detail panel body does not close detail', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-row') as HTMLElement)?.click();
    });
    await act(async () => {
      (document.querySelector('.tski-dm-panel') as HTMLElement)?.click();
    });
    expect(document.querySelector('.tski-dm-panel')).not.toBeNull();
  });

  it('closes on Escape key when no detail open', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUIStore.getState().tasksInspectorOpen).toBe(false);
  });

  it('clicking backdrop closes the inspector', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-backdrop') as HTMLElement)?.click();
    });
    expect(useUIStore.getState().tasksInspectorOpen).toBe(false);
  });

  it('clicking modal body does not close the inspector', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    await act(async () => {
      (document.querySelector('.tski-modal') as HTMLElement)?.click();
    });
    expect(useUIStore.getState().tasksInspectorOpen).toBe(true);
  });

  it('shows multiple tasks in reverse chronological order', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask({ id: 'task-1', description: 'First task', startedAt: '2026-01-15T10:00:00.000Z' }));
      useChatStore.getState().upsertTaskHistory(makeTask({ id: 'task-2', description: 'Second task', startedAt: '2026-01-15T11:00:00.000Z' }));
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    const descs = document.querySelectorAll('.tski-desc');
    expect(descs.length).toBe(2);
    // Second task should appear first (reverse order)
    expect(descs[0]?.textContent).toBe('Second task');
    expect(descs[1]?.textContent).toBe('First task');
  });

  it('shows Clear button when tasks exist', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(document.querySelector('.tski-clear')).not.toBeNull();
  });

  it('does not show Clear button when no tasks', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(document.querySelector('.tski-clear')).toBeNull();
  });

  it('Clear button clears task history', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(useChatStore.getState().taskHistory.length).toBe(1);
    await act(async () => {
      (document.querySelector('.tski-clear') as HTMLElement)?.click();
    });
    expect(useChatStore.getState().taskHistory.length).toBe(0);
  });

  it('shows date column in task row', async () => {
    render(<TasksInspector />);
    await act(async () => {
      useChatStore.getState().upsertTaskHistory(makeTask());
      useUIStore.getState().setTasksInspectorOpen(true);
    });
    expect(document.querySelector('.tski-date')).not.toBeNull();
    // Column header should include Date
    const headers = document.querySelectorAll('.tski-col-h');
    const headerTexts = Array.from(headers).map(h => h.textContent);
    expect(headerTexts).toContain('Date');
  });
});
