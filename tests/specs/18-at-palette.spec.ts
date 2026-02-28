/**
 * 18 — @ mention palette
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast At Mention Palette', () => {
  const getPage = useSharedPage();

  test('typing @ shows at-palette', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.click();
    await input.type('@');
    await expectVisible(page.locator('#at-palette'));
  });

  test('typing @s filters to @screen', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.click();
    await input.type('@s');
    const palette = page.locator('#at-palette');
    await expectVisible(palette);
    await expect(palette).toContainText('screen');
  });

  test('@ palette has "Mention" section header', async () => {
    const page = getPage();
    await page.locator('#input').type('@');
    await expect(page.locator('#at-palette')).toContainText('Mention');
  });

  test('typing unrelated text hides at-palette', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@');
    await expectVisible(page.locator('#at-palette'));
    // Continue with a query that matches nothing
    await input.type('zzz');
    await expectHidden(page.locator('#at-palette'));
  });

  test('slash command does not trigger at-palette', async () => {
    const page = getPage();
    await page.locator('#input').type('/reset');
    await expectHidden(page.locator('#at-palette'));
  });

  test('@ mid-sentence (after space) triggers at-palette', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('hello @');
    await expectVisible(page.locator('#at-palette'));
  });

  test('@ attached to word does not trigger at-palette', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('hello@');
    await expectHidden(page.locator('#at-palette'));
  });

  test('Escape closes at-palette without clearing input', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@');
    await expectVisible(page.locator('#at-palette'));
    await input.press('Escape');
    await expectHidden(page.locator('#at-palette'));
    await expect(input).toHaveValue('@');
  });

  test('ArrowDown moves selection to next item', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@');
    await expectVisible(page.locator('#at-palette'));
    // First item should already be selected
    await expect(page.locator('#at-palette .selected')).toHaveCount(1);
    await input.press('ArrowDown');
    await expect(page.locator('#at-palette .selected')).toHaveCount(1);
  });

  test('Tab completes selection and inserts @screen into input', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@sc');
    await expectVisible(page.locator('#at-palette'));
    // Grant media device permission so getDisplayMedia doesn't throw
    await page.context().grantPermissions(['camera', 'microphone']);
    await input.press('Tab');
    // at-palette should be hidden after completion
    await expectHidden(page.locator('#at-palette'));
    // @screen should be in the input
    await expect(input).toContainText('@screen');
  });

  test('at-palette hides after message is submitted', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@');
    await expectVisible(page.locator('#at-palette'));
    // Clear and type a normal message, submit
    await input.fill('hello');
    await input.press('Enter');
    await expectHidden(page.locator('#at-palette'));
  });

  // ── Enter key completion ──────────────────────────────────────────────────────

  test('Enter completes the selected static item and hides palette', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@cl');
    await expectVisible(page.locator('#at-palette'));
    await input.press('Enter');
    await expectHidden(page.locator('#at-palette'));
    // @clipboard should now be in the input
    await expect(input).toHaveValue('@clipboard ');
  });

  test('Enter completes @screen item', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@sc');
    await expectVisible(page.locator('#at-palette'));
    await input.press('Enter');
    await expectHidden(page.locator('#at-palette'));
    await expect(input).toHaveValue('@screen ');
  });

  test('Enter completes file item and inserts container path', async () => {
    const page = getPage();
    await page.route('**/files**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ files: [{ path: 'src/agent.ts', mountPath: '/workspace' }] }),
    }));

    await injectEvent({
      type: 'host_state',
      mounts: [{ hostPath: '/home/draga/repos/aigent', containerPath: '/workspace', mode: 'ro' }],
    });

    const input = page.locator('#input');
    await input.type('@agent');
    const palette = page.locator('#at-palette');
    await expect(palette).toContainText('agent.ts', { timeout: 3_000 });

    await input.press('Enter');
    await expectHidden(palette);
    await expect(input).toHaveValue('/workspace/src/agent.ts ');
  });

  // ── Token persistence after completion ───────────────────────────────────────

  test('@mention token stays in input after palette closes (not erased)', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@im');
    await expectVisible(page.locator('#at-palette'));
    await input.press('Tab');
    // Palette closes; token must persist
    await expectHidden(page.locator('#at-palette'));
    const val = await input.inputValue();
    expect(val).toContain('@image');
  });

  test('completed @mention token persists when user continues typing', async () => {
    const page = getPage();
    const input = page.locator('#input');
    await input.type('@im');
    await input.press('Tab');
    await expectHidden(page.locator('#at-palette'));
    // Type more text after the token
    await input.type('describe this');
    const val = await input.inputValue();
    expect(val).toContain('@image');
    expect(val).toContain('describe this');
  });

  // ── @mention chip in rendered chat messages ───────────────────────────────────

  test('@mention in sent message renders as a chip in chat', async () => {
    const page = getPage();
    const marker = `check-screen-${Date.now()}`;
    await injectEvent({
      type: 'message',
      message: { role: 'user', content: `${marker} @screen please`, timestamp: new Date().toISOString() },
    });

    // Wait for the message containing our unique marker, then find the chip inside it
    const msg = page.locator('.message.user', { hasText: marker });
    await expect(msg).toBeVisible({ timeout: 3_000 });
    await expect(msg.locator('.at-mention')).toHaveText('@screen');
  });

  test('@mention chip has correct CSS class', async () => {
    const page = getPage();
    const marker = `clipboard-test-${Date.now()}`;
    await injectEvent({
      type: 'message',
      message: { role: 'user', content: `${marker} look at @clipboard`, timestamp: new Date().toISOString() },
    });

    const msg = page.locator('.message.user', { hasText: marker });
    await expect(msg).toBeVisible({ timeout: 3_000 });
    await expect(msg.locator('.at-mention')).toBeVisible();
  });
});

