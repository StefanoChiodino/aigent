/**
 * 28 — Permission approval routing (gatekeeper intercept)
 *
 * Verifies that clicking Approve/Deny on permission modals routes the
 * command through the gatekeeper (not the worker). Before the fix,
 * /grant and /approve commands were sent via client.sendCommand() which
 * bypassed the gatekeeper intercept, producing "Unknown command" errors.
 *
 * Also verifies that approving or denying a request that was already
 * auto-resolved (e.g. by flushPending*() after an always-allow update)
 * does NOT produce a "No pending X request" error message. This class
 * of bug is easy to introduce because the inject endpoint doesn't
 * populate the gatekeeper's pending maps, meaning every approval in
 * test mode exercises the "already resolved" code path.
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

/** Approve the current modal and wait for it to close. Returns the `before` timestamp. */
async function approveModal(page: import('@playwright/test').Page): Promise<number> {
  const before = await page.evaluate(() => Date.now());
  await page.locator('#perm-approve-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
  // Allow a round-trip for any server error response to arrive.
  await page.waitForTimeout(500);
  return before;
}

/** Deny the current modal and wait for it to close. Returns the `before` timestamp. */
async function denyModal(page: import('@playwright/test').Page): Promise<number> {
  const before = await page.evaluate(() => Date.now());
  await page.locator('#perm-deny-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
  await page.waitForTimeout(500);
  return before;
}

async function assertNoErrors(
  page: import('@playwright/test').Page,
  sinceMs: number,
): Promise<void> {
  const msgs = await getNewSystemMessages(page, sinceMs);
  for (const text of msgs) {
    expect(text).not.toContain('Unknown command');
    expect(text).not.toContain('No pending');
  }
}

test.describe('@fast Permission Approval Routing', () => {
  const getPage = useSharedPage();

  // ── Exec ─────────────────────────────────────────────────────────────────

  test('approving an exec request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'route_e1', command: 'echo test-routing' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await approveModal(page);
    await assertNoErrors(page, before);
  });

  test('denying an exec request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'exec_request', id: 'route_e2', command: 'echo deny-routing' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await denyModal(page);
    await assertNoErrors(page, before);
  });

  // ── Fetch ─────────────────────────────────────────────────────────────────

  test('approving a fetch request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'route_f1', url: 'https://example.com', method: 'GET' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await approveModal(page);
    await assertNoErrors(page, before);
  });

  test('denying a fetch request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'route_f2', url: 'https://example.com/deny', method: 'GET' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await denyModal(page);
    await assertNoErrors(page, before);
  });

  // ── File access ────────────────────────────────────────────────────────────

  test('approving a file access request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'route_fa1', path: '/home/user/docs', operation: 'read', reason: 'Agent needs access' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await approveModal(page);
    await assertNoErrors(page, before);
  });

  test('denying a file access request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'file_access_request', id: 'route_fa2', path: '/home/user/docs', operation: 'write', reason: 'Agent wants to write' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await denyModal(page);
    await assertNoErrors(page, before);
  });

  // ── Fetch size ─────────────────────────────────────────────────────────────

  test('approving a fetch size request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({
      type: 'fetch_size_request',
      id: 'route_fs1',
      url: 'https://example.com/large.zip',
      requestedBytes: 5 * 1024 * 1024,
      defaultBytes: 1024 * 1024,
    });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await approveModal(page);
    await assertNoErrors(page, before);
  });

  test('denying a fetch size request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({
      type: 'fetch_size_request',
      id: 'route_fs2',
      url: 'https://example.com/huge.tar.gz',
      requestedBytes: 8 * 1024 * 1024,
      defaultBytes: 1024 * 1024,
    });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await denyModal(page);
    await assertNoErrors(page, before);
  });

  // ── MCP tool ───────────────────────────────────────────────────────────────

  test('approving an MCP tool request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'route_mcp1', server: 'github', tool: 'create_issue', params: '{"title":"test"}' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await approveModal(page);
    await assertNoErrors(page, before);
  });

  test('denying an MCP tool request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'mcp_tool_request', id: 'route_mcp2', server: 'github', tool: 'delete_repo', params: '{"repo":"test"}' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await denyModal(page);
    await assertNoErrors(page, before);
  });

  // ── Browser write ──────────────────────────────────────────────────────────

  test('approving a browser write request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'browser_write_request', id: 'route_bw1', action: 'navigate', stepSummary: 'Navigate to homepage', tabUrl: 'https://example.com' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await approveModal(page);
    await assertNoErrors(page, before);
  });

  test('denying a browser write request produces no gatekeeper error', async () => {
    const page = getPage();
    await injectEvent({ type: 'browser_write_request', id: 'route_bw2', action: 'run_script', stepSummary: 'Click submit button', tabUrl: 'https://example.com/form' });
    await expectVisible(page.locator('#perm-overlay'));
    const before = await denyModal(page);
    await assertNoErrors(page, before);
  });
});
