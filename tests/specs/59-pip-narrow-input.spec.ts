/**
 * 59 — Input area at PiP-narrow viewport
 *
 * Measures the actual minimum width the input row needs (all buttons + textarea
 * at its CSS min-width), then verifies PIP_WIDTH and the body's CSS min-width
 * are both >= that value. If someone adds a new button or changes sizing, this
 * test breaks — no magic numbers to keep in sync manually.
 *
 * Also verifies textarea ↔ highlight overlay alignment at PiP width so the
 * caret stays where the user expects it.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { useSharedPage } from '../helpers/shared-page.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read PIP_WIDTH from source so this test stays in sync automatically. */
const pipSrc = readFileSync(resolve(__dirname, '../../web/src/hooks/usePiP.ts'), 'utf8');
const widthMatch = pipSrc.match(/PIP_WIDTH\s*=\s*(\d+)/);
const heightMatch = pipSrc.match(/PIP_HEIGHT\s*=\s*(\d+)/);
const PIP_WIDTH = widthMatch ? Number(widthMatch[1]) : 480;
const PIP_HEIGHT = heightMatch ? Number(heightMatch[1]) : 720;

test.describe('Input area at PiP-narrow viewport', () => {
  const getPage = useSharedPage();

  test('PIP_WIDTH and body min-width accommodate all input-row controls', async () => {
    const page = getPage();

    // Render at a wide viewport so nothing is constrained — we want natural sizes
    await page.setViewportSize({ width: 1280, height: 720 });

    // Measure what the input row actually needs: sum of all non-flexible children
    // (buttons, gaps) plus the textarea's CSS min-width.
    const measured = await page.evaluate(() => {
      const row = document.getElementById('input-row');
      if (!row) return null;

      const style = getComputedStyle(row);
      const gap = parseFloat(style.gap) || 0;

      let buttonsWidth = 0;
      let childCount = 0;
      for (const child of row.children) {
        const el = child as HTMLElement;
        if (el.id === 'file-input') continue;          // hidden file input
        if (el.id === 'input-wrap') continue;           // flexible — measured separately
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) continue;                 // hidden elements
        buttonsWidth += rect.width;
        childCount++;
      }

      // Textarea needs some usable width — use its CSS min-width or a sane floor
      const textarea = document.getElementById('input');
      const taMinWidth = textarea ? parseFloat(getComputedStyle(textarea).minWidth) || 0 : 0;
      // input-wrap border
      const wrap = document.getElementById('input-wrap');
      const wrapBorder = wrap ? parseFloat(getComputedStyle(wrap).borderLeftWidth) + parseFloat(getComputedStyle(wrap).borderRightWidth) : 0;
      // Use at least 80px for the textarea so it's actually usable
      const textareaMinUsable = Math.max(taMinWidth, 80) + wrapBorder;

      const totalGaps = gap * childCount; // gaps between all visible children (including input-wrap)

      const bodyMinWidth = parseFloat(getComputedStyle(document.body).minWidth) || 0;

      return {
        requiredWidth: Math.ceil(buttonsWidth + textareaMinUsable + totalGaps),
        bodyMinWidth,
      };
    });

    expect(measured).not.toBeNull();
    const { requiredWidth, bodyMinWidth } = measured!;

    // PIP_WIDTH must be wide enough for all controls
    expect(PIP_WIDTH).toBeGreaterThanOrEqual(requiredWidth);
    // body min-width must also be wide enough (it gates layout in the PiP iframe)
    expect(bodyMinWidth).toBeGreaterThanOrEqual(requiredWidth);
    // PIP_WIDTH must be >= body min-width (otherwise the iframe overflows)
    expect(PIP_WIDTH).toBeGreaterThanOrEqual(bodyMinWidth);
  });

  test('all input-row buttons visible at PiP width', async () => {
    const page = getPage();
    await page.setViewportSize({ width: PIP_WIDTH, height: PIP_HEIGHT });

    await expect(page.locator('#send')).toBeVisible();
    await expect(page.locator('#mic')).toBeVisible();
    await expect(page.locator('#attach')).toBeVisible();
    await expect(page.locator('#screen-cap')).toBeVisible();

    // None of the buttons should be clipped outside the viewport
    const allInView = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      for (const id of ['send', 'mic', 'attach', 'screen-cap']) {
        const el = document.getElementById(id);
        if (!el) return `#${id} not found`;
        const rect = el.getBoundingClientRect();
        if (rect.right > vw + 1) return `#${id} overflows viewport (right=${rect.right}, vw=${vw})`;
      }
      return true;
    });
    expect(allInView).toBe(true);
  });

  test('textarea and highlight overlay have matching width at PiP width', async () => {
    const page = getPage();
    await page.setViewportSize({ width: PIP_WIDTH, height: PIP_HEIGHT });

    const input = page.locator('#input');
    await input.fill('The quick brown fox jumps over the lazy dog near the river');

    const dims = await page.evaluate(() => {
      const textarea = document.getElementById('input');
      const highlight = document.getElementById('input-highlight');
      if (!textarea || !highlight) return null;
      const tRect = textarea.getBoundingClientRect();
      const hRect = highlight.getBoundingClientRect();
      return {
        textareaWidth: tRect.width,
        highlightWidth: hRect.width,
        textareaLeft: tRect.left,
        highlightLeft: hRect.left,
      };
    });

    expect(dims).not.toBeNull();
    // Widths must match within 1px (sub-pixel rounding tolerance)
    expect(dims!.textareaWidth).toBeCloseTo(dims!.highlightWidth, 0);
    // Left edges must align
    expect(dims!.textareaLeft).toBeCloseTo(dims!.highlightLeft, 0);
  });

  test('textarea does not overflow input-wrap at PiP width', async () => {
    const page = getPage();
    await page.setViewportSize({ width: PIP_WIDTH, height: PIP_HEIGHT });

    const input = page.locator('#input');
    await input.fill('Testing overflow at narrow viewport width');

    const overflow = await page.evaluate(() => {
      const wrap = document.getElementById('input-wrap');
      const textarea = document.getElementById('input');
      if (!wrap || !textarea) return null;
      const wrapRect = wrap.getBoundingClientRect();
      const taRect = textarea.getBoundingClientRect();
      return {
        overflows: taRect.right > wrapRect.right + 1,
      };
    });

    expect(overflow).not.toBeNull();
    expect(overflow!.overflows).toBe(false);
  });

  test('textarea wraps text at same point as highlight overlay', async () => {
    const page = getPage();
    await page.setViewportSize({ width: PIP_WIDTH, height: PIP_HEIGHT });

    const input = page.locator('#input');
    await input.fill('This message is long enough that it should wrap to multiple lines in the narrow PiP viewport');

    // Compare rendered heights — if wrapping matches, heights match
    const heights = await page.evaluate(() => {
      const textarea = document.getElementById('input') as HTMLTextAreaElement | null;
      const highlight = document.getElementById('input-highlight');
      if (!textarea || !highlight) return null;
      return {
        textareaScrollHeight: textarea.scrollHeight,
        highlightScrollHeight: highlight.scrollHeight,
      };
    });

    expect(heights).not.toBeNull();
    // The overlay adds a trailing \n which may add up to one line-height of
    // extra space, so allow that tolerance.
    const lineHeight = 21; // 14px font * 1.5 line-height
    expect(Math.abs(heights!.textareaScrollHeight - heights!.highlightScrollHeight)).toBeLessThanOrEqual(lineHeight);
  });
});
