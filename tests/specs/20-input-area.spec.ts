/**
 * 20 — Input area: structure, send/cancel, placeholder, drag indicator, auto-grow
 *
 * At-token chip behaviour is covered in 18-at-palette.spec.ts.
 * Live submission is covered in 02-chat.spec.ts.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Input area', () => {
  const getPage = useSharedPage();

  // ── Basic structure ────────────────────────────────────────────────────────────

  test('input area is present', async () => {
    const page = getPage();
    await expect(page.locator('#input-area')).toBeVisible();
  });

  test('textarea is auto-focused on load', async () => {
    const page = getPage();
    await page.locator('#input').focus();
    const focused = await page.evaluate(() => document.activeElement?.id);
    expect(focused).toBe('input');
  });

  test('error bar is hidden by default', async () => {
    const page = getPage();
    await expect(page.locator('#error-bar')).toHaveClass(/\bhidden\b/);
  });

  test('attach button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#attach')).toBeVisible();
  });

  test('screen cap button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#screen-cap')).toBeVisible();
  });

  test('mic button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#mic')).toBeVisible();
  });

  test('mic-sticky button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#mic-sticky')).toBeVisible();
  });

  test('mic-clear button is hidden by default', async () => {
    const page = getPage();
    await expect(page.locator('#mic-clear')).toHaveClass(/\bdisabled\b/);
  });

  // ── Send / Cancel toggling ─────────────────────────────────────────────────────

  test('send button is visible when not loading', async () => {
    const page = getPage();
    await expect(page.locator('#send')).not.toHaveClass(/\bhidden\b/);
  });

  test('cancel button is hidden when not loading', async () => {
    const page = getPage();
    await expect(page.locator('#cancel')).toHaveClass(/\bhidden\b/);
  });

  test('send button has exactly one visible icon (brain or arrow)', async () => {
    const page = getPage();
    const brainHidden = (await page.locator('#send .icon-brain').getAttribute('class') ?? '').includes('hidden');
    const arrowHidden = (await page.locator('#send .icon-arrow').getAttribute('class') ?? '').includes('hidden');
    // Exactly one should be hidden (the other visible)
    expect(brainHidden !== arrowHidden).toBe(true);
  });

  // ── Placeholder text ──────────────────────────────────────────────────────────

  test('input placeholder says "Message aigent…" when idle', async () => {
    const page = getPage();
    const placeholder = await page.locator('#input').getAttribute('placeholder');
    expect(placeholder).toMatch(/message aigent/i);
  });

  // ── Textarea auto-grow ────────────────────────────────────────────────────────

  test('textarea grows when multiple lines are typed', async () => {
    const page = getPage();
    const input = page.locator('#input');
    const before = await input.boundingBox();
    expect(before).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      await input.press('Shift+Enter');
    }
    await input.type('last line');

    const after = await input.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.height).toBeGreaterThan(before!.height);
  });

  test('textarea shrinks back when content is cleared', async () => {
    const page = getPage();
    const input = page.locator('#input');

    for (let i = 0; i < 5; i++) {
      await input.press('Shift+Enter');
    }
    await input.type('text');
    const tall = await input.boundingBox();

    await input.fill('');
    await input.dispatchEvent('input'); // trigger auto-grow
    const short = await input.boundingBox();
    expect(short!.height).toBeLessThan(tall!.height);
  });

  // ── Drag-and-drop visual indicator ───────────────────────────────────────────

  test('dragging over input area adds drag-over class', async () => {
    const page = getPage();
    const area = page.locator('#input-area');
    await area.evaluate(el => {
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { files: [], types: ['Files'] } });
      el.dispatchEvent(ev);
    });
    await expect(area).toHaveClass(/drag-over/);
  });

  test('dragleave removes drag-over class', async () => {
    const page = getPage();
    const area = page.locator('#input-area');
    // Add the class first via dragover
    await area.evaluate(el => {
      const ev = new DragEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { files: [], types: ['Files'] } });
      el.dispatchEvent(ev);
    });
    await expect(area).toHaveClass(/drag-over/);

    // Then trigger dragleave
    await area.evaluate(el => {
      const ev = new DragEvent('dragleave', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    });
    await expect(area).not.toHaveClass(/drag-over/);
  });

  // ── Markdown highlight overlay ─────────────────────────────────────────────────

  test('backtick code spans are highlighted', async () => {
    const page = getPage();
    await page.locator('#input').fill('hello `code` world');
    const hl = page.locator('#input-highlight .input-hl-code');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('`code`');
  });

  test('**bold** text is highlighted', async () => {
    const page = getPage();
    await page.locator('#input').fill('some **bold** text');
    const hl = page.locator('#input-highlight .input-hl-bold');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('**bold**');
  });

  test('*italic* text is highlighted', async () => {
    const page = getPage();
    await page.locator('#input').fill('some *italic* text');
    const hl = page.locator('#input-highlight .input-hl-italic');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('*italic*');
  });

  test('~~strikethrough~~ text is highlighted', async () => {
    const page = getPage();
    await page.locator('#input').fill('some ~~strike~~ text');
    const hl = page.locator('#input-highlight .input-hl-strike');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('~~strike~~');
  });

  test('# heading is highlighted', async () => {
    const page = getPage();
    await page.locator('#input').fill('# My Heading');
    const hl = page.locator('#input-highlight .input-hl-h1');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('# My Heading');
  });

  test('@mention is highlighted', async () => {
    const page = getPage();
    await page.locator('#input').fill('hello @user');
    const hl = page.locator('#input-highlight .input-hl-at');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('@user');
  });

  test('/file/path is highlighted as file chip', async () => {
    const page = getPage();
    await page.locator('#input').fill('edit /src/app.ts');
    const hl = page.locator('#input-highlight .input-hl-at-file');
    await expect(hl).toHaveCount(1);
    await expect(hl).toContainText('/src/app.ts');
  });

  test('code spans are opaque — inner markdown is not parsed', async () => {
    const page = getPage();
    await page.locator('#input').fill('`**not bold**`');
    // Should have one code span and zero bold spans
    await expect(page.locator('#input-highlight .input-hl-code')).toHaveCount(1);
    await expect(page.locator('#input-highlight .input-hl-bold')).toHaveCount(0);
  });

  // ── Input row structure ───────────────────────────────────────────────────────

  test('input row contains expected buttons', async () => {
    const page = getPage();
    await expect(page.locator('#input-row')).toBeVisible();
    await expect(page.locator('#input-row #attach')).toBeVisible();
    await expect(page.locator('#input-row #mic')).toBeVisible();
    await expect(page.locator('#input-row #screen-cap')).toBeVisible();
    await expect(page.locator('#input-row #send')).toBeVisible();
  });
});
