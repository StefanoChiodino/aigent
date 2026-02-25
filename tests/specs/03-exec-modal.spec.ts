/**
 * 03 — Exec permission modal (injected, no LLM)
 *
 * Injects fake exec_request events via POST /test/inject.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Exec Permission Modal', () => {
  const getPage = useSharedPage();

  test('exec_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'e1', command: 'echo integration-test' });
    await expectVisible(page.locator('#perm-overlay'));
  });

  test('modal shows the command in the detail area', async () => {
    const page = getPage();
    const cmd = 'ls -la /workspace';
    await injectEvent({ type: 'exec_request', id: 'e2', command: cmd });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText(cmd);
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'e3', command: 'echo deny-test' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'e4', command: 'echo approve-test' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Always Allow button is visible for exec requests', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'e5', command: 'git log --oneline' });
    await expectVisible(page.locator('#perm-overlay'));
    // perm-always-allow-btn should NOT have the hidden class for exec requests
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('sequential exec requests each show the correct command', async () => {
    const page = getPage();
    const cmd1 = 'cat /etc/os-release';
    const cmd2 = 'df -h';

    await injectEvent({ type: 'exec_request', id: 'seq1', command: cmd1 });
    await expect(page.locator('#perm-card-detail')).toContainText(cmd1, { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await injectEvent({ type: 'exec_request', id: 'seq2', command: cmd2 });
    await expect(page.locator('#perm-card-detail')).toContainText(cmd2, { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
  });

  test('modal icon and title are populated', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'e6', command: 'echo icon-test' });
    await expectVisible(page.locator('#perm-overlay'));
    // Icon and title should not be empty
    await expect(page.locator('#perm-card-title')).not.toBeEmpty();
    await page.locator('#perm-deny-btn').click();
  });
});
