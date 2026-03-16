/**
 * 64 — Per-model max tokens settings
 *
 * Tests the new tiered max tokens UI that replaces the raw JSON textarea.
 * Verifies that Flash, Pro, and Ultra tier inputs work correctly.
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

  test('max tokens setting shows tiered inputs', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Should see tier labels
    await expect(page.locator('.settings-body', { hasText: 'Flash tier' })).toBeVisible();
    await expect(page.locator('.settings-body', { hasText: 'Pro tier' })).toBeVisible();
    await expect(page.locator('.settings-body', { hasText: 'Ultra tier' })).toBeVisible();
  });

  test('max tokens setting shows model names next to tiers', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    // Should see model names in parentheses next to tier labels
    const body = page.locator('#settings-body');
    const text = await body.innerText();
    
    // At least one tier should show a model name
    expect(text).toMatch(/\(claude-|\(google\/|custom-/);
  });

  test('can enter values in tier inputs', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    const inputs = page.locator('.settings-tokens-input');
    const count = await inputs.count();
    expect(count).toBe(3);

    // Enter values in each tier
    const flashInput = inputs.nth(0);
    const proInput = inputs.nth(1);
    const ultraInput = inputs.nth(2);

    await flashInput.fill('8192');
    await expect(flashInput).toHaveValue('8192');

    await proInput.fill('16384');
    await expect(proInput).toHaveValue('16384');

    await ultraInput.fill('32000');
    await expect(ultraInput).toHaveValue('32000');
  });

  test('max tokens setting shows hint text', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    await expect(page.locator('.settings-hint', { 
      hasText: /Set max tokens per tier/ 
    })).toBeVisible();
  });

  test('max tokens setting has default placeholder', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    const inputs = page.locator('.settings-tokens-input');
    for (let i = 0; i < await inputs.count(); i++) {
      const input = inputs.nth(i);
      const placeholder = await input.getAttribute('placeholder');
      expect(placeholder).toBe('default');
    }
  });

  test('can clear tier inputs', async () => {
    const page = getPage();
    await openSettings(page);
    await openModelSettings(page);

    const inputs = page.locator('.settings-tokens-input');
    
    // Fill and clear each input
    for (let i = 0; i < await inputs.count(); i++) {
      const input = inputs.nth(i);
      await input.fill('16384');
      await expect(input).toHaveValue('16384');
      
      await input.clear();
      await expect(input).toHaveValue('');
    }
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
});
