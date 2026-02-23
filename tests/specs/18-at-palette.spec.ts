/**
 * 18 — @ mention palette
 */

import { test, expect } from '@playwright/test';
import { waitForConnected, expectVisible, expectHidden } from '../helpers/ui.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

test('typing @ shows at-palette', async ({ page }) => {
  const input = page.locator('#input');
  await input.click();
  await input.type('@');
  await expectVisible(page.locator('#at-palette'));
});

test('typing @s filters to @screen', async ({ page }) => {
  const input = page.locator('#input');
  await input.click();
  await input.type('@s');
  const palette = page.locator('#at-palette');
  await expectVisible(palette);
  await expect(palette).toContainText('screen');
});

test('@ palette has "Mention" section header', async ({ page }) => {
  await page.locator('#input').type('@');
  await expect(page.locator('#at-palette')).toContainText('Mention');
});

test('typing unrelated text hides at-palette', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('@');
  await expectVisible(page.locator('#at-palette'));
  // Continue with a query that matches nothing
  await input.type('zzz');
  await expectHidden(page.locator('#at-palette'));
});

test('slash command does not trigger at-palette', async ({ page }) => {
  await page.locator('#input').type('/reset');
  await expectHidden(page.locator('#at-palette'));
});

test('@ mid-sentence (after space) triggers at-palette', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('hello @');
  await expectVisible(page.locator('#at-palette'));
});

test('@ attached to word does not trigger at-palette', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('hello@');
  await expectHidden(page.locator('#at-palette'));
});

test('Escape closes at-palette without clearing input', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('@');
  await expectVisible(page.locator('#at-palette'));
  await input.press('Escape');
  await expectHidden(page.locator('#at-palette'));
  await expect(input).toHaveValue('@');
});

test('ArrowDown moves selection to next item', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('@');
  await expectVisible(page.locator('#at-palette'));
  // First item should already be selected
  await expect(page.locator('#at-palette .selected')).toHaveCount(1);
  await input.press('ArrowDown');
  await expect(page.locator('#at-palette .selected')).toHaveCount(1);
});

test('Tab completes selection and inserts @screen into input', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('@sc');
  await expectVisible(page.locator('#at-palette'));
  // Grant media device permission so getDisplayMedia doesn't throw
  await page.context().grantPermissions(['camera', 'microphone']);
  await input.press('Tab');
  // at-palette should be hidden after completion
  await expectHidden(page.locator('#at-palette'));
  // @screen should be in the input
  await expect(input).toContainText('@screen');
});

test('at-palette hides after message is submitted', async ({ page }) => {
  const input = page.locator('#input');
  await input.type('@');
  await expectVisible(page.locator('#at-palette'));
  // Clear and type a normal message, submit
  await input.fill('hello');
  await input.press('Enter');
  await expectHidden(page.locator('#at-palette'));
});
