/**
 * Shared page helper — creates one browser page per describe block,
 * eliminating ~4s page.goto() + waitForConnected overhead per test.
 *
 * Usage:
 *   test.describe('My Suite', () => {
 *     const getPage = useSharedPage();
 *     test('example', async () => {
 *       const page = getPage();
 *       await expect(page.locator('#foo')).toBeVisible();
 *     });
 *   });
 */

import { test, type Page } from '@playwright/test';
import { waitForConnected } from './ui.js';

export function useSharedPage(): () => Page {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await page.goto('/');
    await waitForConnected(page);
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test.beforeEach(async () => {
    // Unroute any page.route() mocks from previous tests
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    // Reset all Zustand stores (chat, UI, voice) and dispatch __test_reset_input
    // for local React component state (micCapped, hasMicText, palette state, etc.)
    await page.evaluate(() => {
      const reset = (window as Record<string, unknown>).__testResetStores;
      if (typeof reset === 'function') reset();
    });
    // Clear input field using Playwright's fill() to trigger proper React
    // onChange events (the textarea is a controlled component).
    await page.locator('#input').fill('');
    // Wait for React re-renders and any pending async callbacks (e.g. STT
    // responses from mic tests) to settle, then re-dispatch the local state
    // reset to catch any callbacks that fired after the initial reset.
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('__test_reset_input'));
    });
    await page.waitForTimeout(50);
  });

  return () => page;
}
