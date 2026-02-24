/**
 * 28 — Permission approval routing (gatekeeper intercept)
 *
 * Verifies that clicking Approve/Deny on permission modals routes the
 * command through the gatekeeper (not the worker). Before the fix,
 * /grant and /approve commands were sent via client.sendCommand() which
 * bypassed the gatekeeper intercept, producing "Unknown command" errors.
 *
 * NOTE: We only check system messages that appear AFTER the approve/deny
 * action because the gatekeeper's cached state may contain "Unknown command"
 * messages from previous test specs (the cache accumulates across all specs).
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

/**
 * Get the text content of all system messages currently on the page.
 * Returns an array of strings (one per .message.system element).
 */
async function getSystemMessageTexts(page: import('@playwright/test').Page): Promise<string[]> {
  const locator = page.locator('#messages .message.system .message-content');
  const count = await locator.count();
  const texts: string[] = [];
  for (let i = 0; i < count; i++) {
    texts.push(await locator.nth(i).textContent() ?? '');
  }
  return texts;
}

test.describe('Permission Approval Routing', () => {
  const getPage = useSharedPage();

  test('approving a mount request does not produce "Unknown command"', async () => {
    const page = getPage();

    // Snapshot message count BEFORE the action so we only check new messages
    const beforeTexts = await getSystemMessageTexts(page);
    const beforeCount = beforeTexts.length;

    await injectEvent({ type: 'mount_request', id: 'route_m1', path: '/tmp/test-route', mode: 'rw' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    // Wait for any system message to arrive from the server
    await page.waitForTimeout(1_000);

    // Only check system messages that appeared AFTER the action
    const afterTexts = await getSystemMessageTexts(page);
    for (let i = beforeCount; i < afterTexts.length; i++) {
      expect(afterTexts[i]).not.toContain('Unknown command');
    }
  });

  test('denying a mount request does not produce "Unknown command"', async () => {
    const page = getPage();

    const beforeTexts = await getSystemMessageTexts(page);
    const beforeCount = beforeTexts.length;

    await injectEvent({ type: 'mount_request', id: 'route_m2', path: '/tmp/test-route', mode: 'ro' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await page.waitForTimeout(1_000);

    const afterTexts = await getSystemMessageTexts(page);
    for (let i = beforeCount; i < afterTexts.length; i++) {
      expect(afterTexts[i]).not.toContain('Unknown command');
    }
  });

  test('approving an exec request does not produce "Unknown command"', async () => {
    const page = getPage();

    const beforeTexts = await getSystemMessageTexts(page);
    const beforeCount = beforeTexts.length;

    await injectEvent({ type: 'exec_request', id: 'route_e1', command: 'echo test-routing' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await page.waitForTimeout(1_000);

    const afterTexts = await getSystemMessageTexts(page);
    for (let i = beforeCount; i < afterTexts.length; i++) {
      expect(afterTexts[i]).not.toContain('Unknown command');
    }
  });

  test('approving a fetch request does not produce "Unknown command"', async () => {
    const page = getPage();

    const beforeTexts = await getSystemMessageTexts(page);
    const beforeCount = beforeTexts.length;

    await injectEvent({ type: 'fetch_request', id: 'route_f1', url: 'https://example.com', method: 'GET' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await page.waitForTimeout(1_000);

    const afterTexts = await getSystemMessageTexts(page);
    for (let i = beforeCount; i < afterTexts.length; i++) {
      expect(afterTexts[i]).not.toContain('Unknown command');
    }
  });
});
