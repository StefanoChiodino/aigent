/**
 * 23 — Task result panel: "Discuss with agent" button
 *
 * 14-task-updates.spec.ts covers open/close. This file adds the
 * "Discuss with agent" button behaviour and panel content details.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

test.describe('@fast Task Result Panel', () => {
  const getPage = useSharedPage();

  async function openResultPanel(page: import('@playwright/test').Page, id: string, description: string, result: string) {
    await injectEvent({
      type: 'task_update',
      task: { id, description, status: 'completed', startedAt: NOW, completedAt: NOW, delivery: 'user-pull', result },
    });
    const item = page.locator('#sb-tasks-list .task-item-pull', { hasText: description });
    await expect(item).toBeVisible({ timeout: 3_000 });
    // Use force:true — the sidebar panel's overflow-y:auto can intercept pointer events
    await item.click({ force: true });
    await expect(page.locator('#task-result-panel')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  }

  // ── Panel content ─────────────────────────────────────────────────────────────

  test('result panel shows task description as title', async () => {
    const page = getPage();
    await openResultPanel(page, 'trp-1', 'Security analysis', 'All clear.');
    await expect(page.locator('.task-result-title')).toHaveText('Security analysis');
  });

  test('result panel shows result body text', async () => {
    const page = getPage();
    await openResultPanel(page, 'trp-2', 'Code review', 'No issues found in the codebase.');
    await expect(page.locator('.task-result-body')).toContainText('No issues found in the codebase.');
  });

  test('result panel has a Discuss button', async () => {
    const page = getPage();
    await openResultPanel(page, 'trp-3', 'Discuss test', 'Some result.');
    const btn = page.locator('.task-result-discuss');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText(/discuss/i);
  });

  // ── Discuss button ────────────────────────────────────────────────────────────

  test('clicking Discuss closes the panel', async () => {
    const page = getPage();
    await openResultPanel(page, 'trp-4', 'Discuss closes', 'The result.');
    await page.locator('.task-result-discuss').click();
    await expect(page.locator('#task-result-panel')).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('clicking Discuss sends a message referencing the task description', async () => {
    const page = getPage();
    const desc = 'Architecture review';
    await openResultPanel(page, 'trp-5', desc, 'Detailed findings here.');
    await page.locator('.task-result-discuss').click();

    // The message sent should mention the task description
    // Wait for it to appear as a user message in the chat
    const msgs = page.locator('#messages .message.user');
    await expect(msgs.last()).toContainText(desc, { timeout: 5_000 });
  });

  test('clicking Discuss sends a message containing the result text', async () => {
    const page = getPage();
    const result = 'Unique-result-content-xyz';
    await openResultPanel(page, 'trp-6', 'Result content test', result);
    await page.locator('.task-result-discuss').click();

    const msgs = page.locator('#messages .message.user');
    await expect(msgs.last()).toContainText(result, { timeout: 5_000 });
  });

  // ── Close button ──────────────────────────────────────────────────────────────

  test('close button hides the panel', async () => {
    const page = getPage();
    await openResultPanel(page, 'trp-7', 'Close button test', 'Result.');
    await page.locator('.task-result-close').click();
    await expect(page.locator('#task-result-panel')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('panel is hidden by default before any task is clicked', async () => {
    const page = getPage();
    await expect(page.locator('#task-result-panel')).toHaveClass(/\bhidden\b/);
  });

  // ── Multiple tasks ─────────────────────────────────────────────────────────────

  test('opening a second task updates the panel title', async () => {
    const page = getPage();
    await openResultPanel(page, 'trp-8a', 'First task', 'First result.');
    await expect(page.locator('.task-result-title')).toHaveText('First task');

    // Close and open second task
    await page.locator('.task-result-close').click();

    await injectEvent({
      type: 'task_update',
      task: { id: 'trp-8b', description: 'Second task', status: 'completed', startedAt: NOW, completedAt: NOW, delivery: 'user-pull', result: 'Second result.' },
    });
    const secondItem = page.locator('#sb-tasks-list .task-item-pull', { hasText: 'Second task' });
    await expect(secondItem).toBeVisible({ timeout: 3_000 });
    await secondItem.click({ force: true });

    await expect(page.locator('.task-result-title')).toHaveText('Second task', { timeout: 2_000 });
    await expect(page.locator('.task-result-body')).toContainText('Second result.');
  });

  // ── Non-user-pull tasks are not clickable ────────────────────────────────────

  test('non-user-pull completed task does not have task-item-pull class', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 'trp-9', description: 'Auto-deliver task', status: 'completed', startedAt: NOW, completedAt: NOW },
    });
    await expect(page.locator('#sb-tasks-list')).toContainText('Auto-deliver task', { timeout: 3_000 });
    const item = page.locator('#sb-tasks-list .task-item', { hasText: 'Auto-deliver task' });
    // Should NOT have the task-item-pull class
    const classes = await item.getAttribute('class') ?? '';
    expect(classes).not.toContain('task-item-pull');
  });
});
