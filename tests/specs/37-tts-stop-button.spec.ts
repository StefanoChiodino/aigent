/**
 * 37 — TTS stop button scope
 *
 * The per-message TTSButton uses `ttsSpeakingId` so only the actively-spoken
 * message shows the pulsing stop icon.  Other completed messages keep their
 * normal speak icon.
 *
 * Tests:
 *   - Only the actively speaking message shows the stop button
 *   - Other completed messages keep speak state while one is speaking
 *   - Streaming message shows stop button only for streaming TTS
 *   - Streaming message stop button disappears when TTS stops
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

  async function setTtsSpeakingId(page: ReturnType<typeof getPage>, id: string | null) {
    await page.evaluate((i) => {
      const store = (window as any).__zustand_voice;
      store.getState().setTtsSpeakingId(i);
    }, id);
  }

  async function setTtsPlaying(page: ReturnType<typeof getPage>, playing: boolean) {
    await page.evaluate((p) => {
      const store = (window as any).__zustand_voice;
      store.getState().setTtsPlaying(p);
    }, playing);
  }

  test('only the actively speaking message shows the stop button', async () => {
    const page = getPage();

    const ts1 = '2025-01-01T00:00:01.000Z';
    const ts2 = '2025-01-01T00:00:02.000Z';

    // Inject two completed assistant messages with distinct timestamps
    await injectEvent({
      type: 'message',
      message: { id: ts1, role: 'assistant', content: 'First response.', timestamp: ts1 },
    });
    await injectEvent({
      type: 'message',
      message: { id: ts2, role: 'assistant', content: 'Second response.', timestamp: ts2 },
    });

    const msgs = page.locator('.message.assistant:not(.streaming)');
    await expect(msgs).toHaveCount(2, { timeout: 3000 });

    const btn1 = msgs.nth(0).locator('.tts-btn');
    const btn2 = msgs.nth(1).locator('.tts-btn');

    // Simulate speaking the first message
    await setTtsPlaying(page, true);
    await setTtsSpeakingId(page, ts1);

    // First message's button shows stop (pulsing)
    await expect(btn1).toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(btn1).toHaveAttribute('title', 'Stop');

    // Second message's button stays in speak state
    await expect(btn2).not.toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(btn2).toHaveAttribute('title', 'Speak');

    // Switch to speaking the second message
    await setTtsSpeakingId(page, ts2);

    // Now second shows stop, first reverts to speak
    await expect(btn2).toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(btn2).toHaveAttribute('title', 'Stop');
    await expect(btn1).not.toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(btn1).toHaveAttribute('title', 'Speak');

    // Stop all
    await setTtsSpeakingId(page, null);
    await setTtsPlaying(page, false);

    await expect(btn1).not.toHaveClass(/\bspeaking\b/, { timeout: 3000 });
    await expect(btn2).not.toHaveClass(/\bspeaking\b/, { timeout: 3000 });
  });

  test('streaming message shows stop button only for streaming TTS', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'Streaming text.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    // Simulate streaming auto-speak
    await setTtsPlaying(page, true);
    await setTtsSpeakingId(page, '__streaming__');
    const stopBtn = streamingMsg.locator('.tts-btn.speaking');
    await expect(stopBtn).toBeVisible({ timeout: 3000 });

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
    await setTtsSpeakingId(page, null);
    await setTtsPlaying(page, false);
  });

  test('streaming message stop button disappears when TTS stops', async () => {
    const page = getPage();

    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({ type: 'text', content: 'More streaming.' });

    const streamingMsg = page.locator('.message.assistant.streaming');
    await expect(streamingMsg).toBeVisible({ timeout: 3000 });

    await setTtsPlaying(page, true);
    await setTtsSpeakingId(page, '__streaming__');
    await expect(streamingMsg.locator('.tts-btn.speaking')).toBeVisible({ timeout: 2000 });

    await setTtsSpeakingId(page, null);
    await setTtsPlaying(page, false);
    await expect(streamingMsg.locator('.tts-btn.speaking')).not.toBeVisible({ timeout: 2000 });

    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('completed messages do NOT show stop when streaming TTS is active', async () => {
    const page = getPage();

    const ts = '2025-01-01T00:00:05.000Z';
    await injectEvent({
      type: 'message',
      message: { id: ts, role: 'assistant', content: 'Older response.', timestamp: ts },
    });

    const completedMsg = page.locator('.message.assistant:not(.streaming)').last();
    await expect(completedMsg).toBeVisible();
    const ttsBtn = completedMsg.locator('.tts-btn');

    // Streaming auto-speak active — completed message should NOT pulse
    await setTtsPlaying(page, true);
    await setTtsSpeakingId(page, '__streaming__');

    await expect(ttsBtn).not.toHaveClass(/\bspeaking\b/, { timeout: 2000 });
    await expect(ttsBtn).toHaveAttribute('title', 'Speak');

    // Cleanup
    await setTtsSpeakingId(page, null);
    await setTtsPlaying(page, false);
  });

  test('cancel button visible when ttsPlaying is true and not loading', async () => {
    const page = getPage();

    // Not loading, but TTS is playing
    await setTtsPlaying(page, true);

    await expectVisible(page.locator('#cancel'));
    // Send button is always visible now — it queues messages
    await expectVisible(page.locator('#send'));

    // Cleanup
    await setTtsPlaying(page, false);
    await expectHidden(page.locator('#cancel'));
  });

  test('starting mic stops TTS playback', async () => {
    const page = getPage();
    await installMicMock(page);

    // Start TTS playback
    await setTtsPlaying(page, true);
    await setTtsSpeakingId(page, 'some-msg');
    await expectVisible(page.locator('#cancel'));

    // Start mic — should stop TTS
    await page.locator('#mic').click();
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // ttsPlaying and ttsSpeakingId should now be cleared
    const state = await page.evaluate(() => {
      const store = (window as any).__zustand_voice;
      const s = store.getState();
      return { ttsPlaying: s.ttsPlaying, ttsSpeakingId: s.ttsSpeakingId };
    });
    expect(state.ttsPlaying).toBe(false);
    expect(state.ttsSpeakingId).toBeNull();

    // Cancel button should be hidden (not loading, TTS stopped)
    await expectHidden(page.locator('#cancel'));
  });
});
