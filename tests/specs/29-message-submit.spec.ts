/**
 * 29 — Message submission: verifies that typing text and pressing Enter
 * actually sends a WebSocket message and clears the input.
 *
 * This test intercepts WebSocket frames to assert that the browser
 * sends the correct {type:"message"} payload. It does NOT require
 * an LLM response — it only checks the outgoing direction.
 *
 * This is the test that catches "user can't send messages" regressions.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';

test.describe('Message submission', () => {
  const getPage = useSharedPage();

  test('Enter sends a WebSocket message with the input text', async () => {
    const page = getPage();
    const input = page.locator('#input');

    // Intercept outgoing WebSocket frames by patching ws.send on the client
    const sent = await page.evaluate(() => {
      return new Promise<string[]>((resolve) => {
        const collected: string[] = [];
        const origSend = WebSocket.prototype.send;
        WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          collected.push(typeof data === 'string' ? data : '(binary)');
          return origSend.call(this, data);
        };
        // Expose resolver so we can flush from outside
        (window as Record<string, unknown>).__wsSentCollected = collected;
        (window as Record<string, unknown>).__wsSentResolve = resolve;
        // Restore after a timeout to not permanently break the WS
        setTimeout(() => {
          WebSocket.prototype.send = origSend;
        }, 5_000);
        resolve(collected);
      });
    });

    // Type and submit
    await input.fill('hello from e2e test');
    await input.press('Enter');

    // Wait a moment for the WS frame to be captured
    await page.waitForTimeout(200);

    // Read captured frames
    const frames = await page.evaluate(() => {
      return (window as Record<string, unknown>).__wsSentCollected as string[];
    });

    // Find our message in the captured frames
    const msgFrame = frames.find(f => {
      try {
        const parsed = JSON.parse(f);
        return parsed.type === 'message' && parsed.content === 'hello from e2e test';
      } catch { return false; }
    });

    expect(msgFrame).toBeDefined();
  });

  test('input clears after Enter submit', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await input.fill('will be cleared');
    await input.press('Enter');
    await expect(input).toHaveValue('', { timeout: 2_000 });
  });

  test('clicking send button sends the message', async () => {
    const page = getPage();
    const input = page.locator('#input');

    // Set up frame capture
    await page.evaluate(() => {
      const collected: string[] = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        collected.push(typeof data === 'string' ? data : '(binary)');
        return origSend.call(this, data);
      };
      (window as Record<string, unknown>).__wsSentCollected2 = collected;
      setTimeout(() => { WebSocket.prototype.send = origSend; }, 5_000);
    });

    await input.fill('click submit');
    await page.locator('#send').click();

    await page.waitForTimeout(200);

    const frames = await page.evaluate(() => {
      return (window as Record<string, unknown>).__wsSentCollected2 as string[];
    });

    const msgFrame = frames.find(f => {
      try {
        const parsed = JSON.parse(f);
        return parsed.type === 'message' && parsed.content === 'click submit';
      } catch { return false; }
    });

    expect(msgFrame).toBeDefined();
  });

  test('empty input does NOT send on Enter', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await page.evaluate(() => {
      const collected: string[] = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        collected.push(typeof data === 'string' ? data : '(binary)');
        return origSend.call(this, data);
      };
      (window as Record<string, unknown>).__wsSentEmpty = collected;
      setTimeout(() => { WebSocket.prototype.send = origSend; }, 5_000);
    });

    // Ensure input is empty
    await input.fill('');
    await input.press('Enter');

    await page.waitForTimeout(200);

    const frames = await page.evaluate(() => {
      return (window as Record<string, unknown>).__wsSentEmpty as string[];
    });

    const msgFrame = frames.find(f => {
      try {
        const parsed = JSON.parse(f);
        return parsed.type === 'message';
      } catch { return false; }
    });

    expect(msgFrame).toBeUndefined();
  });

  test('Shift+Enter does NOT send', async () => {
    const page = getPage();
    const input = page.locator('#input');

    await page.evaluate(() => {
      const collected: string[] = [];
      const origSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        collected.push(typeof data === 'string' ? data : '(binary)');
        return origSend.call(this, data);
      };
      (window as Record<string, unknown>).__wsSentShift = collected;
      setTimeout(() => { WebSocket.prototype.send = origSend; }, 5_000);
    });

    await input.fill('not yet');
    await input.press('Shift+Enter');

    await page.waitForTimeout(200);

    const frames = await page.evaluate(() => {
      return (window as Record<string, unknown>).__wsSentShift as string[];
    });

    const msgFrame = frames.find(f => {
      try {
        const parsed = JSON.parse(f);
        return parsed.type === 'message';
      } catch { return false; }
    });

    expect(msgFrame).toBeUndefined();
  });
});
