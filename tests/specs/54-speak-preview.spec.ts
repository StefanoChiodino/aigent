/**
 * 54 — Speak preview icon (chat bubble)
 *
 * Tests:
 *   - Completed message with <speak> tag shows the speak-preview icon on hover
 *   - Completed message without <speak> tag does not show the speak-preview icon
 *   - Streaming message with <speak> tag shows the speak-preview icon (always visible)
 *   - Streaming message without <speak> tag does not show the speak-preview icon
 *   - Speak content is stripped from the displayed message body
 *   - Speak-preview tooltip contains the speak content on hover
 *   - Speak-preview tooltip is fully visible within the viewport
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast Speak preview icon', () => {
  const getPage = useSharedPage();

  test('completed message with <speak> tag shows speak-preview icon', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: '<speak>Here is a summary.</speak>\n\nFull response body here.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // speak-preview exists in the DOM
    const preview = msg.locator('.speak-preview');
    await expect(preview).toHaveCount(1);

    // On hover, icon becomes visible
    await msg.hover();
    await expect(preview).toHaveCSS('opacity', '1');
  });

  test('completed message without <speak> tag has no speak-preview', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'A plain response without speak tags.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    await expect(msg.locator('.speak-preview')).toHaveCount(0);
  });

  test('streaming message with <speak> tag shows speak-preview icon', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: '<speak>Streaming summary.</speak>\n\nMore content.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    // speak-preview should be visible during streaming (no hover needed)
    const preview = streamingMsg.locator('.speak-preview');
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveCSS('opacity', '1');

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('streaming message without <speak> tag has no speak-preview', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'Just plain streaming text.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });
    await expect(streamingMsg.locator('.speak-preview')).toHaveCount(0);

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('<speak> content is stripped from displayed message body', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: '<speak>This is the spoken part.</speak>\n\nThis is the visible body.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    const body = msg.locator('.message-content');
    await expect(body).toBeVisible();

    // The <speak> content should NOT appear in the rendered body
    const html = await body.innerHTML();
    expect(html).not.toContain('This is the spoken part.');
    expect(html).toContain('This is the visible body.');
  });

  test('speak-preview tooltip contains the speak content on hover', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: '<speak>Tooltip summary text.</speak>\n\nBody text.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    // Hover message to reveal icon, then hover icon to show tooltip
    await msg.hover();
    const preview = msg.locator('.speak-preview');
    await expect(preview).toHaveCSS('opacity', '1');
    await preview.hover();

    const tooltip = msg.locator('.speak-preview-tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveText('Tooltip summary text.');
  });

  test('speak-preview tooltip is fully visible within the viewport', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: '<speak>This tooltip must be fully visible.</speak>\n\nMessage body.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();

    // Hover message to reveal icon, then hover icon to show tooltip
    await msg.hover();
    const preview = msg.locator('.speak-preview');
    await preview.hover();

    const tooltip = msg.locator('.speak-preview-tooltip');
    await expect(tooltip).toBeVisible();

    const viewport = page.viewportSize()!;
    const box = await tooltip.boundingBox();
    expect(box).not.toBeNull();

    // Tooltip must be fully within the viewport
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });
});
