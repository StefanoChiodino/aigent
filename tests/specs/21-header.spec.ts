/**
 * 21 — Header: logo, connection badge, task badge, cost badge, ctx meter
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Header', () => {
  const getPage = useSharedPage();

  // ── Static structure ──────────────────────────────────────────────────────────

  test('logo text is "aigent"', async () => {
    const page = getPage();
    await expect(page.locator('#logo')).toHaveText('AI·gent');
  });

  test('settings button is visible', async () => {
    const page = getPage();
    await expect(page.locator('#settings-btn')).toBeVisible();
  });

  test('settings button opens settings modal', async () => {
    const page = getPage();
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  // ── Connection badge ──────────────────────────────────────────────────────────

  test('connection badge shows "connected" after load', async () => {
    const page = getPage();
    await expect(page.locator('#conn-badge')).toContainText('connected');
  });

  test('connection badge has "connected" CSS class', async () => {
    const page = getPage();
    await expect(page.locator('#conn-badge')).toHaveClass(/connected/);
  });

  // ── Task badge ────────────────────────────────────────────────────────────────

  test('task badge is hidden when no tasks are running', async () => {
    const page = getPage();
    await expect(page.locator('#task-badge')).toHaveClass(/\bhidden\b/);
  });

  test('task badge becomes visible when a task starts running', async () => {
    const page = getPage();
    await injectEvent({
      type: 'task_update',
      task: { id: 'hdr-t1', description: 'Header test task', status: 'running', startedAt: new Date().toISOString() },
    });
    await expect(page.locator('#task-badge')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('task badge text uses singular for one task', async () => {
    const page = getPage();
    // Complete previously accumulated task from earlier test
    await injectEvent({ type: 'task_update', task: { id: 'hdr-t1', description: 'Header test task', status: 'completed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } });
    await injectEvent({
      type: 'task_update',
      task: { id: 'hdr-t2', description: 'Single task', status: 'running', startedAt: new Date().toISOString() },
    });
    await expect(page.locator('#task-badge')).toContainText('1 task', { timeout: 3_000 });
    const text = await page.locator('#task-badge').innerText();
    expect(text).not.toMatch(/tasks/);
  });

  test('task badge text uses plural for two tasks', async () => {
    const page = getPage();
    const now = new Date().toISOString();
    // Complete previously accumulated task
    await injectEvent({ type: 'task_update', task: { id: 'hdr-t2', description: 'Single task', status: 'completed', startedAt: now, completedAt: now } });
    await injectEvent({ type: 'task_update', task: { id: 'hdr-t3a', description: 'Task A', status: 'running', startedAt: now } });
    await injectEvent({ type: 'task_update', task: { id: 'hdr-t3b', description: 'Task B', status: 'running', startedAt: now } });
    await expect(page.locator('#task-badge')).toContainText('2 tasks', { timeout: 3_000 });
  });

  // ── Cost display (narrow: in overflow menu, not header badge) ────────────────

  test('cost appears in overflow menu at narrow viewport', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cost: 9.99 },
    });
    // Cost badge should be hidden at narrow viewport
    await expect(page.locator('#cost-badge')).not.toBeVisible({ timeout: 2_000 });
    // Open overflow menu — cost should appear inside
    await page.locator('#hdr-overflow-btn').click();
    const menu = page.locator('#hdr-overflow-menu');
    await expect(menu).toBeVisible({ timeout: 2_000 });
    await expect(menu).toContainText('$9.99');
  });

  test('cost badge is formatted as $X.XX for costs >= $0.01', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 50_000, output: 5_000, cacheRead: 0, cacheWrite: 0, cost: 1.23 },
    });
    // Open overflow menu to see cost
    const btn = page.locator('#hdr-overflow-btn');
    const menu = page.locator('#hdr-overflow-menu');
    if (await menu.isVisible().catch(() => false)) {
      await btn.click();
      await expect(menu).not.toBeVisible({ timeout: 1_000 });
    }
    await btn.click();
    await expect(menu).toBeVisible({ timeout: 2_000 });
    await expect(menu).toContainText('$1.23');
  });

  // ── Header context meter (mobile-only — hidden on desktop by CSS media query) ─

  test('header ctx meter appears after token usage event', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 500, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 3000, output: 500, cacheRead: 0, cacheWrite: 0, contextTokens: 3500 },
    });
    const meter = page.locator('#ctx-meter-wrap');
    await expect(meter).toBeVisible({ timeout: 3_000 });
  });

  test('header ctx label shows token count', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 500, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 5000, output: 1000, cacheRead: 0, cacheWrite: 0, contextTokens: 6000 },
    });
    const label = page.locator('#ctx-label');
    await expect(label).toBeVisible({ timeout: 3_000 });
    const text = await label.innerText();
    expect(text).toMatch(/\d/);
  });

  test('clicking header ctx meter opens context inspector', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 500, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 2000, output: 500, cacheRead: 0, cacheWrite: 0, contextTokens: 2500 },
    });
    const meter = page.locator('#ctx-meter-wrap');
    await expect(meter).toBeVisible({ timeout: 3_000 });
    await meter.click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  // ── Glass effect visual checks ────────────────────────────────────────────────

  test('header-wrap background is semi-transparent (not solid)', async () => {
    const page = getPage();
    const bg = await page.locator('#header-wrap').evaluate((el) =>
      window.getComputedStyle(el).backgroundColor
    );
    expect(bg).toMatch(/^rgba/);
    const alpha = parseFloat(bg.split(',')[3]);
    expect(alpha).toBeGreaterThan(0);
    expect(alpha).toBeLessThan(1);
  });

  test('header-wrap has backdrop-filter blur', async () => {
    const page = getPage();
    const filter = await page.locator('#header-wrap').evaluate((el) =>
      window.getComputedStyle(el).backdropFilter
    );
    expect(filter).toContain('blur(');
  });

  test('header-wrap has accent-tinted bottom border', async () => {
    const page = getPage();
    const color = await page.locator('#header-wrap').evaluate((el) =>
      window.getComputedStyle(el).borderBottomColor
    );
    // Should be rgba with some alpha (not fully transparent)
    const parts = color.match(/[\d.]+/g)!.map(Number);
    expect(parts[3]).toBeGreaterThan(0); // alpha > 0
  });

  test('header stays single-line at PiP width', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 50_000, output: 5_000, cacheRead: 0, cacheWrite: 0, cost: 2.50, contextTokens: 55_000 },
    });
    await page.waitForTimeout(300);
    const headerBox = await page.locator('#header').boundingBox();
    expect(headerBox).toBeTruthy();
    // Header should be a single line — height under 50px
    expect(headerBox!.height).toBeLessThan(50);
    await page.locator('#header-wrap').screenshot({ path: 'test-results/header-narrow-pip.png' });
  });

  // ── Narrow viewport: overflow dropdown ─────────────────────────────────────

  test('overflow menu button visible at narrow viewport', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await expect(page.locator('#hdr-overflow-btn')).toBeVisible();
  });

  test('overflow menu opens on click at narrow viewport', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    await page.locator('#hdr-overflow-btn').click();
    await expect(page.locator('#hdr-overflow-menu')).toBeVisible({ timeout: 2_000 });
  });

  test('overflow dropdown renders above chat area (not clipped behind)', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    const btn = page.locator('#hdr-overflow-btn');
    const menu = page.locator('#hdr-overflow-menu');

    // Ensure menu is closed first, then open it
    if (await menu.isVisible().catch(() => false)) {
      await btn.click(); // close
      await expect(menu).not.toBeVisible({ timeout: 1_000 });
    }
    await btn.click();
    await expect(menu).toBeVisible({ timeout: 2_000 });

    // The dropdown must be fully visible — not hidden behind the chat area.
    const menuBox = await menu.boundingBox();
    expect(menuBox).toBeTruthy();
    expect(menuBox!.y).toBeGreaterThan(0);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(720);

    // Verify the dropdown is interactable (Playwright can click items inside it)
    const firstSection = menu.locator('.hdr-overflow-section').first();
    await expect(firstSection).toBeVisible();
  });

  test('overflow dropdown closes on click outside', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    const btn = page.locator('#hdr-overflow-btn');
    const menu = page.locator('#hdr-overflow-menu');

    // Ensure menu is closed first, then open it
    if (await menu.isVisible().catch(() => false)) {
      await btn.click();
      await expect(menu).not.toBeVisible({ timeout: 1_000 });
    }
    await btn.click();
    await expect(menu).toBeVisible({ timeout: 2_000 });
    // Click on the chat area (below the header)
    await page.locator('#messages').click({ position: { x: 100, y: 100 } });
    await expect(menu).not.toBeVisible({ timeout: 2_000 });
  });

  test('model picker dropdown renders above chat area at narrow viewport', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 420, height: 720 });
    // Inject available models so the picker has content
    await page.evaluate(() => {
      const ui = (window as Record<string, unknown>).__zustand_ui as {
        getState: () => { availableModels: string[]; modelName: string };
        setState: (s: Partial<{ availableModels: string[]; modelName: string }>) => void;
      };
      ui.setState({ availableModels: ['claude-sonnet-4-6', 'claude-haiku-4-5-20251001'], modelName: 'claude-sonnet-4-6' });
    });
    await page.locator('#hdr-model-btn').click();
    const picker = page.locator('#hdr-model-picker');
    await expect(picker).toBeVisible({ timeout: 2_000 });

    // Verify dropdown renders below header, not clipped
    const box = await picker.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.y).toBeGreaterThan(0);

    // Verify a dropdown option is visible and clickable (not obscured)
    const option = picker.locator('.hdr-dropdown-option').last();
    await expect(option).toBeVisible();
    // Playwright click() will fail with "element is not visible" or
    // "intercept" error if the option is behind another layer
    await option.click();
    // After clicking the non-active option, the picker should close
    await expect(picker).not.toBeVisible({ timeout: 2_000 });
  });
});
