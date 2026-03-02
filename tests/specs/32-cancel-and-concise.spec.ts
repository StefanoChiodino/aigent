/**
 * 32 — Cancel button and short mode
 *
 * Tests:
 *   - Cancel button visibility reacts to loading state
 *   - Cancel button click sends cancel message over WebSocket
 *   - Escape key sends cancel when loading
 *   - Short mode toggle sends command and updates via server round-trip
 *   - Short mode state reflected in sidebar toggle after state event
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Cancel button', () => {
  const getPage = useSharedPage();

  test('cancel button is hidden when not loading', async () => {
    const page = getPage();
    await expectHidden(page.locator('#cancel'));
  });

  test('cancel button appears when loading event is injected', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await expectVisible(page.locator('#cancel'));
    // Cleanup: reset loading
    await injectEvent({ type: 'loading', isLoading: false });
    await expectHidden(page.locator('#cancel'));
  });

  test('send button stays visible when loading (for message queueing)', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    // Send button is always visible now — it queues messages when loading
    await expectVisible(page.locator('#send'));
    await expect(page.locator('#send')).toHaveAttribute('title', /Queue/);
    // Cleanup
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('cancel button click restores send button', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await expectVisible(page.locator('#cancel'));

    // Click cancel
    await page.locator('#cancel').click();
    // The server won't process cancel (injected loading isn't real server state),
    // so inject the expected response manually
    await injectEvent({ type: 'loading', isLoading: false });
    await expectHidden(page.locator('#cancel'));
    await expectVisible(page.locator('#send'));
  });

  test('data-working attribute set on body while loading', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await page.waitForFunction(() => document.body.hasAttribute('data-working'), { timeout: 3_000 });

    await injectEvent({ type: 'loading', isLoading: false });
    await page.waitForFunction(() => !document.body.hasAttribute('data-working'), { timeout: 3_000 });
  });

  test('Escape key while loading sends cancel (button hides after response)', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await expectVisible(page.locator('#cancel'));

    await page.locator('#input').press('Escape');
    // Simulate server acknowledging cancel
    await injectEvent({ type: 'loading', isLoading: false });
    await expectHidden(page.locator('#cancel'));
  });

  test('cancel preserves queued messages (queue chips survive cancel)', async () => {
    const page = getPage();
    // Agent is busy, two messages are queued
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({
      type: 'queue_update',
      queue: [
        { id: 1, displayText: 'queued msg A' },
        { id: 2, displayText: 'queued msg B' },
      ],
    });
    await expect(page.locator('#queue-chips')).toBeVisible({ timeout: 3_000 });
    expect(await page.locator('.queue-chip').count()).toBe(2);

    // User clicks cancel
    await page.locator('#cancel').click();

    // Server responds: cancel current turn, preserve queue (the fix)
    await injectEvent({ type: 'loading', isLoading: false });
    await injectEvent({
      type: 'queue_update',
      queue: [
        { id: 1, displayText: 'queued msg A' },
        { id: 2, displayText: 'queued msg B' },
      ],
    });

    // Queue chips must still be visible after cancel
    await expect(page.locator('#queue-chips')).toBeVisible({ timeout: 3_000 });
    expect(await page.locator('.queue-chip').count()).toBe(2);
    await expect(page.locator('.queue-chip-text').first()).toHaveText('queued msg A');
    await expect(page.locator('.queue-chip-text').last()).toHaveText('queued msg B');

    // Cleanup
    await injectEvent({ type: 'queue_update', queue: [] });
  });

  test('cancel button click while loading sends cancel message', async () => {
    const page = getPage();

    // Capture WebSocket messages sent by the browser
    const sentMessages = await page.evaluate(() => {
      const msgs: unknown[] = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        try { msgs.push(JSON.parse(data as string)); } catch { /* binary or non-JSON */ }
        return origSend.call(this, data);
      };
      (window as Record<string, unknown>).__testSentMessages = msgs;
      (window as Record<string, unknown>).__restoreWsSend = () => { WebSocket.prototype.send = origSend; };
      return [];
    });

    await injectEvent({ type: 'loading', isLoading: true });
    await expectVisible(page.locator('#cancel'));
    await page.locator('#cancel').click();

    // Check that a cancel message was sent
    const found = await page.evaluate(() => {
      const msgs = (window as Record<string, unknown>).__testSentMessages as Array<{ type: string }>;
      return msgs.some(m => m.type === 'cancel');
    });
    expect(found).toBe(true);

    // Cleanup
    await page.evaluate(() => {
      const restore = (window as Record<string, unknown>).__restoreWsSend as () => void;
      restore();
    });
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('placeholder text changes when loading', async () => {
    const page = getPage();
    const input = page.locator('#input');

    const idlePlaceholder = await input.getAttribute('placeholder');
    expect(idlePlaceholder).toContain('Message');

    await injectEvent({ type: 'loading', isLoading: true });
    await expect(input).toHaveAttribute('placeholder', /working/i, { timeout: 3_000 });

    await injectEvent({ type: 'loading', isLoading: false });
    await expect(input).toHaveAttribute('placeholder', /Message/i, { timeout: 3_000 });
  });
});

test.describe('@fast Short mode (speak pills)', () => {
  const getPage = useSharedPage();

  test('clicking "short" speak pill sends /short on and activates pill', async () => {
    const page = getPage();
    const offPill = page.locator('#sb-speak-pills .sb-pill[data-speak="off"]');
    const shortPill = page.locator('#sb-speak-pills .sb-pill[data-speak="short"]');

    // Ensure we start from "off"
    if (!(await offPill.evaluate(el => el.classList.contains('active')))) {
      await offPill.click();
      await expect(offPill).toHaveClass(/active/, { timeout: 5_000 });
    }

    await shortPill.click();
    await expect(shortPill).toHaveClass(/active/, { timeout: 5_000 });

    // Restore
    await offPill.click();
    await expect(offPill).toHaveClass(/active/, { timeout: 5_000 });
  });

  test('clicking "short" speak pill produces system message', async () => {
    const page = getPage();
    const offPill = page.locator('#sb-speak-pills .sb-pill[data-speak="off"]');
    const shortPill = page.locator('#sb-speak-pills .sb-pill[data-speak="short"]');

    // Ensure we start from "off"
    if (!(await offPill.evaluate(el => el.classList.contains('active')))) {
      await offPill.click();
      await expect(offPill).toHaveClass(/active/, { timeout: 5_000 });
    }

    await shortPill.click();
    await expect(shortPill).toHaveClass(/active/, { timeout: 5_000 });
    await expect(page.locator('#messages')).toContainText(/short mode: on/i, { timeout: 5_000 });

    // Restore
    await offPill.click();
    await expect(offPill).toHaveClass(/active/, { timeout: 5_000 });
  });

  test('short state reflects injected state event in speak pills', async () => {
    const page = getPage();
    // Inject short: true
    await injectEvent({ type: 'state', short: true });
    await expect(page.locator('#sb-speak-pills .sb-pill[data-speak="short"]')).toHaveClass(/active/, { timeout: 3_000 });

    // Inject short: false
    await injectEvent({ type: 'state', short: false });
    await expect(page.locator('#sb-speak-pills .sb-pill[data-speak="short"]')).not.toHaveClass(/active/, { timeout: 3_000 });
  });
});
