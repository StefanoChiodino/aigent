/**
 * 55 — Always Classify permission list (injected, no LLM)
 *
 * Verifies that:
 * 1. The "Always Classify" textarea appears in the Permissions settings tab
 * 2. Incoming client_settings events update the Always Classify list in real time
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Always Classify Settings', () => {
  const getPage = useSharedPage();

  test('alwaysClassify patterns appear in Settings Permissions tab', async () => {
    const page = getPage();

    // Inject a client_settings event with alwaysClassify data
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysClassify: JSON.stringify(['curl *', 'python *', 'python3 *']),
      },
    });

    // Open Settings modal
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Navigate to Permissions tab (exact match to avoid matching "Fetch Permissions")
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();

    // The Always Classify textarea should be visible and contain the injected patterns.
    const classifyTextarea = page.locator('#settings-body .settings-group:not(.hidden) .settings-row:has(.label-text:text("Always Classify")) .settings-string-list');
    await expect(classifyTextarea).toBeVisible({ timeout: 3_000 });
    await expect(classifyTextarea).toHaveValue(/curl \*/, { timeout: 5_000 });
    await expect(classifyTextarea).toHaveValue(/python \*/);

    // Close settings
    await page.locator('#settings-close').click();
  });

  test('alwaysClassify updates live while Settings modal is open', async () => {
    const page = getPage();

    // Open Settings modal and navigate to Permissions tab first
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();

    // Now inject a client_settings event while the modal is open
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysClassify: JSON.stringify(['wget *', 'pip *']),
      },
    });

    // The textarea should update in real time
    const classifyTextarea = page.locator('#settings-body .settings-group:not(.hidden) .settings-row:has(.label-text:text("Always Classify")) .settings-string-list');
    await expect(classifyTextarea).toHaveValue(/wget \*/, { timeout: 3_000 });
    await expect(classifyTextarea).toHaveValue(/pip \*/);

    // Close settings
    await page.locator('#settings-close').click();
  });
});
