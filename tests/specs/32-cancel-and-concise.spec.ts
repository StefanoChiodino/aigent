/**
 * 32 — Cancel button and concise mode
 *
 * Tests:
 *   - Cancel button visibility reacts to loading state
 *   - Cancel button click sends cancel message over WebSocket
 *   - Escape key sends cancel when loading
 *   - Concise mode toggle sends command and updates via server round-trip
 *   - Concise mode state reflected in sidebar toggle after state event
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

  test('send button is hidden when loading', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await expectHidden(page.locator('#send'));
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

test.describe('@fast Concise mode', () => {
  const getPage = useSharedPage();

  test('concise toggle sends /concise command and updates state', async () => {
    const page = getPage();
    const toggle = page.locator('#sb-concise-toggle');
    const before = (await toggle.innerText()).trim();
    const expected = before === 'ON' ? 'OFF' : 'ON';

    await toggle.click();
    // Wait for server round-trip
    await expect(toggle).toHaveText(expected, { timeout: 5_000 });

    // Restore
    await toggle.click();
    await expect(toggle).toHaveText(before, { timeout: 5_000 });
  });

  test('concise toggle ON produces system message', async () => {
    const page = getPage();
    const toggle = page.locator('#sb-concise-toggle');
    const before = (await toggle.innerText()).trim();

    if (before === 'ON') {
      // Turn off first
      await toggle.click();
      await expect(toggle).toHaveText('OFF', { timeout: 5_000 });
    }

    await toggle.click();
    await expect(toggle).toHaveText('ON', { timeout: 5_000 });
    // Check system message appeared
    await expect(page.locator('#messages')).toContainText(/concise mode: on/i, { timeout: 5_000 });

    // Restore
    await toggle.click();
    await expect(toggle).toHaveText('OFF', { timeout: 5_000 });
  });

  test('concise state survives injected state event', async () => {
    const page = getPage();
    // Inject concise: true
    await injectEvent({ type: 'state', concise: true });
    await expect(page.locator('#sb-concise-toggle')).toHaveText('ON', { timeout: 3_000 });

    // Inject concise: false
    await injectEvent({ type: 'state', concise: false });
    await expect(page.locator('#sb-concise-toggle')).toHaveText('OFF', { timeout: 3_000 });
  });

  test('concise toggle has correct CSS class when on', async () => {
    const page = getPage();
    await injectEvent({ type: 'state', concise: true });
    await expect(page.locator('#sb-concise-toggle')).toHaveClass(/\bon\b/, { timeout: 3_000 });

    await injectEvent({ type: 'state', concise: false });
    await expect(page.locator('#sb-concise-toggle')).not.toHaveClass(/\bon\b/, { timeout: 3_000 });
  });
});
