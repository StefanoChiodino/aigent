/**
 * 17 — Error handling and recovery (injected, no LLM)
 *
 * Tests the error bar display, stream cancellation, and loading state recovery.
 * The `error` event populates #error-bar. It's cleared on the next `connected` event.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { expectHidden } from '../helpers/ui.js';
import { injectEvent } from '../helpers/ws-client.js';

const NOW = new Date().toISOString();

test.describe('Error Handling', () => {
  const getPage = useSharedPage();

  // ── Error bar ──────────────────────────────────────────────────────────────────

  test('error event shows the error bar', async () => {
    const page = getPage();
    await injectEvent({ type: 'error', message: 'Something went wrong' });
    await expect(page.locator('#error-bar')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  test('error bar displays the error message', async () => {
    const page = getPage();
    const msg = 'API rate limit exceeded';
    await injectEvent({ type: 'error', message: msg });
    await expect(page.locator('#error-bar')).toContainText(msg, { timeout: 3_000 });
  });

  test('error bar is hidden initially', async () => {
    const page = getPage();
    await expectHidden(page.locator('#error-bar'));
  });

  test('error bar is cleared when a new error event has empty message', async () => {
    const page = getPage();
    await injectEvent({ type: 'error', message: 'Visible error' });
    await expect(page.locator('#error-bar')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });

    // Injecting a second error with an empty string clears the bar (app hides when errorMsg is falsy)
    await injectEvent({ type: 'error', message: '' });
    await expect(page.locator('#error-bar')).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  // ── Loading state ──────────────────────────────────────────────────────────────

  test('loading event sets data-working attribute on body', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await expect(page.locator('body')).toHaveAttribute('data-working', { timeout: 3_000 });
    // Clean up
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('loading false removes data-working attribute', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await expect(page.locator('body')).toHaveAttribute('data-working', { timeout: 3_000 });
    await injectEvent({ type: 'loading', isLoading: false });
    await expect(page.locator('body')).not.toHaveAttribute('data-working', { timeout: 3_000 });
  });

  test('cancel button is visible while loading', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    // Cancel button (#cancel) should be shown when data-working is set
    await expect(page.locator('#cancel')).not.toHaveClass(/\bhidden\b/, { timeout: 3_000 });
    await injectEvent({ type: 'loading', isLoading: false });
  });

  test('cancel button is hidden when not loading', async () => {
    const page = getPage();
    // Should start hidden
    await expect(page.locator('#cancel')).toHaveClass(/\bhidden\b/, { timeout: 3_000 });
  });

  // ── System messages ────────────────────────────────────────────────────────────

  test('system event appends a system message to the chat', async () => {
    const page = getPage();
    const sysContent = 'Session reset — conversation cleared.';
    await injectEvent({ type: 'system', content: sysContent });
    // Use .last() to check the most recently added system message — previous tests
    // leave system messages in the DOM (no page reload between tests).
    await expect(page.locator('#messages .message.system').last()).toContainText(sysContent, { timeout: 3_000 });
  });

  test('multiple system messages all appear in the chat', async () => {
    const page = getPage();
    const msg1 = 'SysMsg-One-' + Date.now();
    const msg2 = 'SysMsg-Two-' + Date.now();

    await injectEvent({ type: 'system', content: msg1 });
    await injectEvent({ type: 'system', content: msg2 });

    // Both messages should appear in the chat. Consecutive system messages are
    // grouped into a single .message.system box, so check text content rather
    // than element count.
    await expect(page.locator('#messages')).toContainText(msg1, { timeout: 3_000 });
    await expect(page.locator('#messages')).toContainText(msg2, { timeout: 3_000 });
  });
});
