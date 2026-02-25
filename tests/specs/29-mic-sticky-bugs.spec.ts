/**
 * 29 — Always-on mic bug fixes:
 *   1. Enabling always-on mic must not delete existing text in the input.
 *   2. Both mic and always-on mic must be off after page reload
 *      (micSticky is not persisted to localStorage).
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { waitForConnected } from '../helpers/ui.js';
import { installMicMock, mockSTT, fireLoudFrames } from '../helpers/mic-mock.js';

// ── Bug 1: Sticky mic must preserve existing text ─────────────────────────

test.describe('@mic Always-on mic preserves existing input text', () => {
  const getPage = useSharedPage();

  test('clicking sticky button does not delete existing text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'dictated words');
    const input = page.locator('#input');
    const sticky = page.locator('#mic-sticky');

    // Type some text first
    await input.fill('existing text ');

    // Enable always-on mic
    await sticky.click();
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech and wait for transcription
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue(/existing text/, { timeout: 5000 });
    // Transcription is appended after existing text
    await expect(input).toHaveValue('existing text dictated words', { timeout: 5000 });
  });

  test('Ctrl+Backtick preserves existing text when starting mic', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'voice input');
    const input = page.locator('#input');

    // Type some text
    await input.fill('typed stuff ');

    // Start mic via Ctrl+`
    await page.keyboard.press('Control+Backquote');
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('typed stuff voice input', { timeout: 5000 });
  });

  test('clicking mic button preserves existing text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'spoken part');
    const input = page.locator('#input');
    const mic = page.locator('#mic');

    // Type some text
    await input.fill('written part ');

    // Start mic via button click
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('written part spoken part', { timeout: 5000 });
  });

  test('Ctrl+Shift+Backtick sticky shortcut preserves existing text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'added by mic');
    const input = page.locator('#input');

    // Type some text
    await input.fill('already here ');

    // Enable sticky via keyboard shortcut
    await page.keyboard.press('Control+Shift+Backquote');
    await expect(page.locator('#mic-sticky')).toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('already here added by mic', { timeout: 5000 });
  });

  test('starting mic with empty input still works normally', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'fresh dictation');
    const input = page.locator('#input');
    const mic = page.locator('#mic');

    // Start mic with empty input
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    // Should show just the dictation with no leading space
    await expect(input).toHaveValue('fresh dictation', { timeout: 5000 });
  });
});

// ── Bug 3: Clicking sticky button must return focus to input ──────────────

test.describe('@mic Always-on mic returns focus to input after click', () => {
  const getPage = useSharedPage();

  test('clicking sticky button returns focus to textarea', async () => {
    const page = getPage();
    await installMicMock(page);
    const input = page.locator('#input');
    const sticky = page.locator('#mic-sticky');

    // Click sticky button (this steals focus from textarea)
    await sticky.click();
    await expect(sticky).toHaveClass(/\bactive\b/, { timeout: 3000 });

    // Focus must be back on the textarea so Enter sends the message
    await expect(input).toBeFocused({ timeout: 1000 });

    // Disable sticky — focus must still return to input
    await sticky.click();
    await expect(sticky).not.toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(input).toBeFocused({ timeout: 1000 });
  });
});

// ── Bug 2: Sticky mic must not persist across page reload ─────────────────

test.describe('@mic Always-on mic resets on page reload', () => {
  // Cannot use shared page for reload tests — need fresh page lifecycle control
  test('micSticky and mic are both off after page reload', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await waitForConnected(page);
    await installMicMock(page);

    const sticky = page.locator('#mic-sticky');
    const mic = page.locator('#mic');

    // Enable sticky mode
    await sticky.click();
    await expect(sticky).toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Reload the page
    await page.reload();
    await waitForConnected(page);

    // Both should be off after reload
    await expect(page.locator('#mic-sticky')).not.toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(page.locator('#mic')).not.toHaveClass(/\brecording\b/, { timeout: 3000 });
    // Mic button should show the idle mic icon
    await expect(page.locator('#mic .icon-mic')).toBeVisible({ timeout: 3000 });

    await page.close();
  });

  test('micSticky is not in localStorage after enabling and reloading', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await waitForConnected(page);
    await installMicMock(page);

    // Enable sticky mode
    await page.locator('#mic-sticky').click();
    await expect(page.locator('#mic-sticky')).toHaveClass(/\bactive\b/, { timeout: 3000 });

    // Check that micSticky is NOT persisted in localStorage
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('aigent-voice');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.state?.micSticky ?? null;
    });
    // micSticky should not be in the persisted state
    expect(stored).toBeNull();

    await page.close();
  });
});

// ── Bug 4: VAD indicator must not leak to sticky button in regular mic mode ──

test.describe('@mic VAD active only shows on the correct mic button', () => {
  const getPage = useSharedPage();

  test('sticky button does NOT get vad-active when regular mic is recording', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'hello');

    const mic = page.locator('#mic');
    const sticky = page.locator('#mic-sticky');

    // Start regular mic (not sticky)
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
    // Sticky should NOT be active
    await expect(sticky).not.toHaveClass(/\bactive\b/);

    // Fire loud frames to trigger VAD
    await fireLoudFrames(page, 5);

    // Mic button should show vad-active
    await expect(mic).toHaveClass(/\bvad-active\b/, { timeout: 3000 });
    // Sticky button must NOT show vad-active
    await expect(sticky).not.toHaveClass(/\bvad-active\b/);
  });

  test('sticky button shows vad-active only when sticky mode is enabled', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'hello');

    const mic = page.locator('#mic');
    const sticky = page.locator('#mic-sticky');

    // Enable sticky mic
    await sticky.click();
    await expect(sticky).toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Fire loud frames to trigger VAD
    await fireLoudFrames(page, 5);

    // Both should show vad-active when sticky is enabled
    await expect(mic).toHaveClass(/\bvad-active\b/, { timeout: 3000 });
    await expect(sticky).toHaveClass(/\bvad-active\b/, { timeout: 3000 });
  });
});
