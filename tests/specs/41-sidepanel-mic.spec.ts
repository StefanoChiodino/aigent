/**
 * 41 — Sidepanel mic sync via BroadcastChannel + window events
 *
 * Verifies that:
 * 1. Mic start/stop window events (dispatched by executeScript in the real
 *    extension) trigger recording in the main tab.
 * 2. The BroadcastChannel broadcasts micState back to the sidepanel page.
 * 3. Sticky-toggle event works the same way.
 *
 * We simulate the extension background by dispatching custom window events
 * directly — the same events that executeScript would inject.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { installMicMock, mockSTT, fireLoudFrames } from '../helpers/mic-mock.js';

const FAKE_EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

test.describe('@fast Sidepanel mic sync', () => {
  const getPage = useSharedPage();

  // ── Main tab receives window events and starts/stops mic ─────────────────

  test('aigent-mic-activate event starts recording', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');

    // Simulate executeScript injecting the start event
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('aigent-mic-activate'));
    });

    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });
  });

  test('aigent-mic-stop event stops recording', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');

    // Start via event
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aigent-mic-activate')));
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Stop via event
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aigent-mic-stop')));
    await expect(page.locator('#mic')).not.toHaveClass(/\brecording\b/, { timeout: 3000 });
  });

  test('aigent-mic-sticky-toggle event enables sticky mic', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aigent-mic-sticky-toggle')));

    await expect(page.locator('#mic-sticky')).toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });
  });

  // ── BroadcastChannel syncs state from main tab to sidepanel ─────────────
  // Note: BroadcastChannel works in real Chrome between tabs/iframes of the same origin,
  // but Playwright isolates pages in separate renderer processes so cross-page BC tests
  // are not feasible here. We test the broadcast logic unit-style instead.

  test('main tab broadcasts mic-state when micState changes', async () => {
    // Verify the main tab (no extId) sends on the BroadcastChannel when mic state changes.
    // We install a raw BroadcastChannel listener on the same page and check it fires.
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, '');

    const received: unknown[] = [];
    await page.evaluate(() => {
      const ch = new BroadcastChannel('aigent-mic');
      ch.onmessage = (e) => {
        const w = window as Record<string, unknown>;
        if (!w.__bcMessages) w.__bcMessages = [];
        (w.__bcMessages as unknown[]).push(e.data);
      };
    });

    await page.evaluate(() => window.dispatchEvent(new CustomEvent('aigent-mic-activate')));
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Give React a tick to fire the broadcast effect
    await page.waitForTimeout(200);

    const messages = await page.evaluate(
      () => (window as Record<string, unknown>).__bcMessages as unknown[] ?? []
    );
    received.push(...messages);

    // Should have received a mic-state broadcast with micState='recording'
    const stateMsg = received.find(
      (m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>)['type'] === 'mic-state'
    ) as Record<string, unknown> | undefined;
    expect(stateMsg).toBeDefined();
    expect(stateMsg!['micState']).toBe('recording');
  });

  test('sidepanel page updates store when receiving mic-state broadcast', async ({ baseURL, context }) => {
    // Verify the sidepanel (extId present) listens to BroadcastChannel and updates its store.
    // We open a sidepanel page and inject a broadcast message directly.
    const sidepanel = await context.newPage();

    try {
      await sidepanel.goto(`${baseURL}/?extId=${FAKE_EXT_ID}`);
      await sidepanel.waitForFunction(
        () => document.getElementById('root') !== null && document.getElementById('root')!.children.length > 0,
        undefined,
        { timeout: 10_000 }
      );

      // Inject a mic-state broadcast directly into the sidepanel page's own channel
      // (simulates what the main tab would send)
      await sidepanel.evaluate(() => {
        const ch = new BroadcastChannel('aigent-mic');
        ch.postMessage({ type: 'mic-state', micState: 'recording', vadActive: false, micSticky: false });
        ch.close();
      });

      // The sidepanel's listener should update the store → re-render → mic button shows recording
      await expect(sidepanel.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });
    } finally {
      await sidepanel.close();
    }
  });

  test('sidepanel updates input when receiving mic-transcript broadcast', async ({ baseURL, context }) => {
    const sidepanel = await context.newPage();

    try {
      await sidepanel.goto(`${baseURL}/?extId=${FAKE_EXT_ID}`);
      await sidepanel.waitForFunction(
        () => document.getElementById('root') !== null && document.getElementById('root')!.children.length > 0,
        undefined,
        { timeout: 10_000 }
      );

      await sidepanel.evaluate(() => {
        const ch = new BroadcastChannel('aigent-mic');
        ch.postMessage({ type: 'mic-transcript', text: 'hello from broadcast', windowCapped: false });
        ch.close();
      });

      await expect(sidepanel.locator('#input')).toHaveValue('hello from broadcast', { timeout: 3000 });
    } finally {
      await sidepanel.close();
    }
  });

  // ── Sidepanel postMessage → background → executeScript flow ──────────────

  test('sidepanel page postMessage with aigent- prefix is relayed correctly', async ({ context, baseURL }) => {
    // This tests that the sidepanel iframe sends window.parent.postMessage
    // when its mic button is clicked (isSidepanel=true path).
    const sidepanel = await context.newPage();

    try {
      await sidepanel.goto(`${baseURL}/?extId=${FAKE_EXT_ID}`);
      await sidepanel.waitForFunction(
        () => document.getElementById('root') !== null && document.getElementById('root')!.children.length > 0,
        undefined,
        { timeout: 10_000 }
      );

      // Capture postMessage calls to parent
      const messages: string[] = [];
      await sidepanel.evaluate(() => {
        const orig = window.parent.postMessage.bind(window.parent);
        window.parent.postMessage = (data: unknown, ...args: unknown[]) => {
          if (typeof data === 'object' && data !== null && 'type' in data) {
            (window as Record<string, unknown>).__capturedMessages =
              [...((window as Record<string, unknown>).__capturedMessages as string[] ?? []), (data as { type: string }).type];
          }
          // @ts-ignore
          orig(data, ...args);
        };
      });

      // Click the mic button — in sidepanel context this calls sendExtMicCmd
      await sidepanel.locator('#mic').click();

      const captured = await sidepanel.evaluate(() =>
        (window as Record<string, unknown>).__capturedMessages as string[] ?? []
      );
      messages.push(...captured);

      expect(messages).toContain('aigent-mic-activate');
    } finally {
      await sidepanel.close();
    }
  });
});
