/**
 * 31 — Mic-clear button: comprehensive E2E tests.
 *
 * Tests the ✕ button that clears transcribed text while the mic is still
 * recording. Covers the core fix for the bug where cleared text would
 * reappear on the next STT live-chunk cycle, plus edge cases around
 * window-cap accumulation, sequential clears, and interactions with
 * stop/submit.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { dismissPermModal } from '../helpers/ui.js';
import { installMicMock, mockSTT, fireLoudFrames, startRecordingWithText, FRAMES_TO_EXCEED_WINDOW } from '../helpers/mic-mock.js';

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('@mic Mic-clear button: clearing transcribed text', () => {
  const getPage = useSharedPage();

  test.beforeEach(async () => {
    await dismissPermModal(getPage());
  });

  // ── Basic clear behaviour ──────────────────────────────────────────────────

  test('clicking clear empties the input field', async () => {
    const page = getPage();
    await startRecordingWithText(page, 'hello world');

    await page.locator('#mic-clear').click();
    await expect(page.locator('#input')).toHaveValue('');
  });

  test('mic remains recording after clear', async () => {
    const page = getPage();
    await startRecordingWithText(page, 'hello world');

    await page.locator('#mic-clear').click();
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/);
  });

  test('hasMicText resets to false after clear', async () => {
    const page = getPage();
    await startRecordingWithText(page, 'hello world');

    // mic-clear should be enabled (not disabled class)
    await expect(page.locator('#mic-clear')).not.toHaveClass(/\bdisabled\b/);

    await page.locator('#mic-clear').click();

    // After clear, mic-clear should be disabled again (no mic text)
    await expect(page.locator('#mic-clear')).toHaveClass(/\bdisabled\b/);
  });

  test('mic-capped indicator resets on clear', async () => {
    const page = getPage();
    await startRecordingWithText(page, 'text');

    await page.locator('#mic-clear').click();
    await expect(page.locator('#mic-capped')).toHaveClass(/\bhidden\b/);
  });

  // ── Core bug fix: cleared text must NOT reappear ───────────────────────────

  test('cleared text does not reappear after next STT cycle', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttCallCount = 0;
    await page.route('**/stt', route => {
      sttCallCount++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'old text' }),
      });
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    // Start recording and get initial transcription
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('old text', { timeout: 5000 });

    const callsBefore = sttCallCount;

    // Clear the text
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Wait for at least 2 more STT cycles (1.2s each) to pass
    // The text must remain empty — the bug was that it reappeared here
    await page.waitForTimeout(3000);

    await expect(input).toHaveValue('');
  });

  test('cleared text does not reappear from in-flight STT response', async () => {
    const page = getPage();
    await installMicMock(page);

    // Use a delayed STT response to simulate in-flight request
    let resolvers: Array<() => void> = [];
    await page.route('**/stt', route => {
      const p = new Promise<void>(r => { resolvers.push(r); });
      void p.then(() => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'delayed response' }),
      }));
    });

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
    await fireLoudFrames(page, 5);

    // Wait for the first STT request to be sent (800ms initial delay)
    await page.waitForTimeout(1000);

    // Resolve the first request so text appears
    if (resolvers.length > 0) resolvers.shift()!();
    await expect(input).toHaveValue('delayed response', { timeout: 3000 });

    // Generate more audio so there's a pending chunk
    await fireLoudFrames(page, 5);

    // Clear before the next response arrives
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Now resolve any remaining delayed responses
    for (const r of resolvers) r();
    await page.waitForTimeout(500);

    // Text must remain empty — the aborted in-flight response should be ignored
    await expect(input).toHaveValue('');
  });

  // ── New speech after clear ─────────────────────────────────────────────────

  test('new speech after clear produces fresh transcription only', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'first sentence';
    await page.route('**/stt', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: sttText }),
    }));

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    // Start and get initial text
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('first sentence', { timeout: 5000 });

    // Clear
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Change STT response and produce new speech
    sttText = 'brand new text';
    await fireLoudFrames(page, 5);

    // Should show only the new text, no remnant of old
    await expect(input).toHaveValue('brand new text', { timeout: 5000 });

    // mic-clear should be enabled again since there's new text
    await expect(page.locator('#mic-clear')).not.toHaveClass(/\bdisabled\b/);
  });

  // ── Clear with accumulated base text (window cap) ──────────────────────────

  test('clear after window cap discards both base and current text', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'first window';
    await page.route('**/stt', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: sttText }),
    }));

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Phase 1: fill the first window
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('first window', { timeout: 5000 });

    // Overflow the window to commit base text
    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // Dismiss any permission overlay that appeared during the long wait
    await dismissPermModal(page);

    // Phase 2: new text in second window
    sttText = 'second window';
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('first window second window', { timeout: 5000 });

    // Clear everything
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Wait a few STT cycles — text should NOT reappear
    await page.waitForTimeout(3000);
    await expect(input).toHaveValue('');
  });

  test('new speech after clear+window-cap starts fresh (no base text)', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'old base';
    await page.route('**/stt', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: sttText }),
    }));

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Build up base text across a window boundary
    await fireLoudFrames(page, 10);
    await expect(input).toHaveValue('old base', { timeout: 5000 });

    await fireLoudFrames(page, FRAMES_TO_EXCEED_WINDOW);
    await page.waitForTimeout(2500);

    // Dismiss any permission overlay that appeared during the long wait
    await dismissPermModal(page);

    // Clear
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Produce new speech with different text
    sttText = 'totally fresh';
    await fireLoudFrames(page, 5);

    // Should only show the new text — no "old base" prefix
    await expect(input).toHaveValue('totally fresh', { timeout: 5000 });
  });

  // ── Multiple clears ────────────────────────────────────────────────────────

  test('multiple clears in sequence work correctly', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'round one';
    await page.route('**/stt', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: sttText }),
    }));

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Round 1: speak → clear
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('round one', { timeout: 5000 });
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Round 2: speak again → clear again
    sttText = 'round two';
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('round two', { timeout: 5000 });
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Round 3: speak a third time
    sttText = 'round three';
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('round three', { timeout: 5000 });
  });

  // ── Clear then stop ────────────────────────────────────────────────────────

  test('clear then stop mic leaves input empty', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'some text');

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('some text', { timeout: 5000 });

    // Clear, then stop
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Stop mic via keyboard shortcut (avoids animation instability)
    await page.keyboard.press('Control+Backquote');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    // Input should remain empty after stop
    await expect(input).toHaveValue('');
  });

  test('clear then Enter does not submit (empty input)', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'dictated text');

    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('dictated text', { timeout: 5000 });

    // Clear
    await page.locator('#mic-clear').click();
    await expect(input).toHaveValue('');

    // Stop mic (Enter while recording stops mic then submits)
    // Since input is empty, it should just stop without adding a message
    await input.press('Enter');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    // No user message bubble should have been added (empty submit is a no-op)
    const userBubbles = await page.locator('.msg.user').count();
    expect(userBubbles).toBe(0);
  });

  // ── Button enable/disable states ───────────────────────────────────────────

  test('clear button is disabled when not recording', async () => {
    const page = getPage();
    await expect(page.locator('#mic-clear')).toHaveClass(/\bdisabled\b/);
    await expect(page.locator('#mic-clear')).toBeDisabled();
  });

  test('clear button is disabled when recording with no text', async () => {
    const page = getPage();
    await installMicMock(page);
    // Mock STT to return empty so no text appears
    await mockSTT(page, '');

    const mic = page.locator('#mic');
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // No transcription yet → clear should still be disabled
    await expect(page.locator('#mic-clear')).toHaveClass(/\bdisabled\b/);
  });

  test('clear button becomes enabled when transcription appears', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'hello');

    const mic = page.locator('#mic');
    const clearBtn = page.locator('#mic-clear');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Initially disabled
    await expect(clearBtn).toHaveClass(/\bdisabled\b/);

    // Generate speech
    await fireLoudFrames(page, 5);
    await expect(page.locator('#input')).toHaveValue('hello', { timeout: 5000 });

    // Now enabled
    await expect(clearBtn).not.toHaveClass(/\bdisabled\b/);
  });

  test('clear button re-disables after clear and re-enables with new text', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttText = 'first';
    await page.route('**/stt', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: sttText }),
    }));

    const mic = page.locator('#mic');
    const clearBtn = page.locator('#mic-clear');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Get text → enabled
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('first', { timeout: 5000 });
    await expect(clearBtn).not.toHaveClass(/\bdisabled\b/);

    // Clear → disabled
    await clearBtn.click();
    await expect(clearBtn).toHaveClass(/\bdisabled\b/);

    // New text → enabled again
    sttText = 'second';
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('second', { timeout: 5000 });
    await expect(clearBtn).not.toHaveClass(/\bdisabled\b/);
  });

  // ── Clear does not disrupt recording lifecycle ─────────────────────────────

  test('audio resources remain active after clear', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'test');

    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await fireLoudFrames(page, 5);
    await expect(page.locator('#input')).toHaveValue('test', { timeout: 5000 });

    // Clear
    await page.locator('#mic-clear').click();

    // AudioContext and stream should NOT be closed
    const state = await page.evaluate(() => {
      return (window as unknown as { __micMock: { getState: () => unknown } }).__micMock.getState();
    }) as { contextClosed: boolean; streamStopped: boolean };

    expect(state.contextClosed).toBe(false);
    expect(state.streamStopped).toBe(false);

    // Mic should still show recording state
    await expect(mic).toHaveClass(/\brecording\b/);
  });

  test('stop after clear properly cleans up audio resources', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'cleanup test');

    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await fireLoudFrames(page, 5);
    await expect(page.locator('#input')).toHaveValue('cleanup test', { timeout: 5000 });

    // Clear then stop
    await page.locator('#mic-clear').click();
    await page.keyboard.press('Control+Backquote');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    // Resources should be fully cleaned up
    const state = await page.evaluate(() => {
      return (window as unknown as { __micMock: { getState: () => unknown } }).__micMock.getState();
    }) as { contextClosed: boolean; streamStopped: boolean };

    expect(state.contextClosed).toBe(true);
    expect(state.streamStopped).toBe(true);
  });
});
