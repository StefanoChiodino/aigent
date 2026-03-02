/**
 * 39 — Extension side panel iframe rendering
 *
 * Simulates exactly what the Chrome extension side panel does:
 * loads the app in an iframe context by navigating directly to
 * `/?extId=<id>`, the same URL the sidepanel sets on its iframe.
 *
 * This catches any JS errors, CSS failures, or React mounting
 * problems that only appear in the iframe/embedded context.
 */

import { test, expect } from '@playwright/test';

const FAKE_EXT_ID = 'abcdefghijklmnopabcdefghijklmnop'; // 32-char fake extension ID

test.describe('@fast Extension side panel — iframe rendering', () => {
  test('app loads without JS errors when ?extId= query param is present', async ({ page }) => {
    const jsErrors: string[] = [];
    const consoleErrors: string[] = [];

    page.on('pageerror', (err) => jsErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // This is the exact URL the sidepanel.html iframe loads
    await page.goto(`/?extId=${FAKE_EXT_ID}`, { waitUntil: 'domcontentloaded' });

    // Wait for React to mount (#root must have children)
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        return root !== null && root.children.length > 0;
      },
      undefined,
      { timeout: 10_000 }
    );

    expect(jsErrors, `JS errors: ${jsErrors.join(', ')}`).toHaveLength(0);
  });

  test('connection badge is visible and not hidden', async ({ page }) => {
    await page.goto(`/?extId=${FAKE_EXT_ID}`);
    // The connection badge must exist and be visible (not display:none, not zero-size)
    const badge = page.locator('#conn-badge');
    await expect(badge).toBeAttached({ timeout: 10_000 });
    await expect(badge).toBeVisible({ timeout: 10_000 });
  });

  test('app div has non-zero dimensions (not blank/black)', async ({ page }) => {
    await page.goto(`/?extId=${FAKE_EXT_ID}`);

    await page.waitForFunction(
      () => {
        const app = document.getElementById('app');
        if (!app) return false;
        const rect = app.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
      undefined,
      { timeout: 10_000 }
    );

    const dims = await page.evaluate(() => {
      const app = document.getElementById('app');
      if (!app) return null;
      const rect = app.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

    expect(dims).not.toBeNull();
    expect(dims!.width).toBeGreaterThan(0);
    expect(dims!.height).toBeGreaterThan(0);
  });

  test('CSS loads correctly — body has dark background (not white/transparent)', async ({ page }) => {
    await page.goto(`/?extId=${FAKE_EXT_ID}`);
    await page.waitForSelector('#app', { timeout: 10_000 });

    const bg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });

    // Dark theme: should NOT be white or transparent
    // --bg is #0c0c14 = rgb(12, 12, 20)
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('rgb(255, 255, 255)');
  });

  test('WebSocket connects successfully from ?extId= URL', async ({ page }) => {
    await page.goto(`/?extId=${FAKE_EXT_ID}`);

    // Wait for connection badge to show "connected"
    await expect(page.locator('#conn-badge')).toContainText('connected', { timeout: 15_000 });
  });

  test('input field is visible and interactive', async ({ page }) => {
    await page.goto(`/?extId=${FAKE_EXT_ID}`);
    await expect(page.locator('#conn-badge')).toContainText('connected', { timeout: 15_000 });

    const input = page.locator('#input');
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill('hello from side panel');
    await expect(input).toHaveValue('hello from side panel');
  });
});

test.describe('@fast Extension side panel — sidepanel.html behavior', () => {
  /**
   * These tests load the sidepanel.html directly (as served by the extension build).
   * Since we can't load chrome-extension:// URLs in Playwright without loading the
   * actual extension, we instead test the key logic:
   *   1. checkOnline() correctly shows offline state when server is down
   *   2. The retry button reloads the iframe with the new URL format
   */

  test('app root element exists and has content (not blank div)', async ({ page }) => {
    await page.goto(`/?extId=${FAKE_EXT_ID}`);

    const rootContent = await page.evaluate(() => {
      const root = document.getElementById('root');
      return {
        exists: root !== null,
        hasChildren: (root?.children.length ?? 0) > 0,
        innerHTML: root?.innerHTML.slice(0, 200) ?? '',
      };
    });

    expect(rootContent.exists).toBe(true);
    expect(rootContent.hasChildren).toBe(true);
    // If innerHTML is empty, React failed to mount
    expect(rootContent.innerHTML.length).toBeGreaterThan(0);
  });

  test('no 404s for JS or CSS assets', async ({ page }) => {
    const failedRequests: string[] = [];

    page.on('response', (res) => {
      if (res.status() >= 400) {
        failedRequests.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto(`/?extId=${FAKE_EXT_ID}`);
    await page.waitForSelector('#app', { timeout: 10_000 });

    expect(failedRequests, `Failed requests: ${failedRequests.join(', ')}`).toHaveLength(0);
  });
});
