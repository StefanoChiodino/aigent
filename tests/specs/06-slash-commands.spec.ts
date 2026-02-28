/**
 * 06 — Slash command palette & commands
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Slash command palette & commands', () => {
  const getPage = useSharedPage();

  test('typing / shows command palette', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.click();
    await input.type('/');
    await expectVisible(page.locator('#command-palette'));
  });

  test('command palette lists known commands', async () => {
    const page = getPage();
    await page.locator('#input').type('/');
    await expectVisible(page.locator('#command-palette'));
    const text = await page.locator('#command-palette').innerText();
    // At minimum /reset should be present
    expect(text.toLowerCase()).toContain('reset');
  });

  test('typing /mod filters to model-related commands', async () => {
    const page = getPage();
    await page.locator('#input').type('/mod');
    const palette = page.locator('#command-palette');
    await expectVisible(palette);
    await expect(palette).toContainText(/model/i);
  });

  test('typing /rea filters to reasoning commands', async () => {
    const page = getPage();
    await page.locator('#input').type('/rea');
    const palette = page.locator('#command-palette');
    await expectVisible(palette);
    await expect(palette).toContainText(/reasoning/i);
  });

  test('Escape hides palette (first press) then clears input (second press)', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('/model');
    await expectVisible(page.locator('#command-palette'));
    // First Escape: hides palette but leaves text
    await input.press('Escape');
    await expect(page.locator('#command-palette')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    // Input still has the text
    await expect(input).not.toHaveValue('');
    // Second Escape: clears input
    await input.press('Escape');
    await expect(input).toHaveValue('');
  });

  test('ArrowDown highlights a palette item with .selected class', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('/');
    await expectVisible(page.locator('#command-palette'));
    await input.press('ArrowDown');
    // The app uses .selected (not .active) for the highlighted palette item
    await expect(page.locator('#command-palette .selected')).toHaveCount(1, { timeout: 2_000 });
  });

  test('/reset runs when sent via Enter', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('/reset');
    await input.press('Enter');
    await expect(page.locator('#messages')).toContainText(/reset|cleared|start/i, { timeout: 5_000 });
  });

  test('/short on runs and activates the "short" speak pill', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('/short on');
    await input.press('Enter');
    // The "short" pill in the sidebar should become active
    await expect(page.locator('#sb-speak-pills .sb-pill[data-speak="short"]')).toHaveClass(/active/, { timeout: 5_000 });
    // Restore
    await input.fill('/short off');
    await input.press('Enter');
  });

  test('/reasoning off disables the toggle', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('/reasoning off');
    await input.press('Enter');
    await expect(page.locator('#sb-reasoning-toggle')).toHaveText('OFF', { timeout: 5_000 });
    // Restore
    await input.fill('/reasoning on');
    await input.press('Enter');
  });

  test('/effort high sets effort to high', async () => {
    const page = getPage();
    // Ensure reasoning is on
    await page.locator('#input').fill('/reasoning on');
    await page.locator('#input').press('Enter');

    await page.locator('#input').fill('/effort high');
    await page.locator('#input').press('Enter');
    await expect(page.locator('#sb-effort-pills .sb-pill[data-level="high"]')).toHaveClass(/active/, { timeout: 5_000 });

    // Restore
    await page.locator('#input').fill('/effort medium');
    await page.locator('#input').press('Enter');
  });
});
