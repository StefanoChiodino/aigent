/**
 * 41 — Browser write permission modal (injected, no LLM)
 *
 * Injects fake browser_write_request events via POST /test/inject
 * and verifies the permission modal behaviour for write actions
 * (navigate and run_script).
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Browser Write Permission Modal', () => {
  const getPage = useSharedPage();

  // ── navigate action ──────────────────────────────────────────────

  test('browser_write_request (navigate) shows permission modal', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw1',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('navigate modal shows the URL in the detail area', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw2',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com/test',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('https://example.com/test');
    await page.locator('#perm-deny-btn').click();
  });

  test('navigate modal title is "Browser: Navigate"', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw3',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('Browser: Navigate');
    await page.locator('#perm-deny-btn').click();
  });

  test('navigate modal shows the current tab URL in the body', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw4',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
      tabUrl: 'https://current-page.example.com/path',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-body')).toContainText('https://current-page.example.com/path');
    await page.locator('#perm-deny-btn').click();
  });

  // ── run_script action ────────────────────────────────────────────

  test('browser_write_request (run_script) shows permission modal', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw5',
      action: 'run_script',
      stepSummary: 'fill #email, fill #password, click [type=submit]',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('run_script modal shows step summary in the detail area', async () => {
    const page = getPage();
    const summary = 'fill #email, fill #password, click [type=submit]';
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw6',
      action: 'run_script',
      stepSummary: summary,
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('fill');
    await page.locator('#perm-deny-btn').click();
  });

  test('run_script modal title is "Browser: Run Script"', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw7',
      action: 'run_script',
      stepSummary: 'click .submit-btn',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('Browser: Run Script');
    await page.locator('#perm-deny-btn').click();
  });

  // ── icon ─────────────────────────────────────────────────────────

  test('modal icon shows mouse pointer emoji for browser write requests', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw8',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('🖱️');
    await page.locator('#perm-deny-btn').click();
  });

  // ── approve / deny ────────────────────────────────────────────────

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw9',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw10',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Always Allow button is visible for browser write requests', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bw11',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    // "Always Allow Domain" is still hidden (not applicable to browser writes)
    await expect(page.locator('#perm-always-allow-domain-btn')).toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  // ── queuing ───────────────────────────────────────────────────────

  test('browser_write and exec requests queue correctly', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'bwq1',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await injectEvent({ type: 'exec_request', id: 'bwq2', command: 'echo queue-test' });

    // First (browser_write) visible
    await expect(page.locator('#perm-card-icon')).toHaveText('🖱️', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();

    // Second (exec) shows immediately — queue advances without hiding the overlay
    await expect(page.locator('#perm-card-icon')).toHaveText('⚡', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('sequential browser_write requests each show correct summary', async () => {
    const page = getPage();
    const summary1 = 'Navigate to https://first.example.com';
    const summary2 = 'click .submit-btn';

    await injectEvent({
      type: 'browser_write_request',
      id: 'bwseq1',
      action: 'navigate',
      stepSummary: summary1,
    });
    await expect(page.locator('#perm-card-detail')).toContainText('first.example.com', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await injectEvent({
      type: 'browser_write_request',
      id: 'bwseq2',
      action: 'run_script',
      stepSummary: summary2,
    });
    await expect(page.locator('#perm-card-detail')).toContainText('click', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
  });
});
