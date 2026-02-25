/**
 * 38 — /reset clears conversation messages from the UI
 *
 * Injects fake messages, then sends /reset and verifies old messages
 * are removed and only "Conversation reset." remains.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';

test.describe('@fast /reset clears conversation', () => {
  const getPage = useSharedPage();

  test('old messages are removed after /reset', async () => {
    const page = getPage();
    const marker = `PRE_RESET_${Date.now()}`;

    // Inject a user message and an assistant reply so the UI has content
    await injectEvent({
      type: 'message',
      message: { role: 'user', content: marker, timestamp: new Date().toISOString() },
    });
    await injectEvent({
      type: 'message',
      message: { role: 'assistant', content: `Reply to ${marker}`, timestamp: new Date().toISOString() },
    });

    // Verify the messages are visible
    await expect(page.locator('#messages')).toContainText(marker, { timeout: 3_000 });

    // Send /reset via the real server path
    const input = page.locator('#input');
    await input.fill('/reset');
    await input.press('Enter');

    // Wait for the "Conversation reset." system message
    await expect(page.locator('#messages')).toContainText('Conversation reset.', { timeout: 5_000 });

    // The old marker text should no longer be in the DOM
    await expect(page.locator('#messages')).not.toContainText(marker, { timeout: 3_000 });
  });

  test('no user or assistant messages remain after /reset', async () => {
    const page = getPage();
    const marker = `RESET2_${Date.now()}`;

    // Inject a user and assistant message with unique markers
    await injectEvent({
      type: 'message',
      message: { role: 'user', content: marker, timestamp: new Date().toISOString() },
    });
    await injectEvent({
      type: 'message',
      message: { role: 'assistant', content: `reply-${marker}`, timestamp: new Date().toISOString() },
    });

    // Verify they appear
    await expect(page.locator('#messages')).toContainText(marker, { timeout: 3_000 });

    // Send /reset
    const input = page.locator('#input');
    await input.fill('/reset');
    await input.press('Enter');

    // After reset, only system messages should remain
    await expect(page.locator('#messages')).toContainText('Conversation reset.', { timeout: 5_000 });

    // No user or assistant messages should remain
    await expect(page.locator('#messages .message.user')).toHaveCount(0, { timeout: 3_000 });
    await expect(page.locator('#messages .message.assistant')).toHaveCount(0, { timeout: 3_000 });
  });
});
