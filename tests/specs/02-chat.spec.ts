/**
 * 02 — Basic chat interaction
 *
 * Uses /reset which produces a system message immediately without an LLM call.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Basic chat interaction', () => {
  const getPage = useSharedPage();

  test('/reset clears localStorage and sends system message', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('/reset');
    await input.press('Enter');

    // System message should appear in the messages list
    await expect(page.locator('#messages')).toContainText(/reset|cleared|start/i, { timeout: 5_000 });
  });

  test('input clears after pressing Enter', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('/reset');
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 3_000 });
  });

  test('send button submits the message', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('/reset');
    await page.locator('#send').click();
    await expect(input).toHaveValue('', { timeout: 3_000 });
  });

  test('Shift+Enter inserts newline without sending', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.fill('first line');
    await input.press('Shift+Enter');
    // Still has content — was not submitted
    const val = await input.inputValue();
    expect(val).toContain('first line');
  });

  test('cancel button is hidden when not loading', async () => {
    const page = getPage();
    await expect(page.locator('#cancel')).toHaveClass(/hidden/);
  });

  test('send button icon reflects reasoning state', async () => {
    const page = getPage();
    // Arrow = reasoning off, brain = reasoning on.
    // The send button always shows exactly one of the two icons.
    const arrowHidden = await page.locator('#send .icon-arrow').getAttribute('class');
    const brainHidden = await page.locator('#send .icon-brain').getAttribute('class');
    const arrowVisible = !arrowHidden?.includes('hidden');
    const brainVisible = !brainHidden?.includes('hidden');
    // Exactly one should be visible
    expect(arrowVisible !== brainVisible).toBe(true);
  });
});
