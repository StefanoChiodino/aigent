/**
 * 04 — Mount permission modal (injected, no LLM)
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

const TEST_PATH = '/tmp/aigent-test-mount';

test.describe('@fast Mount Permission Modal', () => {
  const getPage = useSharedPage();

  test('mount_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm1', path: TEST_PATH, mode: 'ro' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows the requested path', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm2', path: TEST_PATH, mode: 'ro', reason: 'test read access' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText(TEST_PATH);
    await page.locator('#perm-deny-btn').click();
  });

  test('modal indicates read-only mode in title', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm3', path: TEST_PATH, mode: 'ro' });
    await expectVisible(page.locator('#perm-overlay'));
    // Title is rendered as "Mount Request (ro)"
    await expect(page.locator('#perm-card-title')).toContainText('ro');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal indicates read-write mode in title', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm4', path: TEST_PATH, mode: 'rw' });
    await expectVisible(page.locator('#perm-overlay'));
    // Title is rendered as "Mount Request (rw)"
    await expect(page.locator('#perm-card-title')).toContainText('rw');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows reason when provided', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm5', path: TEST_PATH, mode: 'ro', reason: 'need workspace files' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-body')).toContainText('need workspace files');
    await page.locator('#perm-deny-btn').click();
  });

  test('Deny button hides mount modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm6', path: TEST_PATH, mode: 'ro' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Approve button hides mount modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm7', path: TEST_PATH, mode: 'ro' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('duration badge shown when durationMinutes is set', async () => {
    const page = getPage();
    await injectEvent({ type: 'mount_request', id: 'm8', path: TEST_PATH, mode: 'ro', durationMinutes: 30 });
    await expectVisible(page.locator('#perm-overlay'));
    // Duration badge should be visible
    await expect(page.locator('#perm-card-duration')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('exec and mount requests queue correctly', async () => {
    const page = getPage();
    // Inject one of each — second should appear after first is dismissed
    await injectEvent({ type: 'exec_request', id: 'q1', command: 'echo queue-test' });
    await injectEvent({ type: 'mount_request', id: 'q2', path: '/tmp/queue', mode: 'ro' });

    // First one visible
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();

    // Second should appear
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });
});
