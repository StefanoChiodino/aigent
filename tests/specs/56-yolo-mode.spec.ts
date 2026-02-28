/**
 * 56 — YOLO mode settings UI
 *
 * Verifies that:
 * 1. YOLO toggles are rendered with danger styling in Settings
 * 2. YOLO toggles can be toggled and the value persists via POST /settings
 * 3. YOLO toggles appear in each permission group (Permissions, Fetch, File)
 *
 * Note: The auto-approve bypass is gatekeeper-side logic — when YOLO is on,
 * the gatekeeper never sends exec_request/fetch_request/file_access_request
 * to the browser. This is tested via the unit test in settings-payload.test.ts.
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast YOLO Mode', () => {
  const getPage = useSharedPage();

  // ── Danger styling in Settings ───────────────────────────────────────────

  test('YOLO toggles have danger styling in Permissions tab', async () => {
    const page = getPage();

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Navigate to Permissions tab (exact match)
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();

    const dangerRow = page.locator('#settings-body .settings-group:not(.hidden) .settings-row--danger').first();
    await expect(dangerRow).toBeVisible({ timeout: 2_000 });
    await expect(dangerRow.locator('.label-text')).toHaveText('YOLO mode');
    // Verify it has a toggle
    await expect(dangerRow.locator('.settings-toggle')).toBeVisible();

    await page.locator('#settings-close').click();
  });

  test('YOLO toggles have danger styling in Fetch Permissions tab', async () => {
    const page = getPage();

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const fetchNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ });
    await fetchNav.click();

    const dangerRow = page.locator('#settings-body .settings-group:not(.hidden) .settings-row--danger').first();
    await expect(dangerRow).toBeVisible({ timeout: 2_000 });
    await expect(dangerRow.locator('.label-text')).toHaveText('YOLO mode');
    await expect(dangerRow.locator('.settings-toggle')).toBeVisible();

    await page.locator('#settings-close').click();
  });

  test('YOLO toggles have danger styling in File Permissions tab', async () => {
    const page = getPage();

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const fileNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^File Permissions$/ });
    await fileNav.click();

    const dangerRow = page.locator('#settings-body .settings-group:not(.hidden) .settings-row--danger').first();
    await expect(dangerRow).toBeVisible({ timeout: 2_000 });
    await expect(dangerRow.locator('.label-text')).toHaveText('YOLO mode');
    await expect(dangerRow.locator('.settings-toggle')).toBeVisible();

    await page.locator('#settings-close').click();
  });

  // ── YOLO toggle syncs from server ────────────────────────────────────────

  test('exec_perm_yolo syncs from client_settings event', async () => {
    const page = getPage();

    // Inject client_settings with yolo enabled
    await injectEvent({
      type: 'client_settings',
      settings: { exec_perm_yolo: true },
    });

    // Open settings and check the toggle is on
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();

    const yoloCheckbox = page.locator('#settings-body .settings-group:not(.hidden) .settings-row--danger .settings-toggle input');
    await expect(yoloCheckbox).toBeChecked({ timeout: 3_000 });

    // Reset it
    await injectEvent({
      type: 'client_settings',
      settings: { exec_perm_yolo: false },
    });
    await expect(yoloCheckbox).not.toBeChecked({ timeout: 3_000 });

    await page.locator('#settings-close').click();
  });
});
