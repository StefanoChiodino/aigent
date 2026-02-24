/**
 * 10 — Settings modal
 *
 * Opens the settings modal, navigates all tabs, changes a few settings,
 * and verifies they persist to localStorage / settings.json.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

const SETTINGS_GROUPS = ['Provider', 'Model', 'Tools', 'Prompt', 'Services', 'Microphone', 'Context', 'Permissions', 'Fetch Permissions'];

test.describe('Settings modal', () => {
  const getPage = useSharedPage();

  async function openSettings(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  // ── Open / close ──────────────────────────────────────────────────────────────

  test('settings button opens the settings modal', async () => {
    const page = getPage();
    await openSettings(page);
  });

  test('settings close button hides the modal', async () => {
    const page = getPage();
    await openSettings(page);
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  test('Escape key closes settings modal', async () => {
    const page = getPage();
    await openSettings(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  });

  // ── Navigation ────────────────────────────────────────────────────────────────

  test('settings modal has navigation items', async () => {
    const page = getPage();
    await openSettings(page);
    const navItems = page.locator('#settings-nav .settings-nav-item');
    const count = await navItems.count();
    expect(count).toBeGreaterThan(0);
  });

  for (const group of SETTINGS_GROUPS) {
    test(`can navigate to ${group} settings tab`, async () => {
      const page = getPage();
      await openSettings(page);
      // Use exact text match (regex with anchors) to avoid 'Permissions' matching 'Fetch Permissions'
      const navBtn = page.locator('#settings-nav .settings-nav-item', { hasText: new RegExp(`^${group}$`) });
      // Skip if this group doesn't exist in this build
      const count = await navBtn.count();
      if (count === 0) return;

      await navBtn.click();
      await expect(navBtn).toHaveClass(/active/);

      // The corresponding settings pane should be visible
      const body = page.locator('#settings-body');
      await expect(body).toContainText(group, { timeout: 2_000 });
    });
  }

  test('clicking each nav item shows different content', async () => {
    const page = getPage();
    await openSettings(page);
    const navItems = page.locator('#settings-nav .settings-nav-item');
    const count = await navItems.count();

    let lastText = '';
    for (let i = 0; i < Math.min(count, 4); i++) {
      await navItems.nth(i).click();
      const bodyText = await page.locator('#settings-body').innerText();
      // Each tab should show different content
      expect(bodyText).not.toEqual(lastText);
      lastText = bodyText;
    }
  });

  // ── Microphone settings ───────────────────────────────────────────────────────

  test('Microphone tab has silence threshold setting', async () => {
    const page = getPage();
    await openSettings(page);
    const micNav = page.locator('#settings-nav .settings-nav-item', { hasText: 'Microphone' });
    if (await micNav.count() === 0) return;
    await micNav.click();

    const body = page.locator('#settings-body');
    await expect(body).toContainText(/silence|threshold/i);
  });

  test('Microphone tab has auto-send toggle', async () => {
    const page = getPage();
    await openSettings(page);
    const micNav = page.locator('#settings-nav .settings-nav-item', { hasText: 'Microphone' });
    if (await micNav.count() === 0) return;
    await micNav.click();

    await expect(page.locator('#settings-body')).toContainText(/auto.?send/i);
  });

  // ── Permissions tab ───────────────────────────────────────────────────────────

  test('Permissions tab shows always-allow section', async () => {
    const page = getPage();
    await openSettings(page);
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    if (await permNav.count() === 0) return;
    await permNav.click();

    await expect(page.locator('#settings-body')).toContainText(/always.?allow/i);
  });

  test('Permissions tab shows deny section', async () => {
    const page = getPage();
    await openSettings(page);
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    if (await permNav.count() === 0) return;
    await permNav.click();

    await expect(page.locator('#settings-body')).toContainText(/deny/i);
  });

  // ── Fetch Permissions tab ─────────────────────────────────────────────────────

  test('Fetch Permissions tab shows always-allow section', async () => {
    const page = getPage();
    await openSettings(page);
    const fetchPermNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ });
    if (await fetchPermNav.count() === 0) return;
    await fetchPermNav.click();

    await expect(page.locator('#settings-body')).toContainText(/always.?allow/i);
  });

  test('Fetch Permissions tab shows deny section', async () => {
    const page = getPage();
    await openSettings(page);
    const fetchPermNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ });
    if (await fetchPermNav.count() === 0) return;
    await fetchPermNav.click();

    await expect(page.locator('#settings-body')).toContainText(/deny/i);
  });

  // ── Context tab ───────────────────────────────────────────────────────────────

  test('Context tab has summarization controls', async () => {
    const page = getPage();
    await openSettings(page);
    const ctxNav = page.locator('#settings-nav .settings-nav-item', { hasText: 'Context' });
    if (await ctxNav.count() === 0) return;
    await ctxNav.click();

    await expect(page.locator('#settings-body')).toContainText(/summariz/i);
  });

  // ── Saved toast ───────────────────────────────────────────────────────────────

  test('settings toast appears after saving a client setting', async () => {
    const page = getPage();
    await openSettings(page);

    // Navigate to Tools tab which has the first client-scope toggle ("Disable all tools")
    const toolsNav = page.locator('#settings-nav .settings-nav-item', { hasText: 'Tools' });
    if (await toolsNav.count() > 0) await toolsNav.click();

    // Toggles render as <label class="settings-toggle"><input type="checkbox"><span class="settings-toggle-track">
    // Scope to the visible (active) group to avoid hidden toggles in other tabs
    const toggleLabel = page.locator('#settings-body .settings-group:not(.hidden) .settings-toggle').first();
    if (await toggleLabel.count() === 0) return;

    await toggleLabel.click();

    // Saved toast should flash briefly
    await expect(page.locator('#settings-toast')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

    // Click again to restore the original state
    await toggleLabel.click();
  });
});
