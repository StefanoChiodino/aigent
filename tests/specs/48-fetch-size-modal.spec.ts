/**
 * 48 — Fetch size permission modal (injected, no LLM)
 *
 * Injects fake fetch_size_request events via POST /test/inject.
 * Verifies the modal shows with correct icon, title, size info, and buttons.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Fetch Size Permission Modal', () => {
  const getPage = useSharedPage();

  test('fetch_size_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_size_request', id: 'fs1', url: 'https://example.com/big.json', requestedBytes: 5 * 1024 * 1024, defaultBytes: 1024 * 1024 });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows the size and URL in the detail area', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_size_request', id: 'fs2', url: 'https://api.example.com/large', requestedBytes: 5 * 1024 * 1024, defaultBytes: 1024 * 1024 });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('5.0 MB');
    await expect(page.locator('#perm-card-detail')).toContainText('api.example.com');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal title is "Large Fetch"', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_size_request', id: 'fs3', url: 'https://example.com/data', requestedBytes: 3 * 1024 * 1024, defaultBytes: 1024 * 1024 });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('Large Fetch');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal icon shows package emoji', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_size_request', id: 'fs4', url: 'https://example.com/data', requestedBytes: 2 * 1024 * 1024, defaultBytes: 1024 * 1024 });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('📦');
    await page.locator('#perm-deny-btn').click();
  });

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_size_request', id: 'fs5', url: 'https://example.com/data', requestedBytes: 2 * 1024 * 1024, defaultBytes: 1024 * 1024 });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_size_request', id: 'fs6', url: 'https://example.com/data', requestedBytes: 2 * 1024 * 1024, defaultBytes: 1024 * 1024 });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });
});
