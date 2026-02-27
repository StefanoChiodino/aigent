/**
 * 42 — Picture-in-Picture UI
 *
 * Tests the PiP Float button in the header.
 *
 * documentPictureInPicture.requestWindow() requires a non-headless browser and
 * a real user gesture, so we can't test the actual PiP window opening.
 *
 * Strategy: inject a stub via addInitScript (runs before any JS) so that when
 * usePiP() checks for PiP support it returns true, and the Float button renders.
 */

import { test, expect, type Page } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

// Script injected before the page's own JS runs — makes PiP supported
const PIP_STUB = `
  Object.defineProperty(window, 'documentPictureInPicture', {
    configurable: true,
    writable: true,
    value: {
      requestWindow: async () => ({
        closed: false,
        close() { this.closed = true; },
        document: {
          createElement: () => ({ textContent: '', src: '', allow: '' }),
          head: { appendChild() {} },
          body: { appendChild() {} },
          title: '',
        },
        addEventListener() {},
      }),
    },
  });
`;

test.describe('PiP UI', () => {
  let page: Page;

  test.beforeAll(async ({ browser, baseURL }) => {
    // Use a dedicated context with the PiP stub pre-installed
    const ctx = await browser.newContext({ baseURL });
    await ctx.addInitScript(PIP_STUB);
    page = await ctx.newPage();
    await page.goto('/');
    await waitForConnected(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  // ── Float button ─────────────────────────────────────────────────────────────

  test('Float button is visible when PiP is supported', async () => {
    const floatBtn = page.locator('button[title="Float (PiP)"]').first();
    await expect(floatBtn).toBeVisible({ timeout: 3_000 });
  });

});
