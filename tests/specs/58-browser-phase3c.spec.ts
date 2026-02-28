/**
 * 58 — Browser Extension Phase 3c: destructive heuristics + connection indicator
 *
 * Tests:
 * - Destructive browser_write_request shows ⚠ in title, detail in body, hides "Always Allow"
 * - Non-destructive browser_write_request still shows "Always Allow"
 * - Extension connection indicator appears in sidebar after host_state event
 *
 * All events are injected via POST /test/inject — no real Chrome extension required.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Browser Phase 3c — destructive heuristics', () => {
  const getPage = useSharedPage();

  test('destructive request shows warning icon in title', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3c_d1',
      action: 'run_script',
      stepSummary: 'click "Delete Account"',
      destructive: true,
      destructiveDetail: 'click "Delete Account" (delete)',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toContainText('⚠');
    await page.locator('#perm-deny-btn').click();
  });

  test('destructive request shows detail in body', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3c_d2',
      action: 'run_script',
      stepSummary: 'click "Submit Order"',
      destructive: true,
      destructiveDetail: 'click "Submit Order" (submit)',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-body')).toContainText('Destructive');
    await expect(page.locator('#perm-card-body')).toContainText('submit');
    await page.locator('#perm-deny-btn').click();
  });

  test('destructive request hides "Always Allow" button', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3c_d3',
      action: 'run_script',
      stepSummary: 'click "Purchase Now"',
      destructive: true,
      destructiveDetail: 'click "Purchase Now" (purchase)',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('non-destructive request shows "Always Allow" button', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3c_d4',
      action: 'run_script',
      stepSummary: 'click #search-btn',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('non-destructive request title has no warning icon', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3c_d5',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com',
    });
    await expectVisible(page.locator('#perm-overlay'));
    const title = await page.locator('#perm-card-title').innerText();
    expect(title).not.toContain('⚠');
    await page.locator('#perm-deny-btn').click();
  });

  test('destructive navigate shows ⚠ Browser: Navigate', async () => {
    const page = getPage();
    await injectEvent({
      type: 'browser_write_request',
      id: 'p3c_d6',
      action: 'navigate',
      stepSummary: 'Navigate to https://example.com/delete-account',
      destructive: true,
      destructiveDetail: 'navigate → "delete" in URL path',
    });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toContainText('⚠ Browser: Navigate');
    await page.locator('#perm-deny-btn').click();
  });
});

test.describe('@fast Browser Phase 3c — connection indicator', () => {
  const getPage = useSharedPage();

  test('extension indicator not shown by default', async () => {
    const page = getPage();
    // The Browser cap item should not be visible initially
    const browserCap = page.locator('#sb-caps-list .cap-item', { hasText: 'Browser' });
    await expect(browserCap).toHaveCount(0);
  });

  test('extension indicator appears after host_state extensionConnected', async () => {
    const page = getPage();
    await injectEvent({
      type: 'host_state',
      extensionConnected: true,
    });
    const browserCap = page.locator('#sb-caps-list .cap-item', { hasText: 'Browser' });
    await expect(browserCap).toBeVisible({ timeout: 3_000 });
    await expect(browserCap.locator('.cap-grant')).toHaveText('on');
  });

  test('extension indicator disappears when disconnected', async () => {
    const page = getPage();
    // First connect
    await injectEvent({
      type: 'host_state',
      extensionConnected: true,
    });
    const browserCap = page.locator('#sb-caps-list .cap-item', { hasText: 'Browser' });
    await expect(browserCap).toBeVisible({ timeout: 3_000 });

    // Then disconnect
    await injectEvent({
      type: 'host_state',
      extensionConnected: false,
    });
    await expect(browserCap).toHaveCount(0, { timeout: 3_000 });
  });
});
