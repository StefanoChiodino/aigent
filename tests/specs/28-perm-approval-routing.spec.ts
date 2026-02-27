/**
 * 28 — Permission approval routing (gatekeeper intercept)
 *
 * Verifies that clicking Approve/Deny on permission modals routes the
 * command through the gatekeeper (not the worker). Before the fix,
 * /grant and /approve commands were sent via client.sendCommand() which
 * bypassed the gatekeeper intercept, producing "Unknown command" errors.
 *
 * Each test records a timestamp before the action and then queries the
 * Zustand chat store for system messages that arrived AFTER that timestamp.
 * This avoids false positives from historical messages in the gatekeeper's
 * cached state (which accumulates across test specs).
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

/** Get system message contents added to the store after `sinceMs` (epoch). */
async function getNewSystemMessages(
  page: import('@playwright/test').Page,
  sinceMs: number,
): Promise<string[]> {
  return page.evaluate((ts) => {
    const fn = (window as Record<string, unknown>).__testGetSystemMessagesSince as
      ((ms: number) => string[]) | undefined;
    return fn ? fn(ts) : [];
  }, sinceMs);
}

test.describe('@fast Permission Approval Routing', () => {
  const getPage = useSharedPage();

  test('approving an exec request does not produce "Unknown command"', async () => {
    const page = getPage();

    await injectEvent({ type: 'exec_request', id: 'route_e1', command: 'echo test-routing' });
    await expectVisible(page.locator('#perm-overlay'));

    const before = await page.evaluate(() => Date.now());

    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    // Negative assertion: wait for any error message to arrive (500ms is enough
    // for a server round-trip; we're checking that nothing bad happened).
    await page.waitForTimeout(500);

    const msgs = await getNewSystemMessages(page, before);
    for (const text of msgs) {
      expect(text).not.toContain('Unknown command');
    }
  });

  test('approving a fetch request does not produce "Unknown command"', async () => {
    const page = getPage();

    await injectEvent({ type: 'fetch_request', id: 'route_f1', url: 'https://example.com', method: 'GET' });
    await expectVisible(page.locator('#perm-overlay'));

    const before = await page.evaluate(() => Date.now());

    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    // Negative assertion: wait for any error message to arrive (500ms is enough
    // for a server round-trip; we're checking that nothing bad happened).
    await page.waitForTimeout(500);

    const msgs = await getNewSystemMessages(page, before);
    for (const text of msgs) {
      expect(text).not.toContain('Unknown command');
    }
  });
});
