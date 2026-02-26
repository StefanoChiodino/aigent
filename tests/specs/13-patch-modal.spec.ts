/**
 * 13 — Patch permission modal (injected, no LLM)
 *
 * Injects fake patch_request events via POST /test/inject.
 * The patch modal enters "patch-mode" (full-page layout with file list + diff viewer).
 * Title is "Patch: <filename>" for single-file diffs or "Patch: N files" for multi.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

// Minimal unified diff for a single file
const SINGLE_FILE_DIFF = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export { x };
`;

// Two-file diff
const MULTI_FILE_DIFF = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -1,2 +1,3 @@
 export default 0;
+// added comment
`;

test.describe('@fast Patch Permission Modal', () => {
  const getPage = useSharedPage();

  test('patch_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p1', diff: SINGLE_FILE_DIFF, reason: 'Add y variable' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('single-file patch title shows filename', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p2', diff: SINGLE_FILE_DIFF, reason: 'Add variable' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toContainText('foo.ts');
    await page.locator('#perm-deny-btn').click();
  });

  test('single-file patch title starts with "Patch:"', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p3', diff: SINGLE_FILE_DIFF, reason: 'Test' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toContainText('Patch:');
    await page.locator('#perm-deny-btn').click();
  });

  test('multi-file patch title shows file count', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p4', diff: MULTI_FILE_DIFF, reason: 'Multi-file update' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toContainText('2 files');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows reason in the detail area', async () => {
    const page = getPage();
    const reason = 'Refactor variable naming for clarity';
    await injectEvent({ type: 'patch_request', id: 'p5', diff: SINGLE_FILE_DIFF, reason });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText(reason);
    await page.locator('#perm-deny-btn').click();
  });

  test('modal icon is 🩹 for patch requests', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p6', diff: SINGLE_FILE_DIFF, reason: 'Icon test' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('🩹');
    await page.locator('#perm-deny-btn').click();
  });

  test('patch modal enters patch-mode (full-page layout)', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p7', diff: SINGLE_FILE_DIFF, reason: 'Patch mode test' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-overlay')).toHaveClass(/\bpatch-mode\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('patch file list shows the patched filename', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p8', diff: SINGLE_FILE_DIFF, reason: 'File list test' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#patch-file-list')).toContainText('foo.ts');
    await page.locator('#perm-deny-btn').click();
  });

  test('multi-file patch list shows both filenames', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p9', diff: MULTI_FILE_DIFF, reason: 'Multi file list test' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#patch-file-list')).toContainText('foo.ts');
    await expect(page.locator('#patch-file-list')).toContainText('bar.ts');
    await page.locator('#perm-deny-btn').click();
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p10', diff: SINGLE_FILE_DIFF, reason: 'Deny test' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p11', diff: SINGLE_FILE_DIFF, reason: 'Approve test' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Always Allow button is hidden for patch requests', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'p12', diff: SINGLE_FILE_DIFF, reason: 'Always-allow test' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });


  test('word-wrap toggle starts active and toggles class', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'pw1', diff: SINGLE_FILE_DIFF, reason: 'Wrap toggle test' });
    await expectVisible(page.locator('#perm-overlay'));

    const diffPanel = page.locator('#perm-card-diff');
    const wrapBtn = page.locator('#diff-wrap-toggle');

    // Toggle visible and active by default (wrap on)
    await expect(wrapBtn).toBeVisible();
    await expect(wrapBtn).toHaveClass(/\bactive\b/);
    await expect(diffPanel).toHaveClass(/\bwrap-on\b/);

    // Click to disable wrap
    await wrapBtn.click();
    await expect(wrapBtn).not.toHaveClass(/\bactive\b/);
    await expect(diffPanel).not.toHaveClass(/\bwrap-on\b/);

    // Click again to re-enable
    await wrapBtn.click();
    await expect(wrapBtn).toHaveClass(/\bactive\b/);
    await expect(diffPanel).toHaveClass(/\bwrap-on\b/);

    await page.locator('#perm-deny-btn').click();
  });

  test('patch and exec requests queue correctly', async () => {
    const page = getPage();
    await injectEvent({ type: 'patch_request', id: 'pq1', diff: SINGLE_FILE_DIFF, reason: 'queue' });
    await injectEvent({ type: 'exec_request', id: 'pq2', command: 'echo after-patch' });

    // First (patch) visible — icon is 🩹
    await expect(page.locator('#perm-card-icon')).toHaveText('🩹', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();

    // Second (exec) follows immediately
    await expect(page.locator('#perm-card-icon')).toHaveText('⚡', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });
});
