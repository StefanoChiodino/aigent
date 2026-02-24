/**
 * 29 — Always-on mic bug fixes:
 *   1. Enabling always-on mic must not delete existing text in the input.
 *   2. Both mic and always-on mic must be off after page reload
 *      (micSticky is not persisted to localStorage).
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { waitForConnected } from '../helpers/ui.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function installMicMock(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const mockState = {
      processorCreated: false,
      sourceConnected: false,
      processorConnected: false,
      processorDisconnected: false,
      streamStopped: false,
      contextClosed: false,
      sampleRate: 16000,
    };

    const mockTrack = {
      stop: () => { mockState.streamStopped = true; },
      kind: 'audio',
      enabled: true,
    };
    const mockStream = {
      getTracks: () => [mockTrack],
      getAudioTracks: () => [mockTrack],
    };

    const mockProcessor = {
      onaudioprocess: null as ((e: unknown) => void) | null,
      connect: () => { mockState.processorConnected = true; },
      disconnect: () => { mockState.processorDisconnected = true; },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const mockSource = {
      connect: () => { mockState.sourceConnected = true; },
      disconnect: () => {},
    };

    // @ts-expect-error override for testing
    window.AudioContext = class MockAudioContext {
      sampleRate = mockState.sampleRate;
      destination = {};
      currentTime = 0;
      state = 'running';

      createMediaStreamSource() { return mockSource; }
      createScriptProcessor() {
        mockState.processorCreated = true;
        return mockProcessor;
      }
      createOscillator() {
        return {
          connect: () => {},
          frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
          start: () => {},
          stop: () => {},
          onended: null,
        };
      }
      createGain() {
        return {
          connect: () => {},
          gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
        };
      }
      close() {
        mockState.contextClosed = true;
        return Promise.resolve();
      }
    };

    // @ts-expect-error override for testing
    navigator.mediaDevices.getUserMedia = async () => mockStream;

    // @ts-expect-error test mock
    window.__micMock = {
      state: mockState,
      mockProcessor,
      fireAudioFrame(rms: number) {
        const handler = mockProcessor.onaudioprocess;
        if (!handler) return;
        const bufferSize = 4096;
        const data = new Float32Array(bufferSize);
        for (let i = 0; i < bufferSize; i++) data[i] = rms;
        handler({ inputBuffer: { getChannelData: () => data } });
      },
      getState() { return { ...mockState }; },
    };
  });
}

async function mockSTT(page: import('@playwright/test').Page, text: string) {
  await page.route('**/stt', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ text }),
  }));
}

async function fireLoudFrames(page: import('@playwright/test').Page, n: number) {
  await page.evaluate((count) => {
    const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
    for (let i = 0; i < count; i++) mock.fireAudioFrame(0.1);
  }, n);
}

// ── Bug 1: Sticky mic must preserve existing text ─────────────────────────

test.describe('Always-on mic preserves existing input text', () => {
  const getPage = useSharedPage();

  test('clicking sticky button does not delete existing text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'dictated words');
    const input = page.locator('#input');
    const sticky = page.locator('#mic-sticky');

    // Type some text first
    await input.fill('existing text ');

    // Enable always-on mic
    await sticky.click();
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech and wait for transcription
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue(/existing text/, { timeout: 5000 });
    // Transcription is appended after existing text
    await expect(input).toHaveValue('existing text dictated words', { timeout: 5000 });
  });

  test('Ctrl+Backtick preserves existing text when starting mic', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'voice input');
    const input = page.locator('#input');

    // Type some text
    await input.fill('typed stuff ');

    // Start mic via Ctrl+`
    await page.keyboard.press('Control+Backquote');
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('typed stuff voice input', { timeout: 5000 });
  });

  test('clicking mic button preserves existing text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'spoken part');
    const input = page.locator('#input');
    const mic = page.locator('#mic');

    // Type some text
    await input.fill('written part ');

    // Start mic via button click
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('written part spoken part', { timeout: 5000 });
  });

  test('Ctrl+Shift+Backtick sticky shortcut preserves existing text', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'added by mic');
    const input = page.locator('#input');

    // Type some text
    await input.fill('already here ');

    // Enable sticky via keyboard shortcut
    await page.keyboard.press('Control+Shift+Backquote');
    await expect(page.locator('#mic-sticky')).toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(page.locator('#mic')).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    await expect(input).toHaveValue('already here added by mic', { timeout: 5000 });
  });

  test('starting mic with empty input still works normally', async () => {
    const page = getPage();
    await installMicMock(page);
    await mockSTT(page, 'fresh dictation');
    const input = page.locator('#input');
    const mic = page.locator('#mic');

    // Start mic with empty input
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Simulate speech
    await fireLoudFrames(page, 5);
    // Should show just the dictation with no leading space
    await expect(input).toHaveValue('fresh dictation', { timeout: 5000 });
  });
});

// ── Bug 2: Sticky mic must not persist across page reload ─────────────────

test.describe('Always-on mic resets on page reload', () => {
  // Cannot use shared page for reload tests — need fresh page lifecycle control
  test('micSticky and mic are both off after page reload', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await waitForConnected(page);
    await installMicMock(page);

    const sticky = page.locator('#mic-sticky');
    const mic = page.locator('#mic');

    // Enable sticky mode
    await sticky.click();
    await expect(sticky).toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

    // Reload the page
    await page.reload();
    await waitForConnected(page);

    // Both should be off after reload
    await expect(page.locator('#mic-sticky')).not.toHaveClass(/\bactive\b/, { timeout: 3000 });
    await expect(page.locator('#mic')).not.toHaveClass(/\brecording\b/, { timeout: 3000 });
    // Mic button should show the idle mic icon
    await expect(page.locator('#mic .icon-mic')).toBeVisible({ timeout: 3000 });

    await page.close();
  });

  test('micSticky is not in localStorage after enabling and reloading', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/');
    await waitForConnected(page);
    await installMicMock(page);

    // Enable sticky mode
    await page.locator('#mic-sticky').click();
    await expect(page.locator('#mic-sticky')).toHaveClass(/\bactive\b/, { timeout: 3000 });

    // Check that micSticky is NOT persisted in localStorage
    const stored = await page.evaluate(() => {
      const raw = localStorage.getItem('aigent-voice');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed?.state?.micSticky ?? null;
    });
    // micSticky should not be in the persisted state
    expect(stored).toBeNull();

    await page.close();
  });
});
