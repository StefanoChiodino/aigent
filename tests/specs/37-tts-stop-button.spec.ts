/**
 * 37 — TTS stop button scope
 *
 * The per-message TTSButton in Message.tsx only reflects that button's own
 * local `speaking` state. It does NOT mirror global `ttsPlaying` (that was
 * the old bug — every bubble showed stop during auto-speak).
 *
 * The streaming message (StreamingMessage.tsx) has its own stop button that
 * is tied to global `ttsPlaying` for auto-speak.
 *
 * Tests:
 *   - Completed message TTS button does NOT show stop when only ttsPlaying is true
 *   - Streaming message shows stop button when ttsPlaying is true
 *   - Streaming message stop button disappears when ttsPlaying returns to false
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast TTS stop button scope', () => {
  const getPage = useSharedPage();

  async function setTtsPlaying(page: ReturnType<typeof getPage>, playing: boolean) {
    await page.evaluate((p) => {
      const store = (window as any).__zustand_voice;
      store.getState().setTtsPlaying(p);
    }, playing);
  }

  test('completed message TTS button does NOT show stop when global ttsPlaying is true', async () => {
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
    await page.waitForTimeout(200);

    // The per-message button must NOT acquire the speaking class
    await expect(ttsBtn).not.toHaveClass(/\bspeaking\b/);
    await expect(ttsBtn).toHaveAttribute('title', 'Speak');

    await setTtsPlaying(page, false);
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
});
