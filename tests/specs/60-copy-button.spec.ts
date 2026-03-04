/**
 * 60 — Copy markdown button
 *
 * Tests:
 *   - Copy button appears on assistant messages on hover
 *   - Copy button does NOT appear on user messages
 *   - Clicking copy writes message content to clipboard
 *   - Copy button shows "Copied!" title after clicking
 *   - [speak] tags are stripped from copied content
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast Copy markdown button', () => {
  const getPage = useSharedPage();

  test('copy button appears on assistant message hover', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'Hello world.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    const copyBtn = msg.locator('.copy-btn');
    await expect(copyBtn).toHaveCount(1);

    // Hidden by default (opacity 0)
    await expect(copyBtn).toHaveCSS('opacity', '0');

    // Visible on hover
    await msg.hover();
    await expect(copyBtn).toHaveCSS('opacity', '1');
  });

  test('copy button does NOT appear on user messages', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'user',
        content: 'User message.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.user').last();
    await expect(msg).toBeVisible();
    await expect(msg.locator('.copy-btn')).toHaveCount(0);
  });

  test('clicking copy writes content to clipboard and shows copied state', async () => {
    const page = getPage();

    // Grant clipboard permissions
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    const content = 'This is **markdown** content to copy.';
    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content,
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();

    const copyBtn = msg.locator('.copy-btn');
    await expect(copyBtn).toHaveCSS('opacity', '1');

    // Click copy
    await copyBtn.click();

    // Title changes to "Copied!"
    await expect(copyBtn).toHaveAttribute('title', 'Copied!');

    // Clipboard contains the markdown content
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(content);
  });

  test('copied content strips [speak] tags', async () => {
    const page = getPage();

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: '[speak]Spoken part.[/speak]\n\nVisible body.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();

    await msg.locator('.copy-btn').click();

    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).not.toContain('[speak]');
    expect(clipboardText).not.toContain('Spoken part.');
    expect(clipboardText).toContain('Visible body.');
  });

  test('copy button title reverts after delay', async () => {
    const page = getPage();

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'Revert test.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await msg.hover();

    const copyBtn = msg.locator('.copy-btn');
    await copyBtn.click();
    await expect(copyBtn).toHaveAttribute('title', 'Copied!');

    // After 1500ms the title reverts
    await expect(copyBtn).toHaveAttribute('title', 'Copy markdown', { timeout: 3000 });
  });
});
