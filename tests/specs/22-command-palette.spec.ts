/**
 * 22 — Command palette: mouse interactions, Tab completion, argHint handling
 *
 * Complements 06-slash-commands and 08-keyboard which cover basic palette
 * behaviour. This file focuses on mouse hover, clicking items, and the
 * argHint vs immediate-submit distinction.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('Command palette interactions', () => {
  const getPage = useSharedPage();

  // ── Mouse interactions ─────────────────────────────────────────────────────────

  test('hovering a palette item selects it', async () => {
    const page = getPage();
    await page.locator('#input').type('/');
    await expectVisible(page.locator('#command-palette'));

    const items = page.locator('#command-palette .palette-item');
    const count = await items.count();
    expect(count).toBeGreaterThan(1);

    // Hover the second item
    await items.nth(1).hover();
    await expect(items.nth(1)).toHaveClass(/selected/, { timeout: 2_000 });
  });

  test('clicking a palette item with no argHint submits immediately', async () => {
    const page = getPage();
    // /reset has no argHint — clicking it should auto-submit and clear input
    const input = page.locator('#input');
    await input.type('/res');
    await expectVisible(page.locator('#command-palette'));

    const resetItem = page.locator('#command-palette .palette-item', { hasText: '/reset' });
    await resetItem.click();

    await expect(input).toHaveValue('', { timeout: 3_000 });
    await expect(page.locator('#messages')).toContainText(/reset|cleared/i, { timeout: 5_000 });
  });

  test('clicking a palette item with argHint fills input but does not submit', async () => {
    const page = getPage();
    // /model <model-id> has argHint — clicking should fill the input, not submit
    const input = page.locator('#input');
    await input.type('/mod');
    await expectVisible(page.locator('#command-palette'));

    const modelItem = page.locator('#command-palette .palette-item', { hasText: /\/model/ }).first();
    await modelItem.click();

    // Input should be filled with "/model " (with trailing space for arg) but not empty
    const val = await input.inputValue();
    expect(val).toMatch(/^\/model\s/);
    // Palette should be gone (complete match hides it)
    await expectHidden(page.locator('#command-palette'));
  });

  // ── Filtering ──────────────────────────────────────────────────────────────────

  test('palette shows only matching commands for prefix', async () => {
    const page = getPage();
    await page.locator('#input').type('/eff');
    const palette = page.locator('#command-palette');
    await expectVisible(palette);
    const text = await palette.innerText();
    expect(text.toLowerCase()).toContain('effort');
    // Should not show unrelated commands like /reset
    expect(text.toLowerCase()).not.toContain('reset');
  });

  test('palette hides when prefix matches an exact command with no remaining ambiguity', async () => {
    const page = getPage();
    // After a complete command + space, palette should hide (no longer filtering)
    const input = page.locator('#input');
    await input.type('/reset ');
    // "/reset " has a space after it — prefix logic sees a full match and hides
    await expectHidden(page.locator('#command-palette'));
  });

  // ── argHint display ────────────────────────────────────────────────────────────

  test('commands with argHint show the hint text in the palette', async () => {
    const page = getPage();
    await page.locator('#input').type('/mod');
    await expectVisible(page.locator('#command-palette'));
    // /model should show its argHint like "<model-id>"
    await expect(page.locator('#command-palette')).toContainText(/<|model/i);
  });

  test('commands without argHint do not show angle-bracket hints', async () => {
    const page = getPage();
    await page.locator('#input').type('/res');
    await expectVisible(page.locator('#command-palette'));
    // /reset has no argHint
    const resetItem = page.locator('#command-palette .palette-item', { hasText: '/reset' });
    const text = await resetItem.innerText();
    expect(text).not.toContain('<');
  });

  // ── ArrowDown / ArrowUp cycling ──────────────────────────────────────────────

  test('ArrowUp on first item stays at index 0', async () => {
    const page = getPage();
    // Move mouse away so it doesn't trigger mouseEnter on palette items
    await page.mouse.move(0, 0);
    const input = page.locator('#input');
    await input.type('/');
    await expectVisible(page.locator('#command-palette'));

    // First item should already be index 0
    await input.press('ArrowUp');
    // Selected should still be the first item
    const selected = page.locator('#command-palette .selected');
    await expect(selected).toHaveCount(1);
    // Check it's the first item
    const items = page.locator('#command-palette .palette-item');
    const firstText = await items.first().innerText();
    const selectedText = await selected.innerText();
    expect(selectedText.trim()).toBe(firstText.trim());
  });

  test('ArrowDown then ArrowUp returns to first item', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('/');
    await expectVisible(page.locator('#command-palette'));

    await input.press('ArrowDown');
    await input.press('ArrowUp');

    const selected = page.locator('#command-palette .selected');
    const items = page.locator('#command-palette .palette-item');
    const firstText = await items.first().innerText();
    const selectedText = await selected.innerText();
    expect(selectedText.trim()).toBe(firstText.trim());
  });

  // ── cmd-name and cmd-desc ─────────────────────────────────────────────────────

  test('palette items have a command name and description', async () => {
    const page = getPage();
    await page.locator('#input').type('/');
    await expectVisible(page.locator('#command-palette'));

    const firstItem = page.locator('#command-palette .palette-item').first();
    await expect(firstItem.locator('.cmd-name')).toBeVisible();
    await expect(firstItem.locator('.cmd-desc')).not.toBeEmpty();
  });
});
