/**
 * 25 — Microphone & always-on mic: UI state, buttons, keyboard shortcuts,
 *       capped indicator, sticky mode, and VAD visual feedback.
 *
 * These tests mock the browser MediaDevices and AudioContext APIs since
 * headless Chromium doesn't have a real microphone. The mock simulates the
 * onaudioprocess callback flow so we can verify the full mic lifecycle.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { installMicMock, mockSTT, mockSTTDelayed } from '../helpers/mic-mock.js';

test.describe('@mic Microphone UI state, controls, and VAD feedback', () => {
  const getPage = useSharedPage();

  // ── Initial UI state ────────────────────────────────────────────────────────

  test('mic button is visible and in idle state', async () => {
    const page = getPage();
    const mic = page.locator('#mic');
    await expect(mic).toBeVisible();
    await expect(mic).not.toHaveClass(/\brecording\b/);
    await expect(mic).not.toHaveClass(/\btranscribing\b/);
    // Should show mic icon
    await expect(mic.locator('.icon-mic')).toBeVisible();
  });

  test('mic-sticky button is visible and inactive by default', async () => {
    const page = getPage();
    const sticky = page.locator('#mic-sticky');
    await expect(sticky).toBeVisible();
    await expect(sticky).not.toHaveClass(/\bactive\b/);
    await expect(sticky).toHaveText('∞');
  });

  test('mic-clear is hidden when not recording', async () => {
    const page = getPage();
    // React component uses CSS visibility:hidden via the 'disabled' class
    await expect(page.locator('#mic-clear')).toHaveClass(/\bdisabled\b/);
  });

  test('mic-capped indicator is hidden by default', async () => {
    const page = getPage();
    await expect(page.locator('#mic-capped')).toHaveClass(/\bhidden\b/);
  });

  test('mic-capped element is inside input-wrap', async () => {
    const page = getPage();
    // The ellipsis indicator must be inside input-wrap for CSS absolute positioning to work
    const cappedInWrap = await page.locator('#input-wrap #mic-capped').count();
    expect(cappedInWrap).toBe(1);
  });

  // ── Mic button click ────────────────────────────────────────────────────────

  test('clicking mic button starts recording', async () => {
    const page = getPage();
    await installMicMock(page);
    const mic = page.locator('#mic');

    await mic.click();

    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
    await expect(mic.locator('.icon-stop')).toBeVisible();
    await expect(mic.locator('.icon-mic')).not.toBeVisible();
  });

  test('clicking mic button while recording stops recording', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');
    const mic = page.locator('#mic');

    // Start
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Stop
    await mic.click();
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 3000 });
    await expect(mic.locator('.icon-mic')).toBeVisible();
  });

  test('placeholder changes to "Listening…" when recording', async () => {
    const page = getPage();
    await installMicMock(page);
    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(input).toHaveAttribute('placeholder', 'Listening…', { timeout: 3000 });
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  test('Ctrl+Backtick toggles mic on/off', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');
    const mic = page.locator('#mic');

    // Start mic via Ctrl+`
    await page.keyboard.press('Control+Backquote');
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Stop mic via Ctrl+`
    await page.keyboard.press('Control+Backquote');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 3000 });
  });

  test('Ctrl+Shift+Backtick toggles always-on mode', async () => {
    const page = getPage();
    await installMicMock(page);
    const sticky = page.locator('#mic-sticky');

    await expect(sticky).not.toHaveClass(/\bactive\b/);

    // Enable sticky mode via Ctrl+Shift+`
    await page.keyboard.press('Control+Shift+Backquote');
    await expect(sticky).toHaveClass(/\bactive\b/, { timeout: 3000 });
  });

  test('M key toggles mic when input not focused', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');
    const mic = page.locator('#mic');

    // Blur the input first
    await page.locator('#input').blur();
    await page.locator('body').click({ position: { x: 10, y: 10 } });

    // M key should start mic
    await page.keyboard.press('m');
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
  });

  // ── Always-on (sticky) mic ──────────────────────────────────────────────────

  test('clicking sticky button toggles always-on mode', async () => {
    const page = getPage();
    await installMicMock(page);
    const sticky = page.locator('#mic-sticky');

    // Enable
    await sticky.click();
    await expect(sticky).toHaveClass(/\bactive\b/, { timeout: 3000 });

    // Also starts recording when idle
    const mic = page.locator('#mic');
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
  });

  test('disabling sticky while recording stops mic', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');
    const sticky = page.locator('#mic-sticky');
    const mic = page.locator('#mic');

    // Enable sticky (starts recording)
    await sticky.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Disable sticky (stops recording)
    await sticky.click();
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });
    await expect(sticky).not.toHaveClass(/\bactive\b/);
  });

  // ── VAD visual feedback ─────────────────────────────────────────────────────

  test('VAD active state shows on mic button during speech', async () => {
    const page = getPage();
    await installMicMock(page);
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate loud audio frames (speech) — need consecutive frames >= mic_loud_frames (default 2)
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      mock.fireAudioFrame(0.1); // loud frame 1
      mock.fireAudioFrame(0.1); // loud frame 2
    });

    await expect(mic).toHaveClass(/\bvad-active\b/, { timeout: 3000 });
  });

  test('VAD active state shows on sticky button during speech', async () => {
    const page = getPage();
    await installMicMock(page);
    const sticky = page.locator('#mic-sticky');

    // Enable sticky (starts recording)
    await sticky.click();
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate loud audio frames
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      mock.fireAudioFrame(0.1);
      mock.fireAudioFrame(0.1);
    });

    await expect(sticky).toHaveClass(/\bvad-active\b/, { timeout: 3000 });
  });

  // ── Live transcription ──────────────────────────────────────────────────────

  test('live transcription appears in input field', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'hello world');
    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate some speech frames to build up samples
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 5; i++) mock.fireAudioFrame(0.1);
    });

    // Wait for the live chunk to be sent (800ms initial + processing)
    await expect(input).toHaveValue('hello world', { timeout: 5000 });
  });

  test('mic-clear button appears when there is transcribed text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'some text');
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Generate some speech audio
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 5; i++) mock.fireAudioFrame(0.1);
    });

    // Wait for transcription to appear
    await expect(page.locator('#input')).toHaveValue('some text', { timeout: 5000 });

    // Now mic-clear should be visible
    await expect(page.locator('#mic-clear')).not.toHaveClass(/\bhidden\b/, { timeout: 3000 });
  });

  test('clicking mic-clear resets transcription text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'some text');
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Generate speech
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 5; i++) mock.fireAudioFrame(0.1);
    });

    // Wait for transcription to appear (exact value may vary due to stale intervals)
    await expect(page.locator('#mic-clear')).not.toHaveClass(/\bdisabled\b/, { timeout: 5000 });

    // Click clear
    await page.locator('#mic-clear').click();
    await expect(page.locator('#input')).toHaveValue('');
  });

  // ── Capped indicator (ellipsis) ─────────────────────────────────────────────

  test('mic-capped indicator contains ellipsis text', async () => {
    const page = getPage();
    const capped = page.locator('#mic-capped');
    await expect(capped).toHaveText('…');
  });

  test('mic-capped indicator is hidden when recording starts', async () => {
    const page = getPage();
    await installMicMock(page);
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });
    await expect(page.locator('#mic-capped')).toHaveClass(/\bhidden\b/);
  });

  test('mic-capped indicator is hidden after mic stops', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'text');
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await mic.click();
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });
    await expect(page.locator('#mic-capped')).toHaveClass(/\bhidden\b/);
  });

  test('mic-capped CSS positions it inside input-wrap', async () => {
    const page = getPage();
    // Verify the CSS rule exists for the capped indicator
    const styles = await page.evaluate(() => {
      const el = document.querySelector('#mic-capped');
      if (!el) return null;
      const computed = window.getComputedStyle(el);
      return {
        position: computed.position,
        left: computed.left,
        zIndex: computed.zIndex,
      };
    });
    expect(styles).not.toBeNull();
    expect(styles!.position).toBe('absolute');
  });

  test('input padding increases when mic-capped is visible', async () => {
    const page = getPage();
    // Get normal padding
    const normalPadding = await page.evaluate(() => {
      const el = document.querySelector('#input') as HTMLElement;
      return window.getComputedStyle(el).paddingLeft;
    });

    // Show the capped indicator by removing hidden class
    await page.evaluate(() => {
      document.querySelector('#mic-capped')?.classList.remove('hidden');
    });

    const cappedPadding = await page.evaluate(() => {
      const el = document.querySelector('#input') as HTMLElement;
      return window.getComputedStyle(el).paddingLeft;
    });

    // Restore hidden class to avoid corrupting DOM state for subsequent tests
    await page.evaluate(() => {
      document.querySelector('#mic-capped')?.classList.add('hidden');
    });

    // When capped is visible, padding should be larger to make room for the … indicator
    expect(parseInt(cappedPadding)).toBeGreaterThan(parseInt(normalPadding));
  });

  // ── Entering text while recording ───────────────────────────────────────────

  test('Enter while recording stops mic and submits', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'hello');
    const mic = page.locator('#mic');
    const input = page.locator('#input');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Generate speech
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 5; i++) mock.fireAudioFrame(0.1);
    });

    await expect(input).toHaveValue('hello', { timeout: 5000 });

    // Press Enter to submit
    await input.press('Enter');

    // Mic should stop and input should clear
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });
    await expect(input).toHaveValue('', { timeout: 3000 });
  });

  // ── Mic icon states ─────────────────────────────────────────────────────────

  test('idle state shows microphone icon', async () => {
    const page = getPage();
    const mic = page.locator('#mic');
    await expect(mic.locator('.icon-mic')).toBeVisible();
    const stop = await mic.locator('.icon-stop').count();
    const spinner = await mic.locator('.icon-spinner').count();
    // Stop and spinner should not be rendered when idle (conditional rendering)
    expect(stop).toBe(0);
    expect(spinner).toBe(0);
  });

  test('recording state shows stop icon', async () => {
    const page = getPage();
    await installMicMock(page);
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    await expect(mic.locator('.icon-stop')).toBeVisible();
    const micIcon = await mic.locator('.icon-mic').count();
    expect(micIcon).toBe(0);
  });

  // ── Mock state verification ─────────────────────────────────────────────────

  test('starting mic creates AudioContext and ScriptProcessor', async () => {
    const page = getPage();
    await installMicMock(page);
    const mic = page.locator('#mic');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    const state = await page.evaluate(() => {
      return (window as unknown as { __micMock: { getState: () => unknown } }).__micMock.getState();
    }) as { processorCreated: boolean; sourceConnected: boolean; processorConnected: boolean };

    expect(state.processorCreated).toBe(true);
    expect(state.sourceConnected).toBe(true);
    expect(state.processorConnected).toBe(true);
  });

  test('stopping mic cleans up audio resources', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');
    const mic = page.locator('#mic');

    // Start
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Stop
    await mic.click();
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    const state = await page.evaluate(() => {
      return (window as unknown as { __micMock: { getState: () => unknown } }).__micMock.getState();
    }) as { streamStopped: boolean; contextClosed: boolean; processorDisconnected: boolean };

    expect(state.streamStopped).toBe(true);
    expect(state.contextClosed).toBe(true);
  });

  // ── STT endpoint interaction ────────────────────────────────────────────────

  test('live chunks are sent to /stt endpoint', async () => {
    const page = getPage();
    await installMicMock(page);

    const sttRequests: string[] = [];
    await page.route('**/stt', async route => {
      sttRequests.push(route.request().method());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: 'test' }),
      });
    });

    const mic = page.locator('#mic');
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech to generate samples
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 10; i++) mock.fireAudioFrame(0.1);
    });

    // Wait for at least one STT request (800ms initial delay + processing)
    await page.waitForTimeout(2000);
    expect(sttRequests.length).toBeGreaterThan(0);
    expect(sttRequests[0]).toBe('POST');
  });

  test('final transcription is sent on mic stop', async () => {
    const page = getPage();
    await installMicMock(page);

    let sttCallCount = 0;
    await page.route('**/stt', async route => {
      sttCallCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ text: `transcription ${sttCallCount}` }),
      });
    });

    const mic = page.locator('#mic');
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Generate speech
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 5; i++) mock.fireAudioFrame(0.1);
    });

    // Use keyboard shortcut to stop mic (Ctrl+`) which calls stopMic directly
    // rather than clicking the button (which may hit a transcribing state race)
    await page.keyboard.press('Control+Backquote');
    await expect(mic).not.toHaveClass(/\brecording\b/, { timeout: 5000 });

    // Wait for final STT request to complete
    await page.waitForTimeout(1000);

    // At least one STT call should have been made during stop
    expect(sttCallCount).toBeGreaterThan(0);
  });

  // ── Mic-capped indicator clears on message submit ───────────────────────────

  test('mic-capped className is driven by React state', async () => {
    const page = getPage();
    const capped = page.locator('#mic-capped');

    // Default state: micCapped = false → hidden class should be present
    await expect(capped).toHaveClass(/\bhidden\b/);

    // When manually toggling via DOM, React state doesn't change, so we verify
    // that the component renders the hidden class correctly based on state
    const hasHidden = await page.evaluate(() => {
      const el = document.querySelector('#mic-capped');
      return el?.classList.contains('hidden') ?? false;
    });
    expect(hasHidden).toBe(true);
  });

  test('mic-capped indicator clears on mic-clear click', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'text');
    const mic = page.locator('#mic');
    const capped = page.locator('#mic-capped');

    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Generate speech
    await page.evaluate(() => {
      const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
      for (let i = 0; i < 5; i++) mock.fireAudioFrame(0.1);
    });

    // Wait for transcription
    await expect(page.locator('#input')).toHaveValue('text', { timeout: 5000 });

    // Click mic-clear should reset the capped indicator too
    await page.locator('#mic-clear').click();
    await expect(capped).toHaveClass(/\bhidden\b/);
  });
});
