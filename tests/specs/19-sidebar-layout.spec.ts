/**
 * 19 — Sidebar layout: tasks at top, panel anchored to bottom
 *
 * Verifies the new layout after the React migration:
 *  - #sb-tasks-section is the first child of #sidebar-panel
 *  - Static controls (model, reasoning, context, etc.) follow tasks
 *  - The sidebar panel is flex-column with margin-top:auto so it hugs the bottom
 *  - Tasks growing dynamically don't push static controls (they scroll instead)
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

const NOW = new Date().toISOString();

test.describe('Sidebar layout', () => {
  const getPage = useSharedPage();

  // ── Ordering ───────────────────────────────────────────────────────────────────

  test('tasks section is the first child of sidebar-panel', async () => {
    const page = getPage();
    const firstChild = page.locator('#sidebar-panel > :first-child');
    await expect(firstChild).toHaveAttribute('id', 'sb-tasks-section');
  });

  test('model section follows tasks section', async () => {
    const page = getPage();
    const children = page.locator('#sidebar-panel > .sidebar-section');
    // First child is tasks (#sb-tasks-section), second should contain model picker
    const second = children.nth(1);
    await expect(second).toContainText(/model/i);
  });

  test('context meter section is in sidebar-panel and after tasks in DOM order', async () => {
    const page = getPage();
    // #sb-ctx-meter may be wrapped in a .sidebar-section div; check its section index
    const taskIdx = await page.evaluate(() => {
      const panel = document.querySelector('#sidebar-panel');
      if (!panel) return -1;
      const children = Array.from(panel.children);
      return children.findIndex(el => el.id === 'sb-tasks-section');
    });
    const ctxIdx = await page.evaluate(() => {
      const panel = document.querySelector('#sidebar-panel');
      if (!panel) return -1;
      const children = Array.from(panel.children);
      // #sb-ctx-meter may be inside a child section div
      return children.findIndex(el => el.id === 'sb-ctx-meter' || !!el.querySelector('#sb-ctx-meter'));
    });
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(taskIdx);
  });

  // ── Panel CSS layout ──────────────────────────────────────────────────────────

  test('sidebar panel has margin-top auto (anchors to bottom)', async () => {
    const page = getPage();
    const styleRuleAuto = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules)) {
            if (rule instanceof CSSStyleRule && rule.selectorText === '#sidebar-panel') {
              if (rule.style.marginTop === 'auto') return 'auto';
            }
          }
        } catch { /* cross-origin */ }
      }
      return null;
    });
    expect(styleRuleAuto).toBe('auto');
  });

  test('sidebar panel has display flex and flex-direction column', async () => {
    const page = getPage();
    const [display, flexDir] = await page.evaluate(() => {
      const el = document.querySelector('#sidebar-panel');
      if (!el) return ['', ''];
      const s = getComputedStyle(el);
      return [s.display, s.flexDirection];
    });
    expect(display).toBe('flex');
    expect(flexDir).toBe('column');
  });

  test('tasks section has flex: 1 (grows to fill space)', async () => {
    const page = getPage();
    const flexGrow = await page.evaluate(() => {
      const el = document.querySelector('#sb-tasks-section');
      return el ? getComputedStyle(el).flexGrow : '';
    });
    expect(flexGrow).toBe('1');
  });

  // ── Dynamic growth doesn't move static controls ───────────────────────────────

  test('model picker position is stable after tasks are injected', async () => {
    const page = getPage();
    const modelBtn = page.locator('#sb-model-btn');
    const before = await modelBtn.boundingBox();
    expect(before).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      await injectEvent({
        type: 'task_update',
        task: { id: `layout-t${i}`, description: `Layout test task ${i}`, status: 'running', startedAt: NOW },
      });
    }
    await expect(page.locator('#sb-tasks-list')).toContainText('Layout test task 4', { timeout: 3_000 });

    const after = await modelBtn.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(4);
  });

  test('context meter position is stable after tasks are injected', async () => {
    const page = getPage();
    const ctxMeter = page.locator('#sb-ctx-meter');
    const before = await ctxMeter.boundingBox();
    expect(before).not.toBeNull();

    for (let i = 0; i < 5; i++) {
      await injectEvent({
        type: 'task_update',
        task: { id: `layout-ctx-t${i}`, description: `Ctx stability task ${i}`, status: 'running', startedAt: NOW },
      });
    }
    await expect(page.locator('#sb-tasks-list')).toContainText('Ctx stability task 4', { timeout: 3_000 });

    const after = await ctxMeter.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(4);
  });
});
