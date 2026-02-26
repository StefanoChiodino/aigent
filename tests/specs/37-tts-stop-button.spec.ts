/**
 * 37 — TTS stop button scope
 *
 * The per-message TTSButton in Message.tsx now mirrors global `ttsPlaying` so
 * that all stop controls are visible whenever TTS is active (auto-speak or
 * manual).
 *
 * Tests:
 *   - Completed message TTS button shows stop when ttsPlaying is true
 *   - Streaming message shows stop button when ttsPlaying is true
 *   - Streaming message stop button disappears when ttsPlaying returns to false
 *   - Cancel button in InputArea visible when ttsPlaying is true (not loading)
 *   - Starting mic stops TTS (ttsPlaying becomes false)
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { installMicMock } from '../helpers/mic-mock.js';

test.describe('@fast TTS stop button scope', () => {
  const getPage = useSharedPage();

  async function setTtsPlaying(page: ReturnType<typeof getPage>, playing: boolean) {
    await page.evaluate((p) => {
      const store = (window as any).__zustand_voice;
      store.getState().setTtsPlaying(p);
    }, playing);
  }

  test('completed message TTS button shows stop when global ttsPlaying is true', async () => {
    const page = getPage();

    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'A completed response.',
        timestamp: new Date().toISOString(),
      },
    });

    const msg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(msg).toBeVisible();
    const ttsBtn = msg.locator('.tts-btn');
    await expect(ttsBtn).toHaveCount(1);

    // Global TTS fires (e.g. auto-speak from previous turn still draining)
    await setTtsPlaying(page, true);

    // The per-message button now mirrors global state — it should show stop
    await expect(ttsBtn).toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(ttsBtn).toHaveAttribute('title', 'Stop');

    await setTtsPlaying(page, false);

    // After TTS stops, button reverts to speak state
    await expect(ttsBtn).not.toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(ttsBtn).toHaveAttribute('title', 'Speak');
  });

  test('streaming message shows stop button when ttsPlaying is true', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'Streaming text.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    await setTtsPlaying(page, true);
    const stopBtn = streamingMsg.locator('.tts-btn.speaking');
    await expect(stopBtn).toBeVisible({ timeout: 3000 });

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
    await setTtsPlaying(page, false);
  });

  test('streaming message stop button disappears when ttsPlaying becomes false', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'More streaming.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    await setTtsPlaying(page, true);
    await expect(streamingMsg.locator('.tts-btn.speaking')).toBeVisible({ timeout: 2000 });

    await setTtsPlaying(page, false);
    await expect(streamingMsg.locator('.tts-btn.speaking')).not.toBeVisible({ timeout: 2000 });

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('cancel button visible when ttsPlaying is true and not loading', async () => {
    const page = getPage();

    // Not loading, but TTS is playing
    await setTtsPlaying(page, true);

    await expectVisible(page.locator('#cancel'));
    await expectHidden(page.locator('#send'));

    // Cleanup
    await setTtsPlaying(page, false);
    await expectHidden(page.locator('#cancel'));
  });

  test('starting mic stops TTS playback', async () => {
    const page = getPage();
    await installMicMock(page);

    // Start TTS playback
    await setTtsPlaying(page, true);
    await expectVisible(page.locator('#cancel'));

    // Start mic — should stop TTS
    await page.locator('#mic').click();
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // ttsPlaying should now be false (mic's startMic calls ttsStopAll)
    const ttsPlaying = await page.evaluate(() => {
      const store = (window as any).__zustand_voice;
      return store.getState().ttsPlaying;
    });
    expect(ttsPlaying).toBe(false);

    // Cancel button should be hidden (not loading, TTS stopped)
    await expectHidden(page.locator('#cancel'));
  });
});
