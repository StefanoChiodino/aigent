/**
 * 53 — Permission modal Enter-key guard
 *
 * Regression test: pressing Enter inside a settings text input or textarea
 * must NOT silently approve a pending permission request.
 *
 * The PermissionModal listens for Enter on `window` to approve. Without the
 * interactive-element guard, any Enter keypress — even inside an unrelated
 * text field — resolves the permission. This spec verifies the guard works
 * end-to-end in a real browser.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Permission Enter-key guard', () => {
  const getPage = useSharedPage();

  /** Inject an exec_request so the permission modal is showing. */
  async function showPermModal(id: string) {
    await injectEvent({ type: 'exec_request', id, command: `echo guard-test-${id}` });
    const page = getPage();
    await expectVisible(page.locator('#perm-overlay'));
  }

  /** Open settings and navigate to Model tab (which has a text input). */
  async function openSettingsTextInput(page: import('@playwright/test').Page) {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    const modelNav = page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' });
    await modelNav.click();
  }

  /** Open settings and navigate to Permissions tab (which has a textarea). */
  async function openSettingsTextarea(page: import('@playwright/test').Page) {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
    const permNav = page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ });
    await permNav.click();
  }

  // ── Core regression: Enter in settings text input ─────────────────────────

  test('Enter in settings text input does NOT approve pending permission', async () => {
    const page = getPage();

    // Show the permission modal
    await showPermModal('guard_input_1');

    // Install WS send spy
    await page.evaluate(() => {
      (window as Record<string, unknown>).__wsSent = [] as string[];
      const origSend = WebSocket.prototype.send;
      (window as Record<string, unknown>).__wsOrigSend = origSend;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          ((window as Record<string, unknown>).__wsSent as string[]).push(data);
        }
        return origSend.call(this, data);
      };
    });

    // Open settings on top of the permission modal
    await openSettingsTextInput(page);

    // Focus the text input and press Enter
    const textInput = page.locator('#settings-body .settings-group:not(.hidden) input.settings-text[type="text"]').first();
    await expect(textInput).toBeVisible({ timeout: 2_000 });
    await textInput.focus();
    await page.keyboard.press('Enter');

    // Permission modal should still be visible (not accidentally approved)
    await expectVisible(page.locator('#perm-overlay'));

    // No approve command should have been sent
    const sent = await page.evaluate(() => (window as Record<string, unknown>).__wsSent as string[]);
    const approveMsg = sent.find(s => s.includes('approve-exec') && s.includes('guard_input_1'));
    expect(approveMsg).toBeUndefined();

    // Cleanup: restore WS send, close settings, dismiss perm modal
    await page.evaluate(() => {
      const orig = (window as Record<string, unknown>).__wsOrigSend as typeof WebSocket.prototype.send;
      if (orig) WebSocket.prototype.send = orig;
      delete (window as Record<string, unknown>).__wsSent;
      delete (window as Record<string, unknown>).__wsOrigSend;
    });
    await page.locator('#settings-close').click();
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  // ── Core regression: Enter in settings textarea ───────────────────────────

  test('Enter in settings textarea does NOT approve pending permission', async () => {
    const page = getPage();

    await showPermModal('guard_textarea_1');

    await page.evaluate(() => {
      (window as Record<string, unknown>).__wsSent = [] as string[];
      const origSend = WebSocket.prototype.send;
      (window as Record<string, unknown>).__wsOrigSend = origSend;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          ((window as Record<string, unknown>).__wsSent as string[]).push(data);
        }
        return origSend.call(this, data);
      };
    });

    // Open settings and navigate to Permissions tab (has textarea)
    await openSettingsTextarea(page);

    const textarea = page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
    await expect(textarea).toBeVisible({ timeout: 2_000 });
    await textarea.focus();
    await page.keyboard.press('Enter');

    // Permission modal must still be showing
    await expectVisible(page.locator('#perm-overlay'));

    const sent = await page.evaluate(() => (window as Record<string, unknown>).__wsSent as string[]);
    const approveMsg = sent.find(s => s.includes('approve-exec') && s.includes('guard_textarea_1'));
    expect(approveMsg).toBeUndefined();

    // Cleanup
    await page.evaluate(() => {
      const orig = (window as Record<string, unknown>).__wsOrigSend as typeof WebSocket.prototype.send;
      if (orig) WebSocket.prototype.send = orig;
      delete (window as Record<string, unknown>).__wsSent;
      delete (window as Record<string, unknown>).__wsOrigSend;
    });
    await page.locator('#settings-close').click();
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  // ── Enter in chat input does NOT approve ──────────────────────────────────

  test('Enter in chat input does NOT approve pending permission', async () => {
    const page = getPage();

    await showPermModal('guard_chat_1');

    await page.evaluate(() => {
      (window as Record<string, unknown>).__wsSent = [] as string[];
      const origSend = WebSocket.prototype.send;
      (window as Record<string, unknown>).__wsOrigSend = origSend;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          ((window as Record<string, unknown>).__wsSent as string[]).push(data);
        }
        return origSend.call(this, data);
      };
    });

    // Focus the main chat input and press Enter
    const input = page.locator('#input');
    await input.focus();
    await page.keyboard.press('Enter');

    // Permission modal must still be showing
    await expectVisible(page.locator('#perm-overlay'));

    const sent = await page.evaluate(() => (window as Record<string, unknown>).__wsSent as string[]);
    const approveMsg = sent.find(s => s.includes('approve-exec') && s.includes('guard_chat_1'));
    expect(approveMsg).toBeUndefined();

    // Cleanup
    await page.evaluate(() => {
      const orig = (window as Record<string, unknown>).__wsOrigSend as typeof WebSocket.prototype.send;
      if (orig) WebSocket.prototype.send = orig;
      delete (window as Record<string, unknown>).__wsSent;
      delete (window as Record<string, unknown>).__wsOrigSend;
    });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  // ── Positive: Enter on body DOES approve (sanity check) ───────────────────

  test('Enter key on non-interactive element still approves permission', async () => {
    const page = getPage();

    await showPermModal('guard_body_1');

    // Click on the permission card body area to ensure focus is not on an input
    await page.locator('#perm-card-title').click();

    // Press Enter — this should approve the request
    await page.keyboard.press('Enter');

    // Permission modal should be dismissed
    await expectHidden(page.locator('#perm-overlay'));
  });
});
