/**
 * 57 — perm_dismissed race condition
 *
 * Regression test for the "No pending X request" error that appeared when:
 * 1. The gatekeeper auto-resolved a pending permission (via flushPending*()
 *    after an always-allow update, or YOLO mode turning on mid-flight)
 * 2. The browser received `perm_dismissed` and hid the modal
 * 3. BUT the browser had already sent an approval command (race between the
 *    dismiss arriving and the user clicking Approve)
 *
 * The gatekeeper's approval handlers should silently ignore commands for
 * IDs that are no longer in their pending maps, producing NO error output.
 *
 * Note: the inject endpoint does NOT populate the gatekeeper's pending maps,
 * so ALL approval commands in e2e tests exercise this "already resolved"
 * code path — making spec-28 a net that already catches regressions.
 * This spec focuses on the perm_dismissed UI side and the stale command path,
 * where we explicitly verify via a direct WebSocket client that no `system`
 * error event is emitted.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent, AigentWsClient } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast perm_dismissed race condition', () => {
  const getPage = useSharedPage();

  // ── perm_dismissed UI dismissal ──────────────────────────────────────────

  test('perm_dismissed hides the exec modal before user responds', async () => {
    const page = getPage();

    await injectEvent({ type: 'exec_request', id: 'dismiss_e1', command: 'echo dismissed' });
    await expectVisible(page.locator('#perm-overlay'));

    // Server auto-resolves — inject the dismiss event
    await injectEvent({ type: 'perm_dismissed', ids: ['dismiss_e1'] });
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('perm_dismissed hides the fetch modal before user responds', async () => {
    const page = getPage();

    await injectEvent({ type: 'fetch_request', id: 'dismiss_f1', url: 'https://example.com/auto', method: 'GET' });
    await expectVisible(page.locator('#perm-overlay'));

    await injectEvent({ type: 'perm_dismissed', ids: ['dismiss_f1'] });
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('perm_dismissed for first of two queued requests advances the queue', async () => {
    const page = getPage();

    await injectEvent({ type: 'fetch_request', id: 'dismiss_q1', url: 'https://first.example.com/' });
    await injectEvent({ type: 'fetch_request', id: 'dismiss_q2', url: 'https://second.example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('first.example.com');

    // Auto-resolve the first one — second should show immediately
    await injectEvent({ type: 'perm_dismissed', ids: ['dismiss_q1'] });
    await expect(page.locator('#perm-card-detail')).toContainText('second.example.com', { timeout: 3_000 });

    // Clean up
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('perm_dismissed for all queued requests hides the modal entirely', async () => {
    const page = getPage();

    await injectEvent({ type: 'exec_request', id: 'dismiss_all1', command: 'cmd-a' });
    await injectEvent({ type: 'exec_request', id: 'dismiss_all2', command: 'cmd-b' });
    await expectVisible(page.locator('#perm-overlay'));

    await injectEvent({ type: 'perm_dismissed', ids: ['dismiss_all1', 'dismiss_all2'] });
    await expectHidden(page.locator('#perm-overlay'));
  });

  // ── Stale approval commands after auto-dismiss ────────────────────────────
  //
  // Simulates the race: user clicks Approve just before or just after
  // perm_dismissed arrives. The gatekeeper must not produce an error.
  //
  // We use a direct WebSocket client (AigentWsClient) to send the stale
  // command from the test side, then check that the server emits no
  // `system` event containing "No pending".

  test('stale exec approval after perm_dismissed produces no error', async () => {
    const page = getPage();
    const ws = new AigentWsClient();
    await ws.connect();

    await injectEvent({ type: 'exec_request', id: 'stale_e1', command: 'echo stale' });
    await expectVisible(page.locator('#perm-overlay'));

    // Server auto-resolves — dismiss arrives
    await injectEvent({ type: 'perm_dismissed', ids: ['stale_e1'] });
    await expectHidden(page.locator('#perm-overlay'));

    // Race: stale approval command arrives at the gatekeeper
    ws.send({ type: 'command', cmd: '/approve-exec stale_e1' });

    // Give the server time to respond
    await page.waitForTimeout(500);

    // No "No pending" system event should have been broadcast
    const errorEvents = ws.collected().filter(
      e => e.type === 'system' && String(e.content).match(/No pending/),
    );
    expect(errorEvents).toHaveLength(0);

    ws.close();
  });

  test('stale fetch approval after perm_dismissed produces no error', async () => {
    const page = getPage();
    const ws = new AigentWsClient();
    await ws.connect();

    await injectEvent({ type: 'fetch_request', id: 'stale_f1', url: 'https://stale.example.com/' });
    await expectVisible(page.locator('#perm-overlay'));

    await injectEvent({ type: 'perm_dismissed', ids: ['stale_f1'] });
    await expectHidden(page.locator('#perm-overlay'));

    ws.send({ type: 'command', cmd: '/approve-fetch stale_f1' });

    await page.waitForTimeout(500);

    const errorEvents = ws.collected().filter(
      e => e.type === 'system' && String(e.content).match(/No pending/),
    );
    expect(errorEvents).toHaveLength(0);

    ws.close();
  });

  test('stale fetch denial after perm_dismissed produces no error', async () => {
    const page = getPage();
    const ws = new AigentWsClient();
    await ws.connect();

    await injectEvent({ type: 'fetch_request', id: 'stale_f2', url: 'https://stale2.example.com/' });
    await expectVisible(page.locator('#perm-overlay'));

    await injectEvent({ type: 'perm_dismissed', ids: ['stale_f2'] });
    await expectHidden(page.locator('#perm-overlay'));

    ws.send({ type: 'command', cmd: '/deny-fetch stale_f2' });

    await page.waitForTimeout(500);

    const errorEvents = ws.collected().filter(
      e => e.type === 'system' && String(e.content).match(/No pending/),
    );
    expect(errorEvents).toHaveLength(0);

    ws.close();
  });

  test('stale file access approval after perm_dismissed produces no error', async () => {
    const page = getPage();
    const ws = new AigentWsClient();
    await ws.connect();

    await injectEvent({ type: 'file_access_request', id: 'stale_fa1', path: '/tmp/test', operation: 'read', reason: 'test' });
    await expectVisible(page.locator('#perm-overlay'));

    await injectEvent({ type: 'perm_dismissed', ids: ['stale_fa1'] });
    await expectHidden(page.locator('#perm-overlay'));

    ws.send({ type: 'command', cmd: '/approve-file stale_fa1' });

    await page.waitForTimeout(500);

    const errorEvents = ws.collected().filter(
      e => e.type === 'system' && String(e.content).match(/No pending/),
    );
    expect(errorEvents).toHaveLength(0);

    ws.close();
  });
});
