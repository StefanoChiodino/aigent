/**
 * 64 — Per-model max tokens settings
 *
 * Tests the rich table editor for max tokens configuration.
 * Verifies table view, edit mode, and quick actions.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

const FLASH = 'claude-haiku-4-5-20251001';
const PRO   = 'claude-sonnet-4-6';
const ULTRA = 'claude-opus-4-6';

test.describe('@fast Per-model max tokens settings', () => {
  const getPage = useSharedPage();

  test.beforeEach(async () => {
    const page = getPage();
    // If settings is open, cancel out of any edit mode first, then close the overlay
    const overlay = page.locator('#settings-overlay');
    const isOpen = await overlay.evaluate((el) => !el.classList.contains('hidden')).catch(() => false);
    if (isOpen) {
      // Cancel out of edit mode if active — scroll to make Cancel button reachable, then click it
      const cancelBtn = page.locator('#settings-body button', { hasText: 'Cancel' });
      if (await cancelBtn.count() > 0) {
        await page.locator('#settings-body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await cancelBtn.click();
      }
      await page.keyboard.press('Escape');
    }
  });

  async function setupModels(page: import('@playwright/test').Page): Promise<void> {
    // Set model tiers and max tokens directly in the Zustand stores
    await page.evaluate(([flash, pro, ultra]: [string, string, string]) => {
      const ui = (window as Record<string, unknown>).__zustand_ui as { getState: () => { setModelTiers: (t: { flash: string; pro: string; ultra: string }) => void } } | undefined;
      const settings = (window as Record<string, unknown>).__zustand_settings as { getState: () => { setClientSetting: (k: string, v: string) => void } } | undefined;
      ui?.getState().setModelTiers({ flash, pro, ultra });
      // value must be a JSON string so SettingControl can parse it with String(value) → JSON.parse
      settings?.getState().setClientSetting('model_max_tokens', JSON.stringify({ [pro]: 16384, [flash]: 8192 }));
    }, [FLASH, PRO, ULTRA] as [string, string, string]);
  }

  async function closeSettingsIfOpen(page: import('@playwright/test').Page): Promise<void> {
    const overlay = page.locator('#settings-overlay');
    const isOpen = await overlay.evaluate((el) => !el.classList.contains('hidden')).catch(() => false);
    if (isOpen) await page.keyboard.press('Escape');
  }

  async function openSettings(page: import('@playwright/test').Page): Promise<void> {
    await closeSettingsIfOpen(page);
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  async function openModelSettings(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
  }

  async function scrollToMaxTokens(page: import('@playwright/test').Page): Promise<void> {
    // Scroll the settings body until the Per-model max tokens section is visible
    await page.locator('#settings-body').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }

  test('max tokens setting shows table header', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Should see table header with columns
    await expect(page.locator('#settings-body th', { hasText: 'Model Tier' })).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#settings-body th', { hasText: 'Model Name' })).toBeVisible();
    await expect(page.locator('#settings-body th', { hasText: 'Max Tokens' })).toBeVisible();
  });

  test('max tokens setting shows model table rows', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Should see at least one model row containing our injected model IDs
    await expect(page.locator('#settings-body td', { hasText: PRO })).toBeVisible({ timeout: 3_000 });
  });

  test('max tokens table has color-coded tiers', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Table rows should have tier labels
    await expect(page.locator('#settings-body td', { hasText: 'Pro' })).toBeVisible({ timeout: 3_000 });
  });

  test('max tokens shows formatted numbers', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Should see formatted number (16,384)
    await expect(page.locator('#settings-body td', { hasText: '16,384' })).toBeVisible({ timeout: 3_000 });
  });

  test('can open edit mode', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Click edit button
    await page.locator('button', { hasText: /Edit JSON/ }).click();

    // Should see textarea for JSON editing
    await expect(page.locator('textarea.settings-json-input')).toBeVisible();

    // Exit edit mode to avoid contaminating subsequent tests
    await page.locator('#settings-body button', { hasText: 'Cancel' }).click();
  });

  test('edit mode shows validation errors', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Click edit button
    await page.locator('button', { hasText: /Edit JSON/ }).click();

    // Enter invalid JSON
    await page.locator('textarea.settings-json-input').fill('invalid');

    // Should show error
    await expect(page.locator('.settings-error')).toBeVisible();

    // Exit edit mode to avoid contaminating subsequent tests
    await page.locator('#settings-body button', { hasText: 'Cancel' }).click();
  });

  test('edit mode accepts valid JSON', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Click edit button
    await page.locator('button', { hasText: /Edit JSON/ }).click();

    // Enter valid JSON
    await page.locator('textarea.settings-json-input').fill('{"test-model": 16384}');

    // Should not show error
    await expect(page.locator('.settings-error')).not.toBeVisible();

    // Exit edit mode to avoid contaminating subsequent tests
    await page.locator('#settings-body button', { hasText: 'Done' }).click();
  });

  test('can use quick action buttons', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Should see quick action buttons
    const buttons = page.locator('button', { hasText: /Quick:/ });
    await expect(buttons.first()).toBeVisible({ timeout: 3_000 });
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Click quick button — should not error
    await buttons.first().click();
    await expect(page.locator('#settings-body')).toBeVisible();
  });

  test('max tokens setting shows hint text', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    await expect(page.locator('.settings-hint', {
      hasText: /Edit JSON/,
    })).toBeVisible({ timeout: 3_000 });
  });

  test('max tokens setting is in Model group', async () => {
    const page = getPage();
    await openSettings(page);

    const modelTab = page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' });
    const count = await modelTab.count();
    expect(count).toBeGreaterThan(0);

    await modelTab.click();
    await expect(modelTab).toHaveClass(/active/);

    const body = page.locator('#settings-body');
    await expect(body).toContainText('Per-model max tokens', { timeout: 2_000 });
  });

  test('table displays model tier labels', async () => {
    const page = getPage();
    await setupModels(page);
    await openSettings(page);
    await openModelSettings(page);
    await scrollToMaxTokens(page);

    // Should see tier labels Flash and Pro from our injected models
    await expect(page.locator('#settings-body td', { hasText: 'Flash' })).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('#settings-body td', { hasText: 'Pro' })).toBeVisible();
  });
});
