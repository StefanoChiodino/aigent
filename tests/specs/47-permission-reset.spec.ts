/**
 * 47 — Permission reset prevention
 *
 * Regression tests for the bug where exec/fetch/file permissions were silently
 * reset to defaults. Three root causes:
 *
 * 1. StringListTextarea stale-focus: closing the settings modal via CSS
 *    (display:none) doesn't fire blur events, so focused.current stays true.
 *    When reopened, a subsequent blur committed stale data to the server.
 *
 * 2. StringListTextarea no-op blur: blurring without editing committed the
 *    current text, which could overwrite server-side changes made while the
 *    modal was open (e.g. gatekeeper --always).
 *
 * 3. readExecPermissions default merging: the gatekeeper always merged
 *    DEFAULT_EXEC_PERMISSIONS into the user's alwaysAllow list, so removed
 *    defaults reappeared on every broadcastUpdatedPermissions() call.
 *
 * These tests verify that the fixes prevent all three classes of data loss.
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Permission reset prevention', () => {
  const getPage = useSharedPage();

  // --- Helpers ---

  async function openSettings(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).not.toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  async function closeSettings(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });
  }

  async function navToPermissions(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Permissions$/ }).click();
  }

  async function navToFetchPermissions(page: import('@playwright/test').Page): Promise<void> {
    await page.locator('#settings-nav .settings-nav-item', { hasText: /^Fetch Permissions$/ }).click();
  }

  /** Get the first (alwaysAllow) textarea in the currently visible permissions group. */
  function getPermTextarea(page: import('@playwright/test').Page) {
    return page.locator('#settings-body .settings-group:not(.hidden) .settings-string-list').first();
  }

  // ── Bug 1: Modal close without blur must not corrupt permissions ──────────

  test('closing modal while textarea is focused does not commit stale data', async () => {
    const page = getPage();

    // Inject known permissions
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['pattern-A', 'pattern-B', 'pattern-C']),
      },
    });

    // Open settings and focus the permissions textarea
    await openSettings(page);
    await navToPermissions(page);
    const ta = getPermTextarea(page);
    await expect(ta).toHaveValue(/pattern-A/, { timeout: 2_000 });
    await ta.click(); // focus

    // Close the modal WITHOUT blurring first (the bug scenario)
    await closeSettings(page);

    // Now inject a DIFFERENT set of permissions (simulating gatekeeper --always)
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['pattern-A', 'pattern-B', 'pattern-C', 'newly-added']),
      },
    });

    // Reopen settings — the textarea should show the NEW server value, not stale data
    await openSettings(page);
    await navToPermissions(page);
    const ta2 = getPermTextarea(page);
    await expect(ta2).toHaveValue(/newly-added/, { timeout: 2_000 });
    await expect(ta2).toHaveValue(/pattern-A/);
    await expect(ta2).toHaveValue(/pattern-B/);
    await expect(ta2).toHaveValue(/pattern-C/);

    // Blur without editing — should NOT send a POST that removes "newly-added"
    await ta2.blur();

    // Verify the store still has all 4 patterns
    const storeValue = await page.evaluate(() => {
      const s = (window as Record<string, unknown>).__zustand_settings as
        { getState: () => { clientSettings: Record<string, string> } } | undefined;
      return s?.getState().clientSettings['exec_perm_alwaysAllow'] ?? '[]';
    });
    const patterns = JSON.parse(storeValue as string) as string[];
    expect(patterns).toContain('newly-added');
    expect(patterns).toContain('pattern-A');

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await closeSettings(page);
  });

  // ── Bug 2: No-op blur (focus then blur without editing) must not commit ───

  test('focusing and blurring textarea without editing does not commit', async () => {
    const page = getPage();

    // Inject known permissions
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['safe-pattern-1', 'safe-pattern-2']),
      },
    });

    // Open settings, go to permissions
    await openSettings(page);
    await navToPermissions(page);
    const ta = getPermTextarea(page);
    await expect(ta).toHaveValue(/safe-pattern-1/, { timeout: 2_000 });

    // Focus and immediately blur without typing anything
    await ta.click();
    await ta.blur();

    // Now inject a server push with additional patterns
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['safe-pattern-1', 'safe-pattern-2', 'server-added']),
      },
    });

    // The textarea should update to show the server value (including server-added)
    await expect(ta).toHaveValue(/server-added/, { timeout: 2_000 });

    // Clean up
    await ta.fill('');
    await ta.blur();
    await closeSettings(page);
  });

  // ── Bug 3: Server push while textarea is focused ──────────────────────────

  test('server push while textarea is focused does not overwrite user edits', async () => {
    const page = getPage();

    // Inject initial permissions
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['initial-pattern']),
      },
    });

    // Open settings, navigate, and start typing
    await openSettings(page);
    await navToPermissions(page);
    const ta = getPermTextarea(page);
    await expect(ta).toHaveValue(/initial-pattern/, { timeout: 2_000 });

    // User starts editing: clear and type custom patterns
    await ta.fill('my-custom-pattern\nanother-custom');

    // Server push arrives while textarea is focused (user is actively editing)
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['initial-pattern', 'gatekeeper-added']),
      },
    });

    // Wait a tick for the event to propagate
    await page.waitForTimeout(200);

    // The textarea should still show the user's edits (not the server value)
    // because the user is actively editing
    await expect(ta).toHaveValue(/my-custom-pattern/);
    await expect(ta).toHaveValue(/another-custom/);

    // When user blurs, their edits should be committed (not the server's version)
    await ta.blur();

    const storeValue = await page.evaluate(() => {
      const s = (window as Record<string, unknown>).__zustand_settings as
        { getState: () => { clientSettings: Record<string, string> } } | undefined;
      return s?.getState().clientSettings['exec_perm_alwaysAllow'] ?? '[]';
    });
    const patterns = JSON.parse(storeValue as string) as string[];
    expect(patterns).toContain('my-custom-pattern');
    expect(patterns).toContain('another-custom');

    // Clean up (modal is still open from the test)
    await navToPermissions(page);
    const ta2 = getPermTextarea(page);
    await ta2.fill('');
    await ta2.blur();
    await closeSettings(page);
  });

  // ── Bug 4: Rapid open/close/reopen cycle ──────────────────────────────────

  test('rapid open-close-reopen cycle preserves permissions', async () => {
    const page = getPage();

    // Inject initial permissions
    const initialPatterns = ['rapid-test-1', 'rapid-test-2', 'rapid-test-3'];
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(initialPatterns),
      },
    });

    // Rapid open/close cycle (3 times)
    for (let i = 0; i < 3; i++) {
      await openSettings(page);
      await navToPermissions(page);
      const ta = getPermTextarea(page);
      await ta.click(); // focus
      await closeSettings(page); // close without blur
    }

    // Final open — textarea should show correct data
    await openSettings(page);
    await navToPermissions(page);
    const ta = getPermTextarea(page);

    // Inject a push to trigger the value change useEffect
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify([...initialPatterns, 'added-after-cycles']),
      },
    });

    await expect(ta).toHaveValue(/added-after-cycles/, { timeout: 2_000 });
    await expect(ta).toHaveValue(/rapid-test-1/);
    await expect(ta).toHaveValue(/rapid-test-2/);
    await expect(ta).toHaveValue(/rapid-test-3/);

    // Clean up
    await ta.fill('');
    await ta.blur();
    await closeSettings(page);
  });

  // ── Bug 5: Fetch permissions also protected ───────────────────────────────

  test('fetch permissions survive modal close without blur', async () => {
    const page = getPage();

    await injectEvent({
      type: 'client_settings',
      settings: {
        fetch_perm_alwaysAllow: JSON.stringify(['api.github.com', 'api.example.com']),
      },
    });

    await openSettings(page);
    await navToFetchPermissions(page);
    const ta = getPermTextarea(page);
    await expect(ta).toHaveValue(/api\.github\.com/, { timeout: 2_000 });
    await ta.click(); // focus
    await closeSettings(page); // close without blur

    // Inject new fetch permissions
    await injectEvent({
      type: 'client_settings',
      settings: {
        fetch_perm_alwaysAllow: JSON.stringify(['api.github.com', 'api.example.com', 'api.new-domain.com']),
      },
    });

    // Reopen — should show updated list
    await openSettings(page);
    await navToFetchPermissions(page);
    const ta2 = getPermTextarea(page);
    await expect(ta2).toHaveValue(/api\.new-domain\.com/, { timeout: 2_000 });
    await expect(ta2).toHaveValue(/api\.github\.com/);

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await closeSettings(page);
  });

  // ── Bug 6: User edits are committed correctly ─────────────────────────────

  test('user edits in textarea are committed on blur', async () => {
    const page = getPage();

    // Start with known state
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['existing-pattern']),
      },
    });

    await openSettings(page);
    await navToPermissions(page);
    const ta = getPermTextarea(page);
    await expect(ta).toHaveValue(/existing-pattern/, { timeout: 2_000 });

    // User adds a new pattern by typing
    await ta.fill('existing-pattern\nnew-user-pattern');
    await ta.blur();

    // Verify the store has both patterns
    const storeValue = await page.evaluate(() => {
      const s = (window as Record<string, unknown>).__zustand_settings as
        { getState: () => { clientSettings: Record<string, string> } } | undefined;
      return s?.getState().clientSettings['exec_perm_alwaysAllow'] ?? '[]';
    });
    const patterns = JSON.parse(storeValue as string) as string[];
    expect(patterns).toContain('existing-pattern');
    expect(patterns).toContain('new-user-pattern');

    // Clean up (modal is still open from the test)
    await navToPermissions(page);
    const ta2 = getPermTextarea(page);
    await ta2.fill('');
    await ta2.blur();
    await closeSettings(page);
  });

  // ── Bug 7: Switching settings tabs doesn't corrupt permissions ────────────

  test('switching between settings tabs does not lose permission data', async () => {
    const page = getPage();

    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['tab-switch-test-1', 'tab-switch-test-2']),
        fetch_perm_alwaysAllow: JSON.stringify(['fetch-tab-test.com']),
      },
    });

    await openSettings(page);

    // Navigate to Permissions tab, focus textarea
    await navToPermissions(page);
    const execTa = getPermTextarea(page);
    await expect(execTa).toHaveValue(/tab-switch-test-1/, { timeout: 2_000 });
    await execTa.click();

    // Switch to Fetch Permissions tab (without blurring exec textarea first)
    await navToFetchPermissions(page);
    const fetchTa = getPermTextarea(page);
    await expect(fetchTa).toHaveValue(/fetch-tab-test\.com/, { timeout: 2_000 });

    // Switch to Model tab, then back to Permissions
    await page.locator('#settings-nav .settings-nav-item', { hasText: 'Model' }).click();
    await navToPermissions(page);
    const execTa2 = getPermTextarea(page);
    await expect(execTa2).toHaveValue(/tab-switch-test-1/, { timeout: 2_000 });
    await expect(execTa2).toHaveValue(/tab-switch-test-2/);

    // Verify fetch permissions also survived
    await navToFetchPermissions(page);
    const fetchTa2 = getPermTextarea(page);
    await expect(fetchTa2).toHaveValue(/fetch-tab-test\.com/, { timeout: 2_000 });

    // Clean up
    await fetchTa2.fill('');
    await fetchTa2.blur();
    await navToPermissions(page);
    const cleanup = getPermTextarea(page);
    await cleanup.fill('');
    await cleanup.blur();
    await closeSettings(page);
  });

  // ── Bug 8: Escape key close also preserves permissions ────────────────────

  test('closing modal with Escape key while focused does not corrupt permissions', async () => {
    const page = getPage();

    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['escape-test-1', 'escape-test-2']),
      },
    });

    await openSettings(page);
    await navToPermissions(page);
    const ta = getPermTextarea(page);
    await expect(ta).toHaveValue(/escape-test-1/, { timeout: 2_000 });
    await ta.click(); // focus

    // Close with Escape (textarea is focused, so Escape goes to the overlay handler)
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toHaveClass(/\bhidden\b/, { timeout: 2_000 });

    // Inject new value
    await injectEvent({
      type: 'client_settings',
      settings: {
        exec_perm_alwaysAllow: JSON.stringify(['escape-test-1', 'escape-test-2', 'post-escape-add']),
      },
    });

    // Reopen and verify
    await openSettings(page);
    await navToPermissions(page);
    const ta2 = getPermTextarea(page);
    await expect(ta2).toHaveValue(/post-escape-add/, { timeout: 2_000 });
    await expect(ta2).toHaveValue(/escape-test-1/);
    await expect(ta2).toHaveValue(/escape-test-2/);

    // Clean up
    await ta2.fill('');
    await ta2.blur();
    await closeSettings(page);
  });
});
