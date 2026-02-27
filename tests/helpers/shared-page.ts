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
    // Reset all Zustand stores (chat, UI, voice, connection, settings) and
    // dispatch __test_reset_input for local React component state.
    // Use a polling reset: clear stores, then wait for clean state. If the server
    // pushes a late message (e.g. from a /reset the previous test sent), re-clear.
    await page.evaluate(() => {
      sessionStorage.removeItem('aigent-draft');
      const reset = (window as Record<string, unknown>).__testResetStores;
      if (typeof reset === 'function') reset();
    });
    // Clear input field using Playwright's fill() to trigger proper React
    // onChange events (the textarea is a controlled component).
    await page.locator('#input').fill('');
    // Wait for stores to reach clean state, re-clearing if server pushes late messages.
    await page.waitForFunction(() => {
      const chat = (window as Record<string, unknown>).__zustand_chat as { getState: () => { messages: unknown[]; clearMessages: () => void } } | undefined;
      const ui = (window as Record<string, unknown>).__zustand_ui as { getState: () => { errorMsg: unknown; isLoading: boolean } } | undefined;
      const voice = (window as Record<string, unknown>).__zustand_voice as { getState: () => { micState: string } } | undefined;
      if (!chat || !ui || !voice) return false;
      const c = chat.getState();
      const u = ui.getState();
      const v = voice.getState();
      // If server pushed a late message after clearMessages(), re-clear
      if (c.messages.length > 0) { c.clearMessages(); return false; }
      return u.errorMsg === null && !u.isLoading && v.micState === 'idle';
    }, undefined, { timeout: 5_000 });
    // Re-dispatch the local state reset to catch any async callbacks
    // (e.g. STT responses) that fired after the initial reset.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('__test_reset_input'));
    });
  });

  return () => page;
}
