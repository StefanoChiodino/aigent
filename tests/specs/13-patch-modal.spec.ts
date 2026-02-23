/**
 * 13 — Patch permission modal (injected, no LLM)
 *
 * Injects fake patch_request events via POST /test/inject.
 * The patch modal enters "patch-mode" (full-page layout with file list + diff viewer).
 * Title is "Patch: <filename>" for single-file diffs or "Patch: N files" for multi.
 */

import { test, expect } from '@playwright/test';
import { waitForConnected, expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';

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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForConnected(page);
});

test('patch_request shows permission modal', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p1', diff: SINGLE_FILE_DIFF, reason: 'Add y variable' });
  await expectVisible(page.locator('#perm-overlay'));
  await page.locator('#perm-deny-btn').click();
});

test('single-file patch title shows filename', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p2', diff: SINGLE_FILE_DIFF, reason: 'Add variable' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-title')).toContainText('foo.ts');
  await page.locator('#perm-deny-btn').click();
});

test('single-file patch title starts with "Patch:"', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p3', diff: SINGLE_FILE_DIFF, reason: 'Test' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-title')).toContainText('Patch:');
  await page.locator('#perm-deny-btn').click();
});

test('multi-file patch title shows file count', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p4', diff: MULTI_FILE_DIFF, reason: 'Multi-file update' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-title')).toContainText('2 files');
  await page.locator('#perm-deny-btn').click();
});

test('modal shows reason in the detail area', async ({ page }) => {
  const reason = 'Refactor variable naming for clarity';
  await injectEvent({ type: 'patch_request', id: 'p5', diff: SINGLE_FILE_DIFF, reason });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-detail')).toContainText(reason);
  await page.locator('#perm-deny-btn').click();
});

test('modal icon is 🩹 for patch requests', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p6', diff: SINGLE_FILE_DIFF, reason: 'Icon test' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-card-icon')).toHaveText('🩹');
  await page.locator('#perm-deny-btn').click();
});

test('patch modal enters patch-mode (full-page layout)', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p7', diff: SINGLE_FILE_DIFF, reason: 'Patch mode test' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-overlay')).toHaveClass(/\bpatch-mode\b/);
  await page.locator('#perm-deny-btn').click();
});

test('patch file list shows the patched filename', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p8', diff: SINGLE_FILE_DIFF, reason: 'File list test' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#patch-file-list')).toContainText('foo.ts');
  await page.locator('#perm-deny-btn').click();
});

test('multi-file patch list shows both filenames', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p9', diff: MULTI_FILE_DIFF, reason: 'Multi file list test' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#patch-file-list')).toContainText('foo.ts');
  await expect(page.locator('#patch-file-list')).toContainText('bar.ts');
  await page.locator('#perm-deny-btn').click();
});

test('Deny button hides the modal', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p10', diff: SINGLE_FILE_DIFF, reason: 'Deny test' });
  await expectVisible(page.locator('#perm-overlay'));
  await page.locator('#perm-deny-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
});

test('Approve button hides the modal', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p11', diff: SINGLE_FILE_DIFF, reason: 'Approve test' });
  await expectVisible(page.locator('#perm-overlay'));
  await page.locator('#perm-approve-btn').click();
  await expectHidden(page.locator('#perm-overlay'));
});

test('Always Allow button is hidden for patch requests', async ({ page }) => {
  await injectEvent({ type: 'patch_request', id: 'p12', diff: SINGLE_FILE_DIFF, reason: 'Always-allow test' });
  await expectVisible(page.locator('#perm-overlay'));
  await expect(page.locator('#perm-always-allow-btn')).toHaveClass(/\bhidden\b/);
  await page.locator('#perm-deny-btn').click();
});

test('patch and exec requests queue correctly', async ({ page }) => {
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
