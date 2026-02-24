/**
 * 30 — Attachment preview: add/remove attachments, remove button always visible
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

/** Inject a fake attachment into the Zustand UI store. */
function injectAttachment(opts: {
  id: string;
  name: string;
  mediaType: string;
  isImage?: boolean;
}) {
  return (page: import('@playwright/test').Page) =>
    page.evaluate(({ id, name, mediaType, isImage }) => {
      const store = (window as any).__zustand_ui;
      if (!store) throw new Error('UI store not exposed');
      // 1x1 red PNG as base64
      const fakeB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      store.getState().addAttachment({
        id,
        name,
        mediaType,
        data: fakeB64,
        dataUrl: isImage ? `data:${mediaType};base64,${fakeB64}` : undefined,
        size: 1234,
      });
    }, opts);
}

test.describe('Attachment preview', () => {
  const getPage = useSharedPage();

  test('attachment preview is hidden when no attachments', async () => {
    const page = getPage();
    await expect(page.locator('#attachment-preview')).not.toBeVisible();
  });

  test('adding an image attachment shows a thumbnail with remove button', async () => {
    const page = getPage();
    await injectAttachment({ id: 'img1', name: 'photo.png', mediaType: 'image/png', isImage: true })(page);

    const thumb = page.locator('.attachment-thumb.image-thumb');
    await expect(thumb).toBeVisible();
    await expect(thumb.locator('img')).toBeVisible();

    const removeBtn = thumb.locator('.attachment-remove');
    await expect(removeBtn).toBeVisible();
  });

  test('adding a file attachment shows a file badge with remove button', async () => {
    const page = getPage();
    await injectAttachment({ id: 'file1', name: 'readme.txt', mediaType: 'text/plain' })(page);

    const badge = page.locator('.attachment-thumb.file-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.file-name')).toHaveText('readme.txt');

    const removeBtn = badge.locator('.attachment-remove');
    await expect(removeBtn).toBeVisible();
  });

  test('remove button is visible without hovering', async () => {
    const page = getPage();
    await injectAttachment({ id: 'img2', name: 'shot.png', mediaType: 'image/png', isImage: true })(page);

    const removeBtn = page.locator('.attachment-thumb .attachment-remove');
    // Check computed opacity is 1 (not hidden behind hover-only)
    const opacity = await removeBtn.evaluate(el => getComputedStyle(el).opacity);
    expect(opacity).toBe('1');
  });

  test('clicking remove button removes the attachment', async () => {
    const page = getPage();
    await injectAttachment({ id: 'del1', name: 'delete-me.png', mediaType: 'image/png', isImage: true })(page);

    await expect(page.locator('.attachment-thumb')).toHaveCount(1);
    await page.locator('.attachment-remove').click();
    await expect(page.locator('.attachment-thumb')).toHaveCount(0);
    // Preview container itself should vanish
    await expect(page.locator('#attachment-preview')).not.toBeVisible();
  });

  test('multiple attachments each have their own remove button', async () => {
    const page = getPage();
    await injectAttachment({ id: 'multi1', name: 'a.png', mediaType: 'image/png', isImage: true })(page);
    await injectAttachment({ id: 'multi2', name: 'b.txt', mediaType: 'text/plain' })(page);
    await injectAttachment({ id: 'multi3', name: 'c.jpg', mediaType: 'image/jpeg', isImage: true })(page);

    await expect(page.locator('.attachment-thumb')).toHaveCount(3);
    await expect(page.locator('.attachment-remove')).toHaveCount(3);

    // Remove the middle one (file badge)
    await page.locator('.attachment-thumb.file-badge .attachment-remove').click();
    await expect(page.locator('.attachment-thumb')).toHaveCount(2);
    // File badge should be gone
    await expect(page.locator('.attachment-thumb.file-badge')).toHaveCount(0);
  });
});
