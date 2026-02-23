/**
 * Shared Playwright UI helpers.
 *
 * The app uses the `.hidden` CSS class to show/hide elements rather than
 * display:none or aria-hidden, so standard Playwright toBeVisible() sometimes
 * misses transitions. These helpers check the class list directly.
 */

import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Wait for the connection badge to show "connected". */
export async function waitForConnected(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.locator('#conn-badge')).toHaveText('connected', { timeout });
}

/** Assert an element does NOT have the hidden class (i.e. is shown). */
export async function expectVisible(locator: Locator, timeout = 5_000): Promise<void> {
  await expect(locator).not.toHaveClass(/\bhidden\b/, { timeout });
}

/** Assert an element HAS the hidden class (i.e. is hidden). */
export async function expectHidden(locator: Locator, timeout = 3_000): Promise<void> {
  await expect(locator).toHaveClass(/\bhidden\b/, { timeout });
}

/** Toggle a sidebar button and return whether it was toggled to ON. */
export async function getToggleState(locator: Locator): Promise<boolean> {
  const text = await locator.innerText();
  return text.trim() === 'ON';
}

/** Dismiss the permission overlay via deny if it's open. */
export async function dismissPermModal(page: Page): Promise<void> {
  const overlay = page.locator('#perm-overlay');
  const cls = await overlay.getAttribute('class') ?? '';
  if (!cls.includes('hidden')) {
    await page.locator('#perm-deny-btn').click();
  }
}

/**
 * If the agent is currently loading (streaming), send a cancel and wait for
 * it to settle. Safe to call when not loading — no-op in that case.
 */
export async function cancelIfLoading(page: Page, timeout = 5_000): Promise<void> {
  const isLoading = await page.evaluate(() => document.body.hasAttribute('data-working'));
  if (!isLoading) return;
  // Click the cancel button (or send cancel via keyboard)
  const cancelBtn = page.locator('#cancel');
  const isVisible = await cancelBtn.isVisible().catch(() => false);
  if (isVisible) {
    await cancelBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  // Wait for loading to stop
  await page.waitForFunction(() => !document.body.hasAttribute('data-working'), { timeout }).catch(() => {});
}
