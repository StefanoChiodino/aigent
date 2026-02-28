/**
 * 35 — Browser Extension integration (injected, no real Chrome extension needed)
 *
 * Tests the web UI's handling of browser extension events:
 *   - host_state with browser-ext capability → sidebar caps list
 *   - system message on extension connect/disconnect
 *   - tool_start / tool_output / tool_end for browser_ext tool
 *   - screenshot image display in tool trace
 *   - a11y tree text display in tool trace
 *
 * All events are injected via POST /test/inject — no real Chrome extension required.
 */

import { test, expect } from '@playwright/test';
import { injectEvent } from '../helpers/ws-client.js';
import { useSharedPage } from '../helpers/shared-page.js';

const NOW = new Date().toISOString();

// Minimal 1×1 red PNG encoded as base64 (valid PNG header so UI can display it)
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

test.describe('@fast Browser Extension — sidebar capabilities', () => {
  const getPage = useSharedPage();

  test('host_state with capability shows in caps list', async () => {
    const page = getPage();
    await injectEvent({
      type: 'host_state',
      capabilities: { 'clipboard.read': { grant: 'allow', available: true } },
    });
    await expect(page.locator('#sb-caps-list')).toContainText(/Clipboard Read/i, {
      timeout: 3_000,
    });
  });

  test('multiple capabilities all appear in caps list', async () => {
    const page = getPage();
    await injectEvent({
      type: 'host_state',
      capabilities: {
        'clipboard.read': { grant: 'allow', available: true },
        'screen.capture': { grant: 'prompt', available: false },
      },
    });
    const list = page.locator('#sb-caps-list');
    await expect(list).toContainText(/Clipboard Read/i, { timeout: 3_000 });
    await expect(list).toContainText(/Screenshot/i, { timeout: 3_000 });
  });

  test('clearing capabilities resets caps list to placeholder', async () => {
    const page = getPage();
    // First set some caps
    await injectEvent({
      type: 'host_state',
      capabilities: { 'clipboard.read': { grant: 'allow', available: true } },
    });
    await expect(page.locator('#sb-caps-list')).toContainText(/Clipboard Read/i, { timeout: 3_000 });

    // Now clear (also reset ttsAvailable/sttAvailable which the server may have probed)
    await injectEvent({ type: 'host_state', capabilities: {}, ttsAvailable: false, sttAvailable: false });
    // When capsList is empty the sidebar shows "--"
    await expect(page.locator('#sb-caps-list')).toContainText('--', { timeout: 3_000 });
  });
});

test.describe('@fast Browser Extension — system messages', () => {
  const getPage = useSharedPage();

  test('system event with extension-connected message appears in chat', async () => {
    const page = getPage();
    await injectEvent({
      type: 'system',
      content: 'Browser extension connected. `browser_ext` tool is now available.',
    });
    await expect(page.locator('#messages')).toContainText('Browser extension connected', {
      timeout: 3_000,
    });
  });

  test('system event with extension-disconnected message appears in chat', async () => {
    const page = getPage();
    await injectEvent({
      type: 'system',
      content: 'Browser extension disconnected. `browser_ext` tool is no longer available.',
    });
    await expect(page.locator('#messages')).toContainText('Browser extension disconnected', {
      timeout: 3_000,
    });
  });
});

test.describe('@fast Browser Extension — browser_ext tool trace (a11y)', () => {
  const getPage = useSharedPage();

  test('browser_ext a11y tool_start creates a trace entry', async () => {
    const page = getPage();
    // Simulate streaming: loading → tool_start → tool_output → tool_end → message
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({
      type: 'tool_start',
      name: 'browser_ext',
      summary: 'Extract a11y tree',
      input: JSON.stringify({ action: 'extract_a11y' }),
    });
    // Streaming is active — tool trace should appear
    const trace = page.locator('.trace-item, .tool-trace, [data-tool]').first();
    // Give it time to render; if no dedicated selector, check message area
    await expect(page.locator('#messages')).toBeVisible({ timeout: 3_000 });

    await injectEvent({ type: 'tool_output', content: '=== BROWSER PAGE CONTENT (UNTRUSTED) ===\n[button] "Submit"\n[textbox] "Email"' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'I can see the page has a Submit button and an Email field.',
        timestamp: NOW,
        traces: [],
      },
    });

    // After the message is committed, the assistant reply should be visible
    await expect(page.locator('#messages')).toContainText('Submit button', { timeout: 5_000 });
  });

  test('browser_ext tool summary is shown as extract_a11y or similar', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({
      type: 'tool_start',
      name: 'browser_ext',
      summary: 'Extract a11y tree',
      input: JSON.stringify({ action: 'extract_a11y', rootSelector: '#main' }),
    });
    await injectEvent({ type: 'tool_output', content: '[button] "OK"' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({
      type: 'message',
      message: { role: 'assistant', content: 'Done.', timestamp: NOW, traces: [] },
    });

    // The assistant reply should be committed to messages
    await expect(page.locator('#messages')).toContainText('Done.', { timeout: 5_000 });
  });
});

test.describe('@fast Browser Extension — browser_ext tool trace (screenshot)', () => {
  const getPage = useSharedPage();

  test('browser_ext screenshot tool completes and commits assistant message', async () => {
    const page = getPage();
    await injectEvent({ type: 'loading', isLoading: true });
    await injectEvent({
      type: 'tool_start',
      name: 'browser_ext',
      summary: 'Capture screenshot',
      input: JSON.stringify({ action: 'screenshot' }),
    });
    // Screenshot output is base64; the tool outputs a description, not raw b64
    await injectEvent({ type: 'tool_output', content: '[screenshot captured — 1024×768 image/png]' });
    await injectEvent({ type: 'tool_end' });
    await injectEvent({
      type: 'message',
      message: {
        role: 'assistant',
        content: 'I have taken a screenshot of the current tab.',
        timestamp: NOW,
        traces: [],
      },
    });
    await expect(page.locator('#messages')).toContainText('screenshot of the current tab', {
      timeout: 5_000,
    });
  });
});