// ── File browser (path mode) ─────────────────────────────────────────────────

function mockFilesRoute(page: import('@playwright/test').Page) {
  return page.route('**/files**', route => {
    const url = new URL(route.request().url());
    const dir = url.searchParams.get('dir');
    const entries: Record<string, { name: string; isDir: boolean }[]> = {
      '~/': [
        { name: 'Documents', isDir: true },
        { name: 'projects', isDir: true },
        { name: 'notes.md', isDir: false },
      ],
      '~/Documents/': [
        { name: 'report.pdf', isDir: false },
        { name: 'photos', isDir: true },
      ],
      '/': [
        { name: 'etc', isDir: true },
        { name: 'usr', isDir: true },
      ],
      './': [
        { name: 'src', isDir: true },
        { name: 'package.json', isDir: false },
        { name: 'tsconfig.json', isDir: false },
      ],
    };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: entries[dir ?? ''] ?? [] }),
    });
  });
}

test.describe('@fast At Palette File Browser', () => {
  const getPage = useSharedPage();

  test('typing @~/ triggers path mode and shows directory entries', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.click();
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expectVisible(palette);
    await expect(palette).toContainText('Documents', { timeout: 3_000 });
    await expect(palette).toContainText('projects');
    await expect(palette).toContainText('notes.md');
  });

  test('path mode hides static @mention items', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expectVisible(palette);
    await expect(palette).not.toContainText('screen');
    await expect(palette).not.toContainText('clipboard');
  });

  test('selecting a directory navigates into it (palette stays open)', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expect(palette).toContainText('Documents', { timeout: 3_000 });

    // Select the first item (Documents — a directory) via Enter
    await input.press('Enter');

    // Palette should still be visible
    await expectVisible(palette);
    // Input should now contain @~/Documents/
    await expect(input).toHaveValue('@~/Documents/');
    // Should show contents of ~/Documents/
    await expect(palette).toContainText('report.pdf', { timeout: 3_000 });
  });

  test('selecting a file inserts path and closes palette', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expect(palette).toContainText('notes.md', { timeout: 3_000 });

    // Move down to notes.md (3rd item: Documents, projects, notes.md)
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await input.press('Enter');
    await expectHidden(palette);
    // File path inserted without @, with trailing space
    await expect(input).toHaveValue('~/notes.md ');
  });

  test('typing @/ shows absolute path browser', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@/');

    const palette = page.locator('#at-palette');
    await expectVisible(palette);
    await expect(palette).toContainText('etc', { timeout: 3_000 });
    await expect(palette).toContainText('usr');
  });

  test('typing @./ shows relative path browser', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@./');

    const palette = page.locator('#at-palette');
    await expectVisible(palette);
    await expect(palette).toContainText('src', { timeout: 3_000 });
    await expect(palette).toContainText('package.json');
  });

  test('filter narrows results within a directory (fuzzy, case-insensitive)', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/Doc');

    const palette = page.locator('#at-palette');
    await expectVisible(palette);
    await expect(palette).toContainText('Documents', { timeout: 3_000 });
    // projects and notes.md should not match "Doc"
    await expect(palette).not.toContainText('projects');
    await expect(palette).not.toContainText('notes');
  });

  test('directories show folder icon, files show file icon', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expect(palette).toContainText('Documents', { timeout: 3_000 });
    const icons = await palette.locator('.at-item-icon').allTextContents();
    expect(icons).toContain('📁');
    expect(icons).toContain('📄');
  });

  test('Tab also completes directory navigation', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expect(palette).toContainText('Documents', { timeout: 3_000 });

    // Tab on directory should navigate into it
    await input.press('Tab');
    await expectVisible(palette);
    await expect(input).toHaveValue('@~/Documents/');
  });

  test('empty directory hides palette', async () => {
    const page = getPage();
    await page.route('**/files**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: [] }),
    }));
    const input = page.locator('#input');
    await input.type('@~/nonexistent/');
    // Wait for the fetch to complete
    await page.waitForTimeout(200);
    await expectHidden(page.locator('#at-palette'));
  });

  test('section header shows current directory path', async () => {
    const page = getPage();
    await mockFilesRoute(page);
    const input = page.locator('#input');
    await input.type('@~/');

    const palette = page.locator('#at-palette');
    await expect(palette).toContainText('Documents', { timeout: 3_000 });
    // Section header should show the directory path
    await expect(palette.locator('.at-palette-section')).toContainText('~/');
  });
});
