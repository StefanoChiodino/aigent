/**
 * 47 — File access permission modal (injected, no LLM)
 *
 * Injects fake file_access_request events via POST /test/inject.
 * Verifies the modal shows with correct icon, title, path, and buttons.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast File Access Permission Modal', () => {
  const getPage = useSharedPage();

  test('file_access_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa1', path: '/etc/hosts', operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows the file path in the detail area', async () => {
    const page = getPage();
    const path = '/home/user/.bashrc';
    await injectEvent({ type: 'file_access_request', id: 'fa2', path, operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText(path);
    await page.locator('#perm-deny-btn').click();
  });

  test('modal title says "File Read" for read operations', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa3', path: '/tmp/data.txt', operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('File Read');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal title says "File Write" for write operations', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa4', path: '/tmp/output.txt', operation: 'write', reason: 'Agent wants to write this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('File Write');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal icon shows file emoji', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa5', path: '/etc/passwd', operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('📄');
    await page.locator('#perm-deny-btn').click();
  });

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa6', path: '/tmp/test', operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa7', path: '/tmp/test', operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Always Allow button is hidden (not supported for file access)', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'fa8', path: '/tmp/test', operation: 'read', reason: 'Agent wants to read this path' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });
});
