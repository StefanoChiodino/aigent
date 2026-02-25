/**
 * 01 — Connection & initial UI state
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Connection & initial UI state', () => {
  const getPage = useSharedPage();

  test('page loads without critical JS errors', async () => {
    const page = getPage();
    // Listen for errors during a reload to catch runtime issues
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.reload();
    await waitForConnected(page);
    page.removeListener('pageerror', () => {});
    expect(errors).toHaveLength(0);
  });

  test('connection badge shows "connected"', async () => {
    const page = getPage();
    const badge = page.locator('#conn-badge');
    await expect(badge).toHaveText('connected', { timeout: 15_000 });
    await expect(badge).not.toHaveClass(/connecting/);
  });

  test('sidebar model name is populated after connect', async () => {
    const page = getPage();
    const modelValue = page.locator('#sb-model-value');
    await expect(modelValue).not.toHaveText('--', { timeout: 5_000 });
    await expect(modelValue).toContainText(/opus|sonnet|haiku/i);
  });

  test('cost element exists and has a dollar-formatted value', async () => {
    const page = getPage();
    await expect(page.locator('#sb-cost-value')).toContainText('$');
  });

  test('messages container exists', async () => {
    const page = getPage();
    await expect(page.locator('#messages')).toBeAttached();
  });

  test('settings button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });
});
