/**
 * 14 — Background task updates (injected, no LLM)
 *
 * Injects fake task_update events to test the task list in the sidebar
 * and the task badge in the header.
 *
 * task_update events: { type, task: BackgroundTaskInfo }
 * BackgroundTaskInfo: { id, description, status, startedAt, completedAt?, model?,
 *                       inputTokens?, outputTokens?, cost?, delivery?, result? }
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

test.describe('@fast Task Updates', () => {
  const getPage = useSharedPage();

  // ── Header task badge ──────────────────────────────────────────────────────────

  test('task badge appears when a task is running', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 't1', description: 'Analyze codebase', status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#task-badge')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('task badge shows count for running tasks', async () => {
    const page = getPage();
    // Complete previously accumulated task from prior test
    await injectEvent({ type: 'task_update', task: { id: 't1', description: 'Analyze codebase', status: 'completed', startedAt: NOW, completedAt: NOW } });
    await injectEvent({
      type: 'task_update',
      task: { id: 't2', description: 'Task A', status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#task-badge')).toContainText('1 task', { timeout: 3_000 });
  });

  test('task badge hides when task completes', async () => {
    const page = getPage();
    // Complete previously accumulated running tasks
    await injectEvent({ type: 'task_update', task: { id: 't2', description: 'Task A', status: 'completed', startedAt: NOW, completedAt: NOW } });
    await injectEvent({
      type: 'task_update',
      task: { id: 't3', description: 'Quick task', status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#task-badge')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

    await injectEvent({
      type: 'task_update',
      task: { id: 't3', description: 'Quick task', status: 'completed', startedAt: NOW, completedAt: NOW },
    });
    await expect(page.locator('#task-badge')).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  // ── Sidebar task list ──────────────────────────────────────────────────────────

  test('task description appears in sidebar task list', async () => {
    const page = getPage();
    const desc = 'Run security audit';
    await injectEvent({
      type: 'task_update',
      task: { id: 't4', description: desc, status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#sb-tasks-list')).toContainText(desc, { timeout: 3_000 });
  });

  test('running task shows running status indicator', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 't5', description: 'Running task', status: 'running', startedAt: NOW },
    });
    const statusEl = page.locator('#sb-tasks-list .task-status.running');
    await expect(statusEl).toBeVisible({ timeout: 3_000 });
  });

  test('completed task shows completed status indicator', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 't6', description: 'Done task', status: 'running', startedAt: NOW },
    });
    await injectEvent({
      type: 'task_update',
      task: { id: 't6', description: 'Done task', status: 'completed', startedAt: NOW, completedAt: NOW },
    });
    const statusEl = page.locator('#sb-tasks-list .task-status.completed');
    await expect(statusEl).toBeVisible({ timeout: 3_000 });
  });

  test('failed task shows failed status indicator', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 't7', description: 'Failed task', status: 'failed', startedAt: NOW, completedAt: NOW },
    });
    const statusEl = page.locator('#sb-tasks-list .task-status.failed');
    await expect(statusEl).toBeVisible({ timeout: 3_000 });
  });

  test('updating an existing task replaces it in the list', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 't8', description: 'Update test', status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#sb-tasks-list')).toContainText('Update test', { timeout: 3_000 });

    // Same ID, now completed — should update in place, not duplicate
    await injectEvent({
      type: 'task_update',
      task: { id: 't8', description: 'Update test', status: 'completed', startedAt: NOW, completedAt: NOW },
    });
    const items = page.locator('#sb-tasks-list .task-item');
    // Only one item with this description
    await expect(items.filter({ hasText: 'Update test' })).toHaveCount(1, { timeout: 3_000 });
  });

  test('multiple simultaneous running tasks show correct badge count', async () => {
    const page = getPage();
    // Complete previously accumulated running tasks
    for (const id of ['t4', 't5', 't8']) {
      await injectEvent({ type: 'task_update', task: { id, description: id, status: 'completed', startedAt: NOW, completedAt: NOW } });
    }
    await injectEvent({
      type: 'task_update',
      task: { id: 't9a', description: 'Task A', status: 'running', startedAt: NOW },
    });
    await injectEvent({
      type: 'task_update',
      task: { id: 't9b', description: 'Task B', status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#task-badge')).toContainText('2 tasks', { timeout: 3_000 });
  });

  // ── User-pull task result panel ────────────────────────────────────────────────

  test('user-pull completed task is clickable in sidebar', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: {
        id: 'tp1',
        description: 'Pull result task',
        status: 'completed',
        startedAt: NOW,
        completedAt: NOW,
        delivery: 'user-pull',
        result: 'The analysis is complete.',
      },
    });
    const item = page.locator('#sb-tasks-list .task-item-pull');
    await expect(item).toBeVisible({ timeout: 3_000 });
  });

  test('user-pull task auto-opens result panel with correct content', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: {
        id: 'tp2',
        description: 'Clickable pull task',
        status: 'completed',
        startedAt: NOW,
        completedAt: NOW,
        delivery: 'user-pull',
        result: 'Result content here.',
      },
    });

    // The WS handler auto-opens the result panel for user-pull delivery
    const panel = page.locator('#task-result-panel');
    await expect(panel).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await expect(panel.locator('.task-result-title')).toContainText('Clickable pull task');
    await expect(panel.locator('.task-result-body')).toContainText('Result content here.');
  });

  test('task result panel Defer button hides the panel', async () => {
    const page = getPage();
    // Close any previously open result panel first
    const panel = page.locator('#task-result-panel');
    const prevVisible = await panel.evaluate(el => !el.classList.contains('hidden')).catch(() => false);
    if (prevVisible) {
      await panel.locator('.task-result-defer').click();
      await expect(panel).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    }

    await injectEvent({
      type: 'task_update',
      task: {
        id: 'tp3',
        description: 'Close test task',
        status: 'completed',
        startedAt: NOW,
        completedAt: NOW,
        delivery: 'user-pull',
        result: 'Some result',
      },
    });

    // The WS handler auto-opens the result panel
    await expect(panel).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

    await panel.locator('.task-result-defer').click();
    await expect(panel).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  // ── Tasks Inspector ─────────────────────────────────────────────────────────

  test('task_update populates taskHistory for the inspector', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: {
        id: 'ti1',
        description: 'Inspector test task',
        status: 'completed',
        startedAt: NOW,
        completedAt: NOW,
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 1000,
        outputTokens: 500,
        cost: 0.002,
        delivery: 'agent-batch',
        result: 'Task completed successfully.',
      },
    });

    // Open the tasks inspector
    await page.locator('#sb-tasks-section .sidebar-label').click();
    const inspector = page.locator('.tski-modal');
    await expect(inspector).toBeVisible({ timeout: 3_000 });
    await expect(inspector).toContainText('Inspector test task');

    // Close it
    await page.locator('.tski-close').click();
    await expect(inspector).not.toBeVisible({ timeout: 3_000 });
  });

  test('tasks survive browser reconnect via cachedState', async () => {
    const page = getPage();
    // Inject a running task
    await injectEvent({
      type: 'task_update',
      task: { id: 'tr1', description: 'Reconnect survivor', status: 'running', startedAt: NOW },
    });
    await expect(page.locator('#sb-tasks-list')).toContainText('Reconnect survivor', { timeout: 3_000 });

    // Verify the task is visible
    const taskItem = page.locator('#sb-tasks-list .task-item').filter({ hasText: 'Reconnect survivor' });
    await expect(taskItem).toBeVisible({ timeout: 3_000 });
  });
});
