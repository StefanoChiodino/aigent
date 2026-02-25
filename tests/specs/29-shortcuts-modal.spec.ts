/**
 * 29 — Keyboard Shortcuts modal
 *
 * Tests opening via the header button and Ctrl+? shortcut,
 * content display, and closing via button / Escape / overlay click.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Keyboard Shortcuts Modal', () => {
  const getPage = useSharedPage();

  async function openShortcuts(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#shortcuts-btn').click();
    await expect(page.locator('#shortcuts-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  test('shortcuts button is visible in header with hint label', async () => {
    const page = getPage();
    await expect(page.locator('#shortcuts-btn')).toBeVisible();
    await expect(page.locator('#shortcuts-btn .shortcut-hint')).toHaveText('Ctrl+Shift+?');
  });

  test('clicking shortcuts button opens modal', async () => {
    const page = getPage();
    await openShortcuts(page);
    await expect(page.locator('#shortcuts-modal')).toBeVisible();
  });

  test('Ctrl+? opens shortcuts modal', async () => {
    const page = getPage();
    await page.keyboard.press('Control+Shift+/');
    await expect(page.locator('#shortcuts-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('modal displays shortcut categories', async () => {
    const page = getPage();
    await openShortcuts(page);
    const body = page.locator('#shortcuts-body');
    await expect(body).toContainText('Global');
    await expect(body).toContainText('Input');
    await expect(body).toContainText('Permission Modal');
  });

  test('modal displays specific shortcuts', async () => {
    const page = getPage();
    await openShortcuts(page);
    const body = page.locator('#shortcuts-body');
    await expect(body).toContainText('Send message');
    await expect(body).toContainText('Approve');
    await expect(body).toContainText('Toggle microphone');
  });

  test('Escape closes shortcuts modal', async () => {
    const page = getPage();
    await openShortcuts(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('close button closes shortcuts modal', async () => {
    const page = getPage();
    await openShortcuts(page);
    await page.locator('#shortcuts-close').click();
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('clicking overlay closes shortcuts modal', async () => {
    const page = getPage();
    await openShortcuts(page);
    await page.locator('#shortcuts-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });
});
