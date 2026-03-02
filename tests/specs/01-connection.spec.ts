/**
 * 01 — Connection & initial UI state
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Disconnected state', () => {
  test('reconnect banner is visible when WebSocket is blocked', async ({ page }) => {
    // Block the WebSocket so the app stays in connecting/reconnecting indefinitely
    await page.routeWebSocket(/ws:\/\/localhost/, ws => ws.close());
    await page.goto('http://localhost:3141');
    await expect(page.locator('#reconnect-banner')).toBeVisible({ timeout: 5_000 });
  });

  test('reconnect banner is gone once connected', async ({ page }) => {
    await page.goto('http://localhost:3141');
    await waitForConnected(page);
    await expect(page.locator('#reconnect-banner')).not.toBeAttached();
  });

  test('body gets data-disconnected when WebSocket is blocked', async ({ page }) => {
    await page.routeWebSocket(/ws:\/\/localhost/, ws => ws.close());
    await page.goto('http://localhost:3141');
    await expect(page.locator('#reconnect-banner')).toBeVisible({ timeout: 5_000 });
    const hasAttr = await page.evaluate(() => document.body.hasAttribute('data-disconnected'));
    expect(hasAttr).toBe(true);
  });

  test('data-disconnected is removed once connected', async ({ page }) => {
    await page.goto('http://localhost:3141');
    await waitForConnected(page);
    await page.waitForFunction(() => !document.body.hasAttribute('data-disconnected'), { timeout: 5_000 });
    const hasAttr = await page.evaluate(() => document.body.hasAttribute('data-disconnected'));
    expect(hasAttr).toBe(false);
  });
});

test.describe('@fast Connection & initial UI state', () => {
  const getPage = useSharedPage();

  test('page loads without critical JS errors', async () => {
    const page = getPage();
    // Listen for errors during a reload to catch runtime issues
    const errors: string[] = [];
    const onError = (err: Error) => errors.push(err.message);
    page.on('pageerror', onError);
    await page.reload();
    await waitForConnected(page);
    page.removeListener('pageerror', onError);
    expect(errors).toHaveLength(0);
  });

  test('connection badge shows "connected"', async () => {
    const page = getPage();
    const badge = page.locator('#conn-badge');
    await expect(badge).toContainText('connected', { timeout: 15_000 });
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
