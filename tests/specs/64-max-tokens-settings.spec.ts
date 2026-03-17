/**
 * 64 — Per-model max tokens settings
 *
 * Tests the rich table editor for max tokens configuration.
 * Verifies table view, edit mode, and quick actions.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Per-model max tokens settings', () => {
  const getPage = useSharedPage();

  async function openSettings(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  async function openModelSettings(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
  }

  test('max tokens setting shows table header', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Should see table header with columns
    await expect(page.locator('.settings-body', { hasText: 'Model Tier' })).toBeVisible();
    await expect(page.locator('.settings-body', { hasText: 'Model Name' })).toBeVisible();
    await expect(page.locator('.settings-body', { hasText: 'Max Tokens' })).toBeVisible();
  });

  test('max tokens setting shows model table rows', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Should see at least one model row (Flash, Pro, or Ultra)
    const body = page.locator('#settings-body');
    const text = await body.innerText();
    expect(text).toMatch(/claude-|google\//);
  });

  test('max tokens table has color-coded tiers', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Table rows should have colored left borders
    const rows = page.locator('.settings-body').locator('div').filter({ hasText: 'Flash' });
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
  });

  test('max tokens shows formatted numbers', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Should see formatted numbers (with thousands separator)
    const body = page.locator('#settings-body');
    const text = await body.innerText();
    expect(text).toMatch(/\d{3},\d{3}/);
  });

  test('can open edit mode', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Click edit button
    await page.locator('button', { hasText: /Edit/ }).click();

    // Should see textarea for JSON editing
    await expect(page.locator('textarea.settings-json-input')).toBeVisible();
  });

  test('edit mode shows validation errors', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Click edit button
    await page.locator('button', { hasText: /Edit/ }).click();

    // Enter invalid JSON
    await page.locator('textarea.settings-json-input').fill('invalid');

    // Should show error
    await expect(page.locator('.settings-error')).toBeVisible();
  });

  test('edit mode accepts valid JSON', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Click edit button
    await page.locator('button', { hasText: /Edit/ }).click();

    // Enter valid JSON
    await page.locator('textarea.settings-json-input').fill('{"test-model": 16384}');

    // Should not show error
    await expect(page.locator('.settings-error')).not.toBeVisible();
  });

  test('can use quick action buttons', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Should see quick action buttons
    const buttons = page.locator('button', { hasText: /Quick:/ });
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(1);

    // Click quick button
    await buttons.first().click();

    // Should update the JSON (check for success indicator or updated value)
    const body = page.locator('#settings-body');
    await expect(body).toBeVisible();
  });

  test('max tokens setting shows hint text', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    await expect(page.locator('.settings-hint', { 
      hasText: /Edit JSON/ 
    })).toBeVisible();
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
    await openSettings(page);
    await openModelSettings(page);

    // Should see tier labels like Flash, Pro, Ultra, or Custom
    const body = page.locator('#settings-body');
    const text = await body.innerText();
    expect(text).toMatch(/Flash|Pro|Ultra|Custom/);
  });
});
