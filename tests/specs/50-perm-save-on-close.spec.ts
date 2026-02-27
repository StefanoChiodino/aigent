/**
 * 50 — Permission allow-list save on modal close
 *
 * Regression tests for the bug where permission entries typed into the
 * string-list textarea were lost because:
 *   (a) the textarea only committed on blur, and closing the modal via
 *       Escape or X button could skip blur;
 *   (b) a server push (client_settings) overwrote the textarea while
 *       the user was actively editing.
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Permission save on modal close', () => {
  const getPage = useSharedPage();

  async function openSettings(page: import('@playwright/test').Page) {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  async function goToPermissions(page: import('@playwright/test').Page) {
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ }).click();
  }

  async function getFirstTextarea(page: import('@playwright/test').Page) {
    return page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
  }

  // ── (a) Closing modal with Escape commits the focused textarea ───────────

  test('permission entries persist when modal is closed via Escape', async () => {
    const page = getPage();
    await openSettings(page);
    await goToPermissions(page);

    const ta = await getFirstTextarea(page);
    await ta.fill('');
    await ta.pressSequentially('my-test-pattern', { delay: 20 });
    // Do NOT blur — close via Escape while textarea is still focused
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Re-open and verify the value persisted
    await openSettings(page);
    await goToPermissions(page);
    const ta2 = await getFirstTextarea(page);
    await expect(ta2).toHaveValue(/my-test-pattern/, { timeout: 2_000 });

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await page.locator('#settings-close').click();
  });

  // ── (a2) Closing modal by clicking X commits the focused textarea ────────

  test('permission entries persist when modal is closed via X button', async () => {
    const page = getPage();
    await openSettings(page);
    await goToPermissions(page);

    const ta = await getFirstTextarea(page);
    await ta.fill('');
    await ta.pressSequentially('x-button-pattern', { delay: 20 });
    // Close via X button — focus may or may not leave the textarea
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Re-open and verify
    await openSettings(page);
    await goToPermissions(page);
    const ta2 = await getFirstTextarea(page);
    await expect(ta2).toHaveValue(/x-button-pattern/, { timeout: 2_000 });

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await page.locator('#settings-close').click();
  });

  // ── (b) Server push does not overwrite focused textarea ──────────────────

  test('server push does not overwrite textarea while user is editing', async () => {
    const page = getPage();
    await openSettings(page);
    await goToPermissions(page);

    const ta = await getFirstTextarea(page);
    await ta.fill('');
    await ta.pressSequentially('user-is-typing', { delay: 20 });

    // While the textarea is focused, inject a server push with different data
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['server-pushed-value']),
      },
    });

    // Give the event time to arrive and potentially overwrite
    await page.waitForTimeout(300);

    // The user's text must still be present
    await expect(ta).toHaveValue(/user-is-typing/, { timeout: 1_000 });

    // Blur to commit
    await ta.blur();
    await page.locator('#settings-close').click();

    // Verify the committed value persisted (not the server-pushed value)
    await openSettings(page);
    await goToPermissions(page);
    const ta2 = await getFirstTextarea(page);
    await expect(ta2).toHaveValue(/user-is-typing/, { timeout: 2_000 });

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await page.locator('#settings-close').click();
  });

  // ── Fetch permissions tab works too ──────────────────────────────────────

  test('fetch permission entries persist when modal is closed via Escape', async () => {
    const page = getPage();
    await openSettings(page);
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ }).click();

    const ta = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await ta.fill('');
    await ta.pressSequentially('api.example.com', { delay: 20 });
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Re-open and verify
    await openSettings(page);
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ }).click();
    const ta2 = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(ta2).toHaveValue(/api\.example\.com/, { timeout: 2_000 });

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await page.locator('#settings-close').click();
  });
});
