/**
 * 28 — Permission approval routing (gatekeeper intercept)
 *
 * Verifies that clicking Approve/Deny on permission modals routes the
 * command through the gatekeeper (not the worker). Before the fix,
 * /grant and /approve commands were sent via client.sendCommand() which
 * bypassed the gatekeeper intercept, producing "Unknown command" errors.
 *
 * Each test clears chat messages before acting so that stale system messages
 * from the gatekeeper's cached state (accumulated across test specs) don't
 * cause false positives.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

/** Clear all chat messages via the Zustand store. */
async function clearMessages(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const fn = (window as Record<string, unknown>).__testClearMessages;
    if (typeof fn === 'function') fn();
  });
  // Let React re-render
  await page.waitForTimeout(50);
}

test.describe('Permission Approval Routing', () => {
  const getPage = useSharedPage();

  test('approving a mount request does not produce "Unknown command"', async () => {
    const page = getPage();

    // Clear stale messages from cached state
    await clearMessages(page);

    await injectEvent({ type: 'mount_request', id: 'route_m1', path: '/tmp/test-route', mode: 'rw' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    // Wait for any system message to arrive from the server
    await page.waitForTimeout(1_000);

    // The gatekeeper should have handled /grant — no "Unknown command" in chat
    const systemMessages = page.locator('#messages .message.system .message-content');
    const count = await systemMessages.count();
    for (let i = 0; i < count; i++) {
      const text = await systemMessages.nth(i).textContent();
      expect(text).not.toContain('Unknown command');
    }
  });

  test('denying a mount request does not produce "Unknown command"', async () => {
    const page = getPage();
    await clearMessages(page);

    await injectEvent({ type: 'mount_request', id: 'route_m2', path: '/tmp/test-route', mode: 'ro' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await page.waitForTimeout(1_000);

    const systemMessages = page.locator('#messages .message.system .message-content');
    const count = await systemMessages.count();
    for (let i = 0; i < count; i++) {
      const text = await systemMessages.nth(i).textContent();
      expect(text).not.toContain('Unknown command');
    }
  });

  test('approving an exec request does not produce "Unknown command"', async () => {
    const page = getPage();
    await clearMessages(page);

    await injectEvent({ type: 'exec_request', id: 'route_e1', command: 'echo test-routing' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await page.waitForTimeout(1_000);

    const systemMessages = page.locator('#messages .message.system .message-content');
    const count = await systemMessages.count();
    for (let i = 0; i < count; i++) {
      const text = await systemMessages.nth(i).textContent();
      expect(text).not.toContain('Unknown command');
    }
  });

  test('approving a fetch request does not produce "Unknown command"', async () => {
    const page = getPage();
    await clearMessages(page);

    await injectEvent({ type: 'fetch_request', id: 'route_f1', url: 'https://example.com', method: 'GET' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await page.waitForTimeout(1_000);

    const systemMessages = page.locator('#messages .message.system .message-content');
    const count = await systemMessages.count();
    for (let i = 0; i < count; i++) {
      const text = await systemMessages.nth(i).textContent();
      expect(text).not.toContain('Unknown command');
    }
  });
});
