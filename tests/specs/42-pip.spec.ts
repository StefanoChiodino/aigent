/**
 * 42 — Picture-in-Picture UI
 *
 * Tests the PiP controls in the sidebar (Float button, mode pills, hint text).
 *
 * documentPictureInPicture.requestWindow() requires a non-headless browser and
 * a real user gesture, so we can't test the actual PiP window opening.
 *
 * Strategy: inject a stub via addInitScript (runs before any JS) so that when
 * usePiP() calls isPiPSupported() it returns true, and the controls render.
 */

import { test, expect, type Page } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

// Script injected before the page's own JS runs — makes isPiPSupported() true
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

/** Set AIGENT_PIP_MODE via the settings store in the page. */
async function setPipMode(page: Page, mode: 'manual' | 'auto') {
  await page.evaluate((m) => {
    const s = (window as Record<string, unknown>).__zustand_settings as {
      getState: () => { setClientSetting: (k: string, v: string) => void };
    } | undefined;
    s?.getState().setClientSetting('AIGENT_PIP_MODE', m);
  }, mode);
}

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

  test.beforeEach(async () => {
    // Reset to manual mode before each test
    await setPipMode(page, 'manual');
  });

  // ── Float button ─────────────────────────────────────────────────────────────

  test('Float button is visible in sidebar when PiP is supported', async () => {
    const floatBtn = page.locator('button[title="Float (PiP)"]').first();
    await expect(floatBtn).toBeVisible({ timeout: 3_000 });
  });

  // ── Mode pills ───────────────────────────────────────────────────────────────

  test('"manual" and "auto" pills are rendered in the sidebar', async () => {
    const pills = page.locator('.sb-pill');
    await expect(pills.filter({ hasText: 'manual' }).first()).toBeVisible({ timeout: 3_000 });
    await expect(pills.filter({ hasText: 'auto' }).first()).toBeVisible({ timeout: 3_000 });
  });

  test('"manual" pill is active by default', async () => {
    const manualPill = page.locator('.sb-pill', { hasText: 'manual' }).first();
    await expect(manualPill).toHaveClass(/active/, { timeout: 3_000 });
  });

  test('clicking "auto" pill makes it active', async () => {
    const autoPill = page.locator('.sb-pill', { hasText: 'auto' }).first();
    await autoPill.click();
    await expect(autoPill).toHaveClass(/active/, { timeout: 2_000 });
  });

  test('clicking "auto" pill saves AIGENT_PIP_MODE=auto', async () => {
    const autoPill = page.locator('.sb-pill', { hasText: 'auto' }).first();
    await autoPill.click();
    const stored = await page.evaluate(() => {
      const s = (window as Record<string, unknown>).__zustand_settings as {
        getState: () => { clientSettings: Record<string, unknown> };
      } | undefined;
      return s?.getState().clientSettings['AIGENT_PIP_MODE'];
    });
    expect(stored).toBe('auto');
  });

  // ── Hint text ────────────────────────────────────────────────────────────────

  test('auto mode shows the silent-audio-stream hint', async () => {
    await setPipMode(page, 'auto');
    await expect(page.locator('text=silent audio stream').first()).toBeVisible({ timeout: 3_000 });
  });

  test('manual mode hides the silent-audio-stream hint', async () => {
    // Should already be manual from beforeEach, but be explicit
    await setPipMode(page, 'manual');
    await expect(page.locator('text=silent audio stream').first()).not.toBeVisible();
  });
});
