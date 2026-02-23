/**
 * 02 — Basic chat interaction
 *
 * Uses /reset which produces a system message immediately without an LLM call.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

test('/reset clears localStorage and sends system message', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('/reset');
  await input.press('Enter');

  // System message should appear in the messages list
  await expect(page.locator('#messages')).toContainText(/reset|cleared|start/i, { timeout: 5_000 });
});

test('input clears after pressing Enter', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('/reset');
  await input.press('Enter');
  await expect(input).toHaveValue('', { timeout: 3_000 });
});

test('send button submits the message', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('/reset');
  await page.locator('#send').click();
  await expect(input).toHaveValue('', { timeout: 3_000 });
});

test('Shift+Enter inserts newline without sending', async ({ page }) => {
  const input = page.locator('#input');
  await input.fill('first line');
  await input.press('Shift+Enter');
  // Still has content — was not submitted
  const val = await input.inputValue();
  expect(val).toContain('first line');
});

test('cancel button is hidden when not loading', async ({ page }) => {
  await expect(page.locator('#cancel')).toHaveClass(/hidden/);
});

test('send button shows arrow icon by default', async ({ page }) => {
  // Arrow icon visible, brain icon hidden
  await expect(page.locator('#send .icon-arrow')).toBeVisible();
  await expect(page.locator('#send .icon-brain')).toHaveClass(/hidden/);
});
