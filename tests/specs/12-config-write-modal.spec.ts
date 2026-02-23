/**
 * 12 — Config write permission modal (injected, no LLM)
 *
 * Injects fake config_write_request events via POST /test/inject.
 * The config_write_request modal shows file path + reason and has
 * approve/reject buttons. Unlike exec/fetch, there is NO "Always Allow" button.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected, expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

test('config_write_request shows permission modal', async ({ page }) => {
  await injectEvent({
    type: 'config_write_request',
    id: 'cw1',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason: 'Update default model',
  });
  await expectVisible(page.locator('#perm-overlay'));
  await page.locator('#perm-deny-btn').click();
});

test('modal title is "Config Write Request"', async ({ page }) => {
  await injectEvent({
    type: 'config_write_request',
    id: 'cw2',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason: 'Test reason',
  });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-title')).toHaveText('Config Write Request');
  await page.locator('#perm-deny-btn').click();
});

test('modal shows the file path in the detail area', async ({ page }) => {
  const file = '/workspace/config/mcp.json';
  await injectEvent({
    type: 'config_write_request',
    id: 'cw3',
    file,
    content: '{"servers": []}',
    reason: 'Remove unused MCP server',
  });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-detail')).toContainText(file);
  await page.locator('#perm-deny-btn').click();
});

test('modal shows the reason in the detail area', async ({ page }) => {
  const reason = 'Agent wants to persist new API endpoint setting';
  await injectEvent({
    type: 'config_write_request',
    id: 'cw4',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason,
  });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-detail')).toContainText(reason);
  await page.locator('#perm-deny-btn').click();
});

test('modal icon is ✏️ for config write requests', async ({ page }) => {
  await injectEvent({
    type: 'config_write_request',
    id: 'cw5',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason: 'Icon test',
  });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-icon')).toHaveText('✏️');
  await page.locator('#perm-deny-btn').click();
});

test('Deny button hides the modal', async ({ page }) => {
  await injectEvent({
    type: 'config_write_request',
    id: 'cw6',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason: 'Deny test',
  });
  await expectVisible(page.locator('#perm-overlay'));
  await page.locator('#perm-deny-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
});

test('Approve button hides the modal', async ({ page }) => {
  await injectEvent({
    type: 'config_write_request',
    id: 'cw7',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason: 'Approve test',
  });
  await expectVisible(page.locator('#perm-overlay'));
  await page.locator('#perm-approve-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
});

test('Always Allow button is hidden for config write requests', async ({ page }) => {
  await injectEvent({
    type: 'config_write_request',
    id: 'cw8',
    file: '/workspace/config/settings.json',
    content: '{}',
    reason: 'Always-allow test',
  });
  await expectVisible(page.locator('#perm-overlay'));
  // config_write has no alwaysAllowCmd, so the button should be hidden
  await expect(page.locator('#perm-always-allow-btn')).toHaveClass(/\bhidden\b/);
  await page.locator('#perm-deny-btn').click();
});

test('sequential config_write_requests each show the correct file', async ({ page }) => {
  const file1 = '/workspace/config/settings.json';
  const file2 = '/workspace/config/mcp.json';

  await injectEvent({ type: 'config_write_request', id: 'cwseq1', file: file1, content: '{}', reason: 'first' });
  await expect(page.locator('#perm-card-detail')).toContainText(file1, { timeout: 5_000 });
  await page.locator('#perm-deny-btn').click();
  await expectHidden(page.locator('#perm-overlay'));

  await injectEvent({ type: 'config_write_request', id: 'cwseq2', file: file2, content: '{}', reason: 'second' });
  await expect(page.locator('#perm-card-detail')).toContainText(file2, { timeout: 5_000 });
  await page.locator('#perm-deny-btn').click();
});

test('config_write and exec requests queue correctly', async ({ page }) => {
  await injectEvent({ type: 'config_write_request', id: 'cwq1', file: '/workspace/config/settings.json', content: '{}', reason: 'queue test' });
  await injectEvent({ type: 'exec_request', id: 'cwq2', command: 'echo after-config-write' });

  // First (config_write) visible — icon is ✏️
  await expect(page.locator('#perm-card-icon')).toHaveText('✏️', { timeout: 5_000 });
  await page.locator('#perm-deny-btn').click();

  // Second (exec) follows immediately
  await expect(page.locator('#perm-card-icon')).toHaveText('⚡', { timeout: 5_000 });
  await page.locator('#perm-deny-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
});
