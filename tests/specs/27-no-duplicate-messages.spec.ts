/**
 * 27 — No duplicate messages
 *
 * Regression test: React StrictMode double-fires effects in dev mode.
 * If the WebSocket hook doesn't guard against this, two connections are
 * created and every message appears twice in the UI.
 *
 * We inject a system message and several message events, then assert
 * each appears exactly once in the DOM.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast No duplicate messages', () => {
  const getPage = useSharedPage();

  test('injected system message appears exactly once', async () => {
    const page = getPage();
    const marker = `SYS_DEDUP_${Date.now()}`;

    await injectEvent({ type: 'system', content: marker });

    // Wait for the message to appear
    await expect(page.locator('#messages')).toContainText(marker, { timeout: 3_000 });

    // Count occurrences of the marker text in the messages container
    const count = await page.locator('#messages .message-content').evaluateAll(
      (els, text) => els.filter(el => el.textContent?.includes(text)).length,
      marker,
    );
    expect(count).toBe(1);
  });

  test('injected user message appears exactly once', async () => {
    const page = getPage();
    const marker = `USER_DEDUP_${Date.now()}`;

    await injectEvent({
      type: 'message',
      message: { role: 'user', content: marker, timestamp: new Date().toISOString() },
    });

    await expect(page.locator('#messages')).toContainText(marker, { timeout: 3_000 });

    const count = await page.locator('#messages .message-content').evaluateAll(
      (els, text) => els.filter(el => el.textContent?.includes(text)).length,
      marker,
    );
    expect(count).toBe(1);
  });

  test('injected assistant message appears exactly once', async () => {
    const page = getPage();
    const marker = `ASST_DEDUP_${Date.now()}`;

    await injectEvent({
      type: 'message',
      message: { role: 'assistant', content: marker, timestamp: new Date().toISOString() },
    });

    await expect(page.locator('#messages')).toContainText(marker, { timeout: 3_000 });

    const count = await page.locator('#messages .message-content').evaluateAll(
      (els, text) => els.filter(el => el.textContent?.includes(text)).length,
      marker,
    );
    expect(count).toBe(1);
  });

  test('rapid burst of messages produces no duplicates', async () => {
    const page = getPage();
    const markers = Array.from({ length: 5 }, (_, i) => `BURST_${i}_${Date.now()}`);

    // Fire all 5 in quick succession
    for (const m of markers) {
      await injectEvent({ type: 'system', content: m });
    }

    // Wait for the last one to arrive
    await expect(page.locator('#messages')).toContainText(markers[4]!, { timeout: 3_000 });

    // Each marker should appear exactly once
    for (const m of markers) {
      const count = await page.locator('#messages .message-content').evaluateAll(
        (els, text) => els.filter(el => el.textContent?.includes(text)).length,
        m,
      );
      expect(count).toBe(1);
    }
  });
});
