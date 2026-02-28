/**
 * Shared microphone mock for Playwright e2e tests.
 *
 * Provides a mock implementation of getUserMedia, AudioContext, and
 * AudioWorkletNode so tests can drive the mic lifecycle without
 * actual hardware (headless Chromium has no real microphone).
 *
 * Exposes `window.__micMock` with controls:
 *   - fireAudioFrame(rms): simulate an AudioWorklet port message
 *   - getState(): returns { processorCreated, sourceConnected, … }
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Inject the full mic/AudioContext mock into the page. */
export async function installMicMock(page: Page) {
  await page.evaluate(() => {
    const mockState = {
      processorCreated: false,
      sourceConnected: false,
      processorConnected: false,
      processorDisconnected: false,
      streamStopped: false,
      contextClosed: false,
      workletModuleLoaded: false,
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

    const mockPort = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      postMessage: () => {},
    };

    const mockSource = {
      connect: (_dest: unknown) => { mockState.sourceConnected = true; mockState.processorConnected = true; },
      disconnect: () => {},
    };

    // @ts-expect-error override for testing
    window.AudioWorkletNode = class MockAudioWorkletNode {
      port = mockPort;
      connect() {}
      disconnect() { mockState.processorDisconnected = true; }
      addEventListener() {}
      removeEventListener() {}
    };

    // @ts-expect-error override for testing
    window.AudioContext = class MockAudioContext {
      sampleRate = mockState.sampleRate;
      destination = {};
      currentTime = 0;
      state = 'running';

      audioWorklet = {
        addModule: (_url: string) => {
          mockState.workletModuleLoaded = true;
          mockState.processorCreated = true;
          return Promise.resolve();
        },
      };

      createMediaStreamSource() { return mockSource; }
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
      mockPort,
      fireAudioFrame(rms: number) {
        const handler = mockPort.onmessage;
        if (!handler) return;
        const bufferSize = 4096;
        const samples = new Float32Array(bufferSize);
        for (let i = 0; i < bufferSize; i++) samples[i] = rms;
        handler(new MessageEvent('message', { data: { samples, rms } }));
      },
      getState() { return { ...mockState }; },
    };
  });
}

/** Inject mock audio devices so enumerateDevices() returns them. */
export async function mockEnumerateDevices(
  page: Page,
  devices: Array<{ deviceId: string; label: string; kind: string; groupId?: string }>,
) {
  await page.evaluate((devs) => {
    (navigator.mediaDevices as any).enumerateDevices = () =>
      Promise.resolve(devs.map(d => ({ ...d, groupId: d.groupId ?? '', toJSON: () => d })));
  }, devices);
}

/** Fire the devicechange event so DevicePicker re-enumerates. */
export async function fireDeviceChangeEvent(page: Page) {
  await page.evaluate(() => {
    navigator.mediaDevices.dispatchEvent(new Event('devicechange'));
  });
}

/** Mock the /stt endpoint to return a canned transcription. */
export async function mockSTT(page: Page, text: string) {
  await page.route('**/stt', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ text }),
  }));
}

/** Mock the /stt endpoint to return after a delay. */
export async function mockSTTDelayed(page: Page, text: string, delayMs: number) {
  await page.route('**/stt', async route => {
    await new Promise(r => setTimeout(r, delayMs));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text }),
    });
  });
}

/** Fire `n` loud audio frames (RMS 0.1) in the browser mock. */
export async function fireLoudFrames(page: Page, n: number) {
  await page.evaluate((count) => {
    const mock = (window as unknown as { __micMock: { fireAudioFrame: (rms: number) => void } }).__micMock;
    for (let i = 0; i < count; i++) mock.fireAudioFrame(0.1);
  }, n);
}

/**
 * Start recording, generate speech, and wait for transcription to appear.
 * Calls installMicMock + mockSTT internally, so don't call those before this.
 */
export async function startRecordingWithText(page: Page, text: string) {
  await installMicMock(page);
  await mockSTT(page, text);
  const mic = page.locator('#mic');

  await mic.click();
  await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3000 });

  await fireLoudFrames(page, 5);
  await expect(page.locator('#input')).toHaveValue(text, { timeout: 5000 });
}

/**
 * Number of loud mock audio frames needed to exceed MIC_WINDOW_SAMPLES.
 * Each frame is 4 096 samples at 16 kHz.
 * 48 * 4 096 = 196 608 > 192 000.
 */
export const FRAMES_TO_EXCEED_WINDOW = 48;
