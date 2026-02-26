/**
 * 45 — Browser Extension Phase 3b: close_tab + autonomous mode
 *
 * Tests close_tab action permission modal and the "Go Autonomous" button
 * for browser write requests.
 *
 * All events are injected via POST /test/inject — no real Chrome extension required.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Browser Phase 3b — close_tab modal', () => {
  const getPage = useSharedPage();

  test('close_tab browser_write_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_ct1',
      action: 'close_tab',
      stepSummary: 'Close tab 42',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('close_tab modal title is "Browser: Close Tab"', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_ct2',
      action: 'close_tab',
      stepSummary: 'Close tab 99',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('Browser: Close Tab');
    await page.locator('#perm-deny-btn').click();
  });

  test('close_tab modal shows tab info in detail', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_ct3',
      action: 'close_tab',
      stepSummary: 'Close tab 123',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('Close tab 123');
    await page.locator('#perm-deny-btn').click();
  });

  test('close_tab modal shows mouse pointer emoji icon', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_ct4',
      action: 'close_tab',
      stepSummary: 'Close tab 42',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('🖱️');
    await page.locator('#perm-deny-btn').click();
  });
});

test.describe('@fast Browser Phase 3b — Go Autonomous button', () => {
  const getPage = useSharedPage();

  test('Go Autonomous button is visible when autonomousCmd is provided', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_auto1',
      action: 'run_script',
      stepSummary: 'click .submit-btn',
      autonomousCmd: '/grant-browser-autonomous',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-autonomous-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('Go Autonomous button is hidden when autonomousCmd is not provided', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_auto2',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-autonomous-btn')).toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('Go Autonomous button dismisses modal when clicked', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_auto3',
      action: 'run_script',
      stepSummary: 'fill #email',
      autonomousCmd: '/grant-browser-autonomous',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-autonomous-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Go Autonomous button is visible for close_tab requests', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3b_auto4',
      action: 'close_tab',
      stepSummary: 'Close tab 42',
      autonomousCmd: '/grant-browser-autonomous',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-autonomous-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });
});
