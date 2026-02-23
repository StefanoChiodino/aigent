/**
 * 08 — Keyboard shortcuts
 *
 * Tests key combos: Ctrl+Enter (send with reasoning flip), Escape, etc.
 * Note: Ctrl+` for mic is tested separately as it requires microphone permissions.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected, cancelIfLoading } from '../helpers/ui.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
  // Cancel any in-progress LLM request left over from previous tests
  // (e.g. @live tests that timed out while the server was still streaming).
  await cancelIfLoading(page);
});

test('Ctrl held flips the send button icon vs current reasoning state', async ({ page }) => {
  const input = page.locator('#input');
  const brainIcon = page.locator('#send .icon-brain');
  const arrowIcon = page.locator('#send .icon-arrow');

  await input.focus();

  // Read initial icon state — depends on current reasoning setting
  const arrowInitiallyHidden = (await arrowIcon.getAttribute('class') ?? '').includes('hidden');

  // Hold Ctrl — icon should flip
  await page.keyboard.down('Control');
  if (arrowInitiallyHidden) {
    // Reasoning was ON → Ctrl flips to OFF → arrow shown
    await expect(arrowIcon).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await expect(brainIcon).toHaveClass(/\bhidden\b/);
  } else {
    // Reasoning was OFF → Ctrl flips to ON → brain shown
    await expect(brainIcon).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    await expect(arrowIcon).toHaveClass(/\bhidden\b/);
  }
  await page.keyboard.up('Control');

  // After releasing Ctrl, icons return to original state
  if (arrowInitiallyHidden) {
    await expect(arrowIcon).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  } else {
    await expect(arrowIcon).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }
});

test('Ctrl+Enter sends a message', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('/reset');
  await input.press('Control+Enter');
  // Input clears — message was submitted
  await expect(input).toHaveValue('', { timeout: 3_000 });
  await expect(page.locator('#messages')).toContainText(/reset|cleared/i, { timeout: 5_000 });
});

test('Escape clears input when palette is closed and not loading', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('some text here');
  await input.press('Escape');
  await expect(input).toHaveValue('');
});

test('Escape closes command palette (first press only hides palette)', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('/');
  await expect(page.locator('#command-palette')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  await input.press('Escape');
  await expect(page.locator('#command-palette')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  // Input still has the text after first Escape
  await expect(input).not.toHaveValue('');
});

test('Escape closes context inspector modal', async ({ page }) => {
  await page.locator('#sb-ctx-meter').click();
  const inspector = page.locator('#ctx-inspector-overlay');
  await expect(inspector).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

  await page.keyboard.press('Escape');
  await expect(inspector).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('Escape closes settings modal', async ({ page }) => {
  await page.locator('#settings-btn').click();
  const overlay = page.locator('#settings-overlay');
  await expect(overlay).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('Tab completes a palette selection and submits it', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('/res');
  await expect(page.locator('#command-palette')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

  // Tab calls completePaletteSelection(). For /reset (no argHint) it submits immediately.
  await input.press('Tab');

  // Message is submitted — input clears and a system message appears
  await expect(input).toHaveValue('', { timeout: 3_000 });
  await expect(page.locator('#messages')).toContainText(/reset|cleared/i, { timeout: 5_000 });
});
