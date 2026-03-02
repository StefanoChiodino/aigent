/**
 * 62 — Auto-list continuation
 *
 * When Enter is pressed inside a list item (not sending), the next line should
 * automatically get the appropriate list prefix. Pressing Enter on an empty
 * list item exits the list by removing the prefix.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Auto-list continuation', () => {
  const getPage = useSharedPage();

  test('unordered list: Enter continues with same marker', async () => {
    const page = getPage();
    const input = page.locator('#input');

    // Type "- first item" then press Shift+Enter (newline in normal mode)
    await input.focus();
    await input.fill('- first item');
    await input.press('Shift+Enter');

    // Next line should start with "- "
    const val = await input.inputValue();
    expect(val).toBe('- first item\n- ');
  });

  test('unordered list: asterisk marker is preserved', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.focus();
    await input.fill('* first item');
    await input.press('Shift+Enter');

    const val = await input.inputValue();
    expect(val).toBe('* first item\n* ');
  });

  test('ordered list: Enter increments the number', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.focus();
    await input.fill('1. first item');
    await input.press('Shift+Enter');

    const val = await input.inputValue();
    expect(val).toBe('1. first item\n2. ');
  });

  test('ordered list: increments correctly from mid-sequence', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.focus();
    await input.fill('1. a\n2. b\n3. third');
    // Move caret to end
    await page.keyboard.press('End');
    await input.press('Shift+Enter');

    const val = await input.inputValue();
    expect(val).toBe('1. a\n2. b\n3. third\n4. ');
  });

  test('empty list item: Enter exits the list (removes prefix)', async () => {
    const page = getPage();
    const input = page.locator('#input');

    // "- item\n- " — cursor is after the empty "- " on the second line
    await input.focus();
    await input.fill('- item\n- ');
    await page.keyboard.press('End');
    await input.press('Shift+Enter');

    const val = await input.inputValue();
    // Should strip the empty "- " prefix, leaving just "- item\n"
    expect(val).toBe('- item\n');
  });

  test('indented list: preserves indentation', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.focus();
    await input.fill('  - indented item');
    await input.press('Shift+Enter');

    const val = await input.inputValue();
    expect(val).toBe('  - indented item\n  - ');
  });

  test('plain Enter on non-list line does not add prefix', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.focus();
    await input.fill('just a normal line');
    await input.press('Shift+Enter');

    const val = await input.inputValue();
    expect(val).toBe('just a normal line\n');
  });

  test('Enter still sends message on non-list text', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.fill('/reset');
    await input.press('Enter'); // should send, not add list prefix

    await expect(input).toHaveValue('', { timeout: 3_000 });
    await expect(page.locator('#messages')).toContainText(/reset|cleared/i, { timeout: 5_000 });
  });
});
