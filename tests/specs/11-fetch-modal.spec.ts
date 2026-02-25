/**
 * 11 — Fetch permission modal (injected, no LLM)
 *
 * Injects fake fetch_request events via POST /test/inject.
 */

import { test, expect } from '@playwright/test';
import { expectVisible, expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('@fast Fetch Permission Modal', () => {
  const getPage = useSharedPage();

  test('fetch_request shows permission modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f1', url: 'https://google.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows the URL in the detail area', async () => {
    const page = getPage();
    const url = 'https://api.example.com/data';
    await injectEvent({ type: 'fetch_request', id: 'f2', url });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText(url);
    await page.locator('#perm-deny-btn').click();
  });

  test('modal shows the HTTP method in the detail area', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f3', url: 'https://api.example.com/data', method: 'POST' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('POST');
    await page.locator('#perm-deny-btn').click();
  });

  test('defaults to GET when no method is specified', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f4', url: 'https://example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-detail')).toContainText('GET');
    await page.locator('#perm-deny-btn').click();
  });

  test('Deny button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f5', url: 'https://example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Approve button hides the modal', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f6', url: 'https://example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await page.locator('#perm-approve-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });

  test('Always Allow button is visible for fetch requests', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f7', url: 'https://example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-always-allow-btn')).not.toHaveClass(/\bhidden\b/);
    await expect(page.locator('#perm-always-allow-domain-btn')).not.toHaveClass(/\bhidden\b/);
    await page.locator('#perm-deny-btn').click();
  });

  test('modal icon shows globe emoji for fetch requests', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f8', url: 'https://example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-icon')).toHaveText('🌐');
    await page.locator('#perm-deny-btn').click();
  });

  test('modal title is "Fetch URL"', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'f9', url: 'https://example.com/' });
    await expectVisible(page.locator('#perm-overlay'));
    await expect(page.locator('#perm-card-title')).toHaveText('Fetch URL');
    await page.locator('#perm-deny-btn').click();
  });

  test('sequential fetch requests each show the correct URL', async () => {
    const page = getPage();
    const url1 = 'https://first.example.com/api';
    const url2 = 'https://second.example.com/api';

    await injectEvent({ type: 'fetch_request', id: 'fseq1', url: url1 });
    await expect(page.locator('#perm-card-detail')).toContainText(url1, { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));

    await injectEvent({ type: 'fetch_request', id: 'fseq2', url: url2 });
    await expect(page.locator('#perm-card-detail')).toContainText(url2, { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
  });

  test('fetch and exec requests queue correctly', async () => {
    const page = getPage();
    await injectEvent({ type: 'fetch_request', id: 'fq1', url: 'https://example.com/' });
    await injectEvent({ type: 'exec_request', id: 'fq2', command: 'echo queue-test' });

    // First (fetch) visible
    await expect(page.locator('#perm-card-icon')).toHaveText('🌐', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();

    // Second (exec) shows immediately — queue advances without hiding the overlay
    await expect(page.locator('#perm-card-icon')).toHaveText('⚡', { timeout: 5_000 });
    await page.locator('#perm-deny-btn').click();
    await expectHidden(page.locator('#perm-overlay'));
  });
});
