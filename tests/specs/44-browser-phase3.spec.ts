/**
 * 44 — Browser Extension Phase 3a: multi-tab + grants
 *
 * Tests new actions (open_tab, activate_tab) and the "Always Allow"
 * session grant for browser write requests.
 *
 * All events are injected via POST /test/inject — no real Chrome extension required.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Browser Phase 3a — open_tab modal', () => {
  const getPage = useSharedPage();

  test('open_tab browser_write_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_ot1',
      action: 'open_tab',
      stepSummary: 'Open new tab: https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('open_tab modal title is "Browser: Open Tab"', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_ot2',
      action: 'open_tab',
      stepSummary: 'Open new tab: https://example.com/test',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('Browser: Open Tab');
    await page.locator('#perm-deny-btn').click();
  });

  test('open_tab modal shows URL in the detail area', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_ot3',
      action: 'open_tab',
      stepSummary: 'Open new tab: https://example.com/target',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('https://example.com/target');
    await page.locator('#perm-deny-btn').click();
  });

  test('open_tab modal shows mouse pointer emoji icon', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_ot4',
      action: 'open_tab',
      stepSummary: 'Open new tab: https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('🖱️');
    await page.locator('#perm-deny-btn').click();
  });
});

test.describe('@fast Browser Phase 3a — Always Allow button', () => {
  const getPage = useSharedPage();

  test('Always Allow button is visible for navigate requests', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_aa1',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('Always Allow button is visible for run_script requests', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_aa2',
      action: 'run_script',
      stepSummary: 'click .submit-btn',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('Always Allow button is visible for open_tab requests', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_aa3',
      action: 'open_tab',
      stepSummary: 'Open new tab: https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('Always Allow button hides the modal when clicked', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_aa4',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-always-allow-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('"A" keyboard shortcut triggers Always Allow', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_aa5',
      action: 'run_script',
      stepSummary: 'fill #email',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.keyboard.press('a');
    await expectHidden(page.locator('#perm-overlay'));
  });
});

test.describe('@fast Browser Phase 3a — queuing open_tab with other requests', () => {
  const getPage = useSharedPage();

  test('open_tab and run_script queue correctly', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_q1',
      action: 'open_tab',
      stepSummary: 'Open new tab: https://example.com',
    });
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3_q2',
      action: 'run_script',
      stepSummary: 'click .next-btn',
    });

    // First (open_tab) visible
    await expect(page.locator('#perm-card-title')).toHaveText('Browser: Open Tab', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();

    // Second (run_script) shows next
    await expect(page.locator('#perm-card-title')).toHaveText('Browser: Run Script', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });
});
