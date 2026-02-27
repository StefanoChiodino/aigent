/**
 * 46 — Settings persistence
 *
 * Verifies the three classes of bugs that were causing settings and permissions
 * to silently reset:
 *
 * 1. mergeClientSettings direction — server push should NOT overwrite locally
 *    persisted values; it should only fill in missing keys (except perm lists).
 *
 * 2. Permission lists (exec_perm_*, fetch_perm_*) always take the server value
 *    because the gatekeeper is the authoritative owner.
 *
 * 3. A server-sent client_settings event with permission data merges into the
 *    existing store rather than replacing unrelated keys.
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Settings persistence', () => {
  const getPage = useSharedPage();

  // ── Bug 1: locally-persisted client settings survive a server push ──────────

  test('locally-set client setting is not overwritten by server push', async () => {
    const page = getPage();

    // Write a specific value into the settings store via the settings modal
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Navigate to the Model tab and set a known model name
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
    const modelInput = page.locator('#settings-body .settings-group:not(.hidden) input.settings-text[type="text"]').first();
    await modelInput.fill('my-persistent-model');
    await page.locator('#settings-close').click();

    // Now inject a server push that contains a *different* value for the same key
    await injectEvent({
      type: 'client_settings',
      settings: { AIGENT_MODEL: 'server-overwrite-attempt' },
    });

    // The locally-set value must survive — open settings and check
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
    const modelInput2 = page.locator('#settings-body .settings-group:not(.hidden) input.settings-text[type="text"]').first();
    await expect(modelInput2).toHaveValue('my-persistent-model', { timeout: 2_000 });

    // Restore
    await modelInput2.fill('claude-opus-4-6');
    await page.locator('#settings-close').click();
  });

  test('server push fills in a key that has no locally-persisted value', async () => {
    const page = getPage();

    // Inject a server push with a setting that hasn't been locally set
    // (we rely on the fact that the shared page store was just reset)
    await injectEvent({
      type: 'client_settings',
      settings: { AIGENT_FULL_LOGS: true },
    });

    // Open settings and verify the server value is visible
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    const promptNav = page.locator('#settings-nav .settings-nav-item', { hasText: 'Prompt' });
    if (await promptNav.count() > 0) {
      await promptNav.click();
      // The "Full session logs in prompt" toggle should now be on
      const toggle = page.locator('#settings-body .settings-group:not(.hidden) .settings-toggle input[type="checkbox"]').last();
      await expect(toggle).toBeChecked({ timeout: 2_000 });
    }

    await page.locator('#settings-close').click();
  });

  // ── Bug 1b: permission lists always take the server value (gatekeeper owns them) ──

  test('exec_perm_alwaysAllow is always updated from server push', async () => {
    const page = getPage();

    // First set a local value
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ }).click();
    const ta = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await ta.fill('local-pattern');
    await ta.blur();
    await page.locator('#settings-close').click();

    // Server push contains a different set (gatekeeper added something via --always)
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['gatekeeper-added-cmd', 'another-cmd']),
      },
    });

    // The server value must win for permission lists
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ }).click();
    const ta2 = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(ta2).toHaveValue(/gatekeeper-added-cmd/, { timeout: 2_000 });
    await expect(ta2).toHaveValue(/another-cmd/);

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await page.locator('#settings-close').click();
  });

  // ── Bug 3: incoming server push merges, not replaces, other store keys ────────

  test('server push of permission data does not clear unrelated client settings', async () => {
    const page = getPage();

    // Set an unrelated client setting
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
    const modelInput = page.locator('#settings-body .settings-group:not(.hidden) input.settings-text[type="text"]').first();
    await modelInput.fill('model-that-should-persist');
    await page.locator('#settings-close').click();

    // Now inject a permissions-only server push (simulating gatekeeper --always)
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['some-cmd']),
        fetch_perm_alwaysAllow: JSON.stringify(['example.com']),
      },
    });

    // The model setting must still be there
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
    const modelInput2 = page.locator('#settings-body .settings-group:not(.hidden) input.settings-text[type="text"]').first();
    await expect(modelInput2).toHaveValue('model-that-should-persist', { timeout: 2_000 });

    // Restore
    await modelInput2.fill('claude-opus-4-6');
    await page.locator('#settings-close').click();
  });

  // ── Fetch permissions also take server value ─────────────────────────────────

  test('fetch_perm_alwaysAllow is always updated from server push', async () => {
    const page = getPage();

    await injectEvent({
      type: 'client_settings',
      settings: {
        fetch_perm_alwaysAllow: JSON.stringify(['api.example.com', '*.github.com']),
      },
    });

    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ }).click();
    const ta = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(ta).toHaveValue(/api\.example\.com/, { timeout: 2_000 });
    await expect(ta).toHaveValue(/\*\.github\.com/);

    // Clean up
    await ta.fill('');
    await ta.blur();
    await page.locator('#settings-close').click();
  });
});
