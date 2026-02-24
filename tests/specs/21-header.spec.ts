/**
 * 21 — Header: logo, connection badge, task badge, cost badge, ctx meter
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('Header', () => {
  const getPage = useSharedPage();

  // ── Static structure ──────────────────────────────────────────────────────────

  test('logo text is "aigent"', async () => {
    const page = getPage();
    await expect(page.locator('#logo')).toHaveText('aigent');
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
    await expect(page.locator('#conn-badge')).toHaveText('connected');
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
    await injectEvent({ type: 'task_update', task: { id: 'hdr-t3a', description: 'Task A', status: 'running', startedAt: now } });
    await injectEvent({ type: 'task_update', task: { id: 'hdr-t3b', description: 'Task B', status: 'running', startedAt: now } });
    await expect(page.locator('#task-badge')).toContainText('2 tasks', { timeout: 3_000 });
  });

  // ── Cost badge (mobile-only — hidden on desktop by CSS media query) ──────────

  test('cost badge appears when usage event has a positive cost', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 500, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cost: 9.99 },
    });
    const badge = page.locator('#cost-badge');
    await expect(badge).toBeVisible({ timeout: 3_000 });
    await expect(badge).toContainText('$9.99');
  });

  test('cost badge is formatted as $X.XX for costs >= $0.01', async () => {
    const page = getPage();
    await page.setViewportSize({ width: 500, height: 720 });
    await injectEvent({
      type: 'usage',
      usage: { input: 50_000, output: 5_000, cacheRead: 0, cacheWrite: 0, cost: 1.23 },
    });
    const badge = page.locator('#cost-badge');
    await expect(badge).toBeVisible({ timeout: 3_000 });
    await expect(badge).toContainText('$1.23');
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

  test('header glass fullpage screenshot', async () => {
    const page = getPage();
    await page.waitForTimeout(600);
    await page.screenshot({ path: 'test-results/header-glass-fullpage.png' });
    await page.locator('#header-wrap').screenshot({ path: 'test-results/header-glass-crop.png' });
  });
});
