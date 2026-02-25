/**
 * 26 — Microphone text accumulation across window boundaries.
 *
 * When the audio buffer exceeds the 12-second Whisper window
 * (MIC_WINDOW_SAMPLES = 16 kHz * 12 s = 192 000 samples), the hook
 * commits the last successful transcription into a base-text buffer,
 * clears the audio samples, and starts a fresh window.  Subsequent
 * transcriptions are prepended with the committed base text so the
 * user never loses earlier speech.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { dismissPermModal } from '../helpers/ui.js';
import { installMicMock, fireLoudFrames, FRAMES_TO_EXCEED_WINDOW } from '../helpers/mic-mock.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('@mic Mic text accumulation across window boundaries', () => {
  const getPage = useSharedPage();

  test.beforeEach(async () => {
    await dismissPermModal(getPage());
  });

  // ── Window-cap text accumulation ─────────────────────────────────────────────

  test('transcription accumulates across a single window boundary', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'first part';
    await page.route('**/stt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: sttText }),
      });
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Phase 1: small amount of audio, well under the 12 s window
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('first part', { timeout: 5000 });

    // Overflow the window so sendLiveChunk commits "first part" to base text
    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);

    // Wait for the next interval to detect the overflow and commit
    await page.waitForTimeout(2500);

    // Phase 2: switch STT response and add fresh audio for the new window
    sttText = 'second part';
    await fireLoudFrames(page, 10);

    // Input should now show the committed base + new transcription
    await expect(input).toHaveValue('first part second part', { timeout: 5000 });
  });

  test('text accumulates across multiple window boundaries', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'alpha';
    await page.route('**/stt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: sttText }),
      });
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // ── Window 1 ──
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('alpha', { timeout: 5000 });

    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // ── Window 2 ──
    sttText = 'bravo';
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('alpha bravo', { timeout: 5000 });

    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // ── Window 3 ──
    sttText = 'charlie';
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('alpha bravo charlie', { timeout: 5000 });
  });

  test('stopping mic after window commit preserves accumulated text', async () => {
    const page = getPage();
    await installMicMock(page);

    await page.route('**/stt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'remembered text' }),
      });
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Get a transcription
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('remembered text', { timeout: 5000 });

    // Overflow → commits "remembered text" to base, clears samples
    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // Stop mic without adding new frames — samples are empty at this point.
    // Use keyboard shortcut because the VAD pulse animation makes the button
    // "unstable" for Playwright's actionability checks.
    await page.keyboard.press('Control+Backquote');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    // The committed base text must still be in the input
    await expect(input).toHaveValue('remembered text', { timeout: 3000 });
  });

  test('Enter submits full accumulated text after window cap', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'hello world';
    await page.route('**/stt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: sttText }),
      });
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Phase 1
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('hello world', { timeout: 5000 });

    // Overflow
    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // Phase 2
    sttText = 'how are you';
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('hello world how are you', { timeout: 5000 });

    // Press Enter — should stop mic and submit the full accumulated text
    await input.press('Enter');

    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });
    await expect(input).toHaveValue('', { timeout: 3000 });
  });

  test('new recording starts with empty base text', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'old session';
    await page.route('**/stt', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: sttText }),
      });
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    // ── First recording: accumulate across a window boundary ──
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('old session', { timeout: 5000 });

    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // Stop the first recording (keyboard shortcut avoids VAD animation instability)
    await page.keyboard.press('Control+Backquote');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    // Clear the input manually for a clean slate
    await input.fill('');

    // ── Second recording: base text should be reset ──
    sttText = 'fresh start';
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await fireLoudFrames(page, 10);

    // Should show only the new text — no leftover base from the first recording
    await expect(input).toHaveValue('fresh start', { timeout: 5000 });
  });
});
