/**
 * 01 — Connection & initial UI state
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

test('page loads without critical JS errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await waitForConnected(page);

  expect(errors).toHaveLength(0);
});

test('connection badge transitions from connecting to connected', async ({ page }) => {
  await page.goto('/');
  // May briefly show "connecting"
  const badge = page.locator('#conn-badge');
  await expect(badge).toHaveText('connected', { timeout: 15_000 });
  await expect(badge).not.toHaveClass(/connecting/);
});

test('sidebar model name is populated after connect', async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);

  const modelValue = page.locator('#sb-model-value');
  await expect(modelValue).not.toHaveText('--', { timeout: 5_000 });
  await expect(modelValue).toContainText(/opus|sonnet|haiku/i);
});

test('cost element exists and has a dollar-formatted value', async ({ page }) => {
  // Clear localStorage so cost doesn't carry over from a previous session
  await page.goto('/');
  await page.evaluate(() => { localStorage.removeItem('aigent_chat_history'); });
  await page.reload();
  await waitForConnected(page);
  // Cost may be $0.00 on a fresh session; just verify it's dollar-formatted
  await expect(page.locator('#sb-cost-value')).toContainText('$');
});

test('messages container exists', async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
  await expect(page.locator('#messages')).toBeAttached();
});

test('settings button is visible', async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
  await expect(page.locator('#settings-btn')).toBeVisible();
});
