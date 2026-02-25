/**
 * 37 — TTS stop button during auto-speak
 *
 * Bug: When auto-speak is active the per-message TTS button stayed as a
 * speak icon instead of switching to a stop icon, so the user couldn't
 * stop speech from it.
 *
 * Tests:
 *   - During auto-speak streaming, the streaming message shows a stop button
 *   - After stream completes (message becomes regular), the TTS button
 *     reflects global ttsPlaying and shows stop while audio is still playing
 *   - Clicking the stop button resets it back to speak
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast TTS stop button during auto-speak', () => {
  const getPage = useSharedPage();

  /** Set ttsPlaying in the voice store from within the page. */
  async function setTtsPlaying(page: ReturnType<typeof getPage>, playing: boolean) {
    await page.evaluate((p) => {
      const store = (window as any).__zustand_voice;
      store.getState().setTtsPlaying(p);
    }, playing);
  }

  /** Set ttsAutoSpeak in the voice store from within the page. */
  async function setAutoSpeak(page: ReturnType<typeof getPage>, on: boolean) {
    await page.evaluate((v) => {
      const store = (window as any).__zustand_voice;
      store.getState().setTtsAutoSpeak(v);
    }, on);
  }

  test('streaming message shows stop button when ttsPlaying is true', async () => {
    const page = getPage();

    // Enable auto-speak
    await setAutoSpeak(page, true);

    // Start streaming
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'Hello world.' });

    // Wait for the streaming message to appear before setting TTS state
    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    // Simulate ttsPlaying = true (as if TTS engine started speaking)
    await setTtsPlaying(page, true);
    const stopBtn = streamingMsg.locator('.tts-btn.speaking');
    await expect(stopBtn).toBeVisible({ timeout: 3000 });

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
    await setTtsPlaying(page, false);
  });

  test('completed message TTS button shows stop when ttsPlaying is true', async () => {
    const page = getPage();

    // Inject a completed assistant message
    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'This is a test response from the agent.',
        timestamp: new Date().toISOString(),
      },
    });

    // The TTS button should initially show the speak icon (not stop)
    const msg = page.locator('.message.assistant').last();
    await expect(msg).toBeVisible();
    const ttsBtn = msg.locator('.tts-btn');
    await expect(ttsBtn).toHaveCount(1);
    // Should NOT have the speaking class initially
    await expect(ttsBtn).not.toHaveClass(/\bspeaking\b/);

    // Simulate global TTS playing (as if auto-speak is still playing queued chunks)
    await setTtsPlaying(page, true);

    // The TTS button should now show stop (speaking class)
    await expect(ttsBtn).toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(ttsBtn).toHaveAttribute('title', 'Stop');

    // The stop icon should be visible, speak icon hidden
    const stopIcon = ttsBtn.locator('.icon-stop-tts');
    const speakIcon = ttsBtn.locator('.icon-speak');
    await expect(stopIcon).not.toHaveClass(/\bhidden\b/);
    await expect(speakIcon).toHaveClass(/\bhidden\b/);

    // Click the stop button
    await ttsBtn.click();

    // ttsPlaying should now be false, button reverts to speak icon
    await expect(ttsBtn).not.toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(ttsBtn).toHaveAttribute('title', 'Speak');
    await expect(stopIcon).toHaveClass(/\bhidden\b/);
    await expect(speakIcon).not.toHaveClass(/\bhidden\b/);
  });

  test('clicking stop on message TTS button stops global TTS playback', async () => {
    const page = getPage();

    // Inject an assistant message
    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'Another test message.',
        timestamp: new Date().toISOString(),
      },
    });

    // Set ttsPlaying to true
    await setTtsPlaying(page, true);

    const msg = page.locator('.message.assistant').last();
    const ttsBtn = msg.locator('.tts-btn');
    await expect(ttsBtn).toHaveClass(/\bspeaking\b/, { timeout: 3000 });

    // Click stop
    await ttsBtn.click();

    // Verify the store was reset
    const playing = await page.evaluate(() => {
      const store = (window as any).__zustand_voice;
      return store.getState().ttsPlaying;
    });
    expect(playing).toBe(false);
  });
});
