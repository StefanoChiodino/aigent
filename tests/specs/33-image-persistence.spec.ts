/**
 * 33 — Image persistence: thumbnails display in chat messages and survive reload
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

const TINY_THUMB = `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAASABIAAD/2wBDAP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP//AP/`;

function injectUserMessageWithAttachments(
  page: import('@playwright/test').Page,
  opts: {
    content: string;
    attachments: { name: string; mediaType: string; thumbnail?: string }[];
  },
) {
  return page.evaluate(({ content, attachments }) => {
    const store = (window as any).__zustand_chat;
    if (!store) throw new Error('Chat store not exposed');
    store.getState().appendMessage({
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      attachments,
    });
  }, opts);
}

function injectPlainMessage(
  page: import('@playwright/test').Page,
  content: string,
) {
  return page.evaluate((content) => {
    const store = (window as any).__zustand_chat;
    if (!store) throw new Error('Chat store not exposed');
    store.getState().appendMessage({
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
    });
  }, content);
}

test.describe('@fast Image persistence in chat messages', () => {
  const getPage = useSharedPage();

  test('message with image attachment renders thumbnail', async () => {
    const page = getPage();
    await injectUserMessageWithAttachments(page, {
      content: '[1 image] Check this out',
      attachments: [{ name: 'photo.png', mediaType: 'image/png', thumbnail: TINY_THUMB }],
    });

    const lastMsg = page.locator('.message.user').last();
    const thumb = lastMsg.locator('.message-image-thumb');
    await expect(thumb).toBeVisible();
    await expect(thumb).toHaveAttribute('alt', 'photo.png');
  });

  test('message with PDF attachment renders file badge', async () => {
    const page = getPage();
    await injectUserMessageWithAttachments(page, {
      content: '[1 PDF] Review this document',
      attachments: [{ name: 'report.pdf', mediaType: 'application/pdf' }],
    });

    // Look for a file badge containing 'report.pdf' anywhere in the messages
    const badge = page.locator('.message-file-badge', { hasText: 'report.pdf' });
    await expect(badge).toBeVisible();
  });

  test('message with multiple image attachments renders all thumbnails', async () => {
    const page = getPage();
    await injectUserMessageWithAttachments(page, {
      content: '[3 images] Compare these',
      attachments: [
        { name: 'a.png', mediaType: 'image/png', thumbnail: TINY_THUMB },
        { name: 'b.jpg', mediaType: 'image/jpeg', thumbnail: TINY_THUMB },
        { name: 'c.webp', mediaType: 'image/webp', thumbnail: TINY_THUMB },
      ],
    });

    const lastMsg = page.locator('.message.user').last();
    await expect(lastMsg.locator('.message-image-thumb')).toHaveCount(3);
    await expect(lastMsg.locator('.message-images')).toBeVisible();
  });

  test('message with mixed attachments renders images and file badges', async () => {
    const page = getPage();
    await injectUserMessageWithAttachments(page, {
      content: '[1 image, 1 PDF] Here are both',
      attachments: [
        { name: 'screenshot.png', mediaType: 'image/png', thumbnail: TINY_THUMB },
        { name: 'data.pdf', mediaType: 'application/pdf' },
      ],
    });

    const lastMsg = page.locator('.message.user').last();
    await expect(lastMsg.locator('.message-image-thumb')).toHaveCount(1);
    await expect(lastMsg.locator('.message-file-badge')).toHaveCount(1);
  });

  test('message without attachments renders normally', async () => {
    const page = getPage();
    await injectPlainMessage(page, 'Hello, no images here');

    const lastMsg = page.locator('.message.user').last();
    await expect(lastMsg.locator('.message-content')).toContainText('Hello, no images here');
    await expect(lastMsg.locator('.message-images')).not.toBeVisible();
    await expect(lastMsg.locator('.message-attachments')).not.toBeVisible();
  });

  test('image attachment without thumbnail does not render broken img', async () => {
    const page = getPage();
    await injectUserMessageWithAttachments(page, {
      content: '[1 image] No thumbnail available',
      attachments: [{ name: 'no-thumb.png', mediaType: 'image/png' }],
    });

    const lastMsg = page.locator('.message.user').last();
    await expect(lastMsg.locator('.message-image-thumb')).toHaveCount(0);
  });

  test('attachments with thumbnails persist in localStorage', async () => {
    const page = getPage();
    await injectUserMessageWithAttachments(page, {
      content: '[1 image] Persistent image',
      attachments: [{ name: 'persist.png', mediaType: 'image/png', thumbnail: TINY_THUMB }],
    });

    const lastMsg = page.locator('.message.user').last();
    await expect(lastMsg.locator('.message-image-thumb')).toBeVisible();

    // Verify localStorage contains attachments with thumbnails
    const hasThumbnails = await page.evaluate(() => {
      const raw = localStorage.getItem('aigent-chat');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const msgs = parsed?.state?.messages ?? [];
      return msgs.some((m: any) =>
        m.attachments?.some((a: any) => a.thumbnail && a.name === 'persist.png')
      );
    });

    expect(hasThumbnails).toBe(true);
  });
});
