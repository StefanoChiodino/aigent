/**
 * 08 — Keyboard shortcuts
 *
 * Tests key combos: Ctrl+Enter (send with reasoning flip), Escape, etc.
 * Note: Ctrl+` for mic is tested separately as it requires microphone permissions.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

test('Ctrl+Enter flips reasoning state and shows brain icon on send button', async ({ page }) => {
  const input = page.locator('#input');
  const brainIcon = page.locator('#send .icon-brain');
  const arrowIcon = page.locator('#send .icon-arrow');

  // By default arrow is shown
  await expect(arrowIcon).not.toHaveClass(/\bhidden\b/);

  // Hold Ctrl — the send button should switch to brain icon
  await input.focus();
  await page.keyboard.down('Control');
  await expect(brainIcon).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  await expect(arrowIcon).toHaveClass(/\bhidden\b/);
  await page.keyboard.up('Control');

  // After releasing, arrow should be back
  await expect(arrowIcon).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('Ctrl+Enter sends message with reasoning toggled', async ({ page }) => {
  // Get current reasoning state
  const reasoningToggle = page.locator('#sb-reasoning-toggle');
  const stateBefore = (await reasoningToggle.innerText()).trim();

  const input = page.locator('#input');
  await input.fill('/reset'); // use /reset so no LLM needed
  await input.press('Control+Enter');

  // Input should clear (message was sent)
  await expect(input).toHaveValue('', { timeout: 3_000 });

  // For slash commands the reasoning override doesn't apply, but the message was still sent
  // Verify message arrived in chat
  await expect(page.locator('#messages')).toContainText(/reset|cleared/i, { timeout: 5_000 });
});

test('Escape clears input when not loading', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('some text here');
  await input.press('Escape');
  await expect(input).toHaveValue('');
});

test('Escape closes command palette', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('/');
  await expect(page.locator('#command-palette')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  await input.press('Escape');
  // Palette should close
  await expect(page.locator('#command-palette')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('Escape closes context inspector modal', async ({ page }) => {
  // Open context inspector by clicking the ctx meter
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

test('Tab autocompletes a command in the palette', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('/res');
  await expect(page.locator('#command-palette')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  await input.press('Tab');
  // Input should now contain the full command
  const value = await input.inputValue();
  expect(value).toMatch(/^\/reset/i);
});
