/**
 * 36 — Permission "Always Allow" sync to Settings UI
 *
 * Verifies that:
 * 1. Clicking "Always Allow" sends the --always flag
 * 2. Incoming client_settings events update the Permissions tab in real time
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Permission Always-Allow Sync', () => {
  const getPage = useSharedPage();

  // ── Always Allow button sends --always flag ─────────────────────────────────

  test('clicking Always Allow on exec request sends --always command', async () => {
    const page = getPage();

    // Capture WebSocket messages sent by the browser
    const sentMessages: string[] = [];
    await page.evaluate(() => {
      const origSend = WebSocket.prototype.send;
      (window as Record<string, unknown>).__wsSent = [] as string[];
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          ((window as Record<string, unknown>).__wsSent as string[]).push(data);
        }
        return origSend.call(this, data);
      };
    });

    await injectEvent({ type: 'exec_request', id: 'aa_e1', command: 'echo always-allow-test' });
    await expectVisible(page.locator('#perm-overlay'));

    // Click "Always Allow"
    await page.locator('#perm-always-allow-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    // Check that the sent WebSocket message includes --always
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__wsSent as string[]);
    const approveMsg = sent.find(s => s.includes('approve-exec') && s.includes('aa_e1'));
    expect(approveMsg).toBeDefined();

    const parsed = JSON.parse(approveMsg!);
    expect(parsed.cmd).toContain('--always');

    // Cleanup: restore WebSocket.send
    await page.evaluate(() => { delete (window as Record<string, unknown>).__wsSent; });
  });

  // ── Settings UI updates from incoming client_settings ───────────────────────

  test('exec permissions update in Settings modal after client_settings event', async () => {
    const page = getPage();

    // Inject a client_settings event with exec permission data
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['echo hello-from-test', 'ls -la /workspace']),
      },
    });

    // Open Settings modal (assertions below have timeouts and will poll until data arrives)
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Navigate to Permissions tab (exact match to avoid matching "Fetch Permissions")
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();

    // The string-list textarea should contain the injected patterns
    const textarea = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(textarea).toBeVisible({ timeout: 2_000 });
    await expect(textarea).toHaveValue(/echo hello-from-test/, { timeout: 5_000 });
    await expect(textarea).toHaveValue(/ls -la \/workspace/);

    // Close settings
    await page.locator('#settings-close').click();
  });

  test('fetch permissions update in Settings modal after client_settings event', async () => {
    const page = getPage();

    // Inject a client_settings event with fetch permission data
    await injectEvent({
      type: 'client_settings',
      settings: {
        fetch_perm_alwaysAllow: JSON.stringify(['example.com', '*.github.com']),
      },
    });

    // Open Settings modal (assertions below have timeouts and will poll until data arrives)
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Navigate to Fetch Permissions tab
    const fetchPermNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ });
    await fetchPermNav.click();

    // The string-list textarea should contain the injected patterns
    const textarea = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(textarea).toBeVisible({ timeout: 2_000 });
    await expect(textarea).toHaveValue(/example\.com/, { timeout: 5_000 });
    await expect(textarea).toHaveValue(/\*\.github\.com/);

    // Close settings
    await page.locator('#settings-close').click();
  });

  // ── Live update while Settings modal is open ────────────────────────────────

  test('permissions update live while Settings modal is already open', async () => {
    const page = getPage();

    // Open Settings modal and navigate to Permissions tab first
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();

    // Now inject a client_settings event while the modal is open
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['live-update-test-cmd']),
      },
    });

    // The textarea should update in real time
    const textarea = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(textarea).toHaveValue(/live-update-test-cmd/, { timeout: 3_000 });

    // Close settings
    await page.locator('#settings-close').click();
  });
});
