/**
 * 09 — Context Inspector modal
 *
 * Tests opening via the context meter, navigating sections,
 * expanding rows, and closing via button / Escape / click-outside.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected } from '../helpers/ui.js';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

async function openInspector(page: import('@playwright/test').Page): Promise<void> {
  // The context meter in the sidebar is clickable
  await page.locator('#sb-ctx-meter').click();
  await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
}

test('clicking context meter opens inspector', async ({ page }) => {
  await openInspector(page);
});

test('inspector shows summary line with token count', async ({ page }) => {
  await openInspector(page);
  const summary = page.locator('#ctx-inspector-summary');
  await expect(summary).not.toBeEmpty();
  // Should contain a number
  const text = await summary.innerText();
  expect(text).toMatch(/\d/);
});

test('inspector shows stacked bar', async ({ page }) => {
  await openInspector(page);
  const bars = page.locator('#ctx-inspector-bars');
  await expect(bars).toBeVisible();
  // Should have multiple bar rows
  const rows = bars.locator('.ctx-bar-row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
});

test('inspector messages section is present', async ({ page }) => {
  await openInspector(page);
  await expect(page.locator('#ctx-inspector-messages-header')).toBeVisible();
  await expect(page.locator('#ctx-inspector-messages')).toBeAttached();
});

test('bar rows are expandable on click', async ({ page }) => {
  await openInspector(page);
  const firstRow = page.locator('#ctx-inspector-bars .ctx-bar-row').first();
  await firstRow.click();
  // An expand panel should appear
  const expandPanel = page.locator('#ctx-inspector-bars .ctx-expand-panel').first();
  await expect(expandPanel).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('close button hides inspector', async ({ page }) => {
  await openInspector(page);
  await page.locator('#ctx-inspector-close').click();
  await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('Escape key closes inspector', async ({ page }) => {
  await openInspector(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('clicking outside overlay closes inspector', async ({ page }) => {
  await openInspector(page);
  // Click the overlay backdrop (outside the modal card)
  await page.locator('#ctx-inspector-overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('#ctx-inspector-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
});

test('header context meter is also clickable', async ({ page }) => {
  // The header has ctx-meter-wrap / ctx-meter too (visible on smaller screens or always)
  // If visible, clicking it should open the inspector
  const headerMeter = page.locator('#ctx-meter');
  const isVisible = await headerMeter.isVisible();
  if (isVisible) {
    await headerMeter.click();
    await expect(page.locator('#ctx-inspector-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await page.keyboard.press('Escape');
  }
});
