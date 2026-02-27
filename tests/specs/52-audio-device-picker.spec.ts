/**
 * 52 — Audio device picker: sidebar device selectors for mic (STT) and
 *       speaker (TTS), persistence in voice store, and mic deviceId wiring.
 */

import { test, expect } from '@playwright/test';
import { useSharedPage } from '../helpers/shared-page.js';
import { injectEvent } from '../helpers/ws-client.js';
import {
  mockSTT,
  mockEnumerateDevices,
  fireDeviceChangeEvent,
} from '../helpers/mic-mock.js';

const MOCK_DEVICES = [
  { deviceId: 'mic-aaa', label: 'USB Microphone', kind: 'audioinput' },
  { deviceId: 'mic-bbb', label: 'Built-in Mic', kind: 'audioinput' },
  { deviceId: 'spk-aaa', label: 'HDMI Speakers', kind: 'audiooutput' },
  { deviceId: 'spk-bbb', label: 'Headphones', kind: 'audiooutput' },
];

test.describe('@fast Audio device picker', () => {
  const getPage = useSharedPage();

  /**
   * Install mock enumerateDevices FIRST, then enable TTS+STT flags.
   * The picker enumerates on mount (useEffect), so the mock must already
   * be in place before the component renders. Fire devicechange to ensure
   * the picker picks up the mocked list.
   */
  async function enableVoiceServices(page: import('@playwright/test').Page) {
    await mockEnumerateDevices(page, MOCK_DEVICES);
    await injectEvent({
      type: 'host_state',
      mounts: [],
      capabilities: {},
      ttsAvailable: true,
      sttAvailable: true,
    });
    // Wait for the pickers to render, then fire devicechange so they
    // re-enumerate with the mock in place.
    await page.waitForSelector('.sb-device-select', { timeout: 3_000 });
    await fireDeviceChangeEvent(page);
    // Give the async enumerateDevices a moment to resolve
    await page.waitForTimeout(200);
  }

  /** Helper to read all <option> text from a <select> */
  async function getOptionTexts(page: import('@playwright/test').Page, selectLocator: import('@playwright/test').Locator) {
    return selectLocator.evaluate((el: HTMLSelectElement) =>
      Array.from(el.options).map(o => o.text),
    );
  }

  /** Helper to read all <option> values from a <select> */
  async function getOptionValues(page: import('@playwright/test').Page, selectLocator: import('@playwright/test').Locator) {
    return selectLocator.evaluate((el: HTMLSelectElement) =>
      Array.from(el.options).map(o => o.value),
    );
  }

  // ── Visibility ──────────────────────────────────────────────────────────────

  test('device pickers are hidden when TTS/STT are unavailable', async () => {
    const page = getPage();
    await page.evaluate(() => {
      (window as any).__zustand_ui.getState().setTtsAvailable(false);
      (window as any).__zustand_ui.getState().setSttAvailable(false);
    });
    await expect(page.locator('.sb-device-select')).toHaveCount(0);
  });

  test('speaker picker appears when TTS is available', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const speakerRow = page.locator('.sb-device-row').filter({ hasText: 'Speaker' });
    await expect(speakerRow).toBeVisible({ timeout: 3_000 });
    await expect(speakerRow.locator('.sb-device-select')).toBeVisible();
  });

  test('mic picker appears when STT is available', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micRow = page.locator('.sb-device-row').filter({ hasText: 'Mic' });
    await expect(micRow).toBeVisible({ timeout: 3_000 });
    await expect(micRow.locator('.sb-device-select')).toBeVisible();
  });

  // ── Device listing ──────────────────────────────────────────────────────────

  test('mic picker lists "Default" plus enumerated input devices', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSelect = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('select');
    await expect(micSelect).toBeVisible({ timeout: 3_000 });

    const options = await getOptionTexts(page, micSelect);
    expect(options[0]).toBe('Default');
    expect(options).toContain('USB Microphone');
    expect(options).toContain('Built-in Mic');
    // Should NOT contain speaker devices
    expect(options).not.toContain('HDMI Speakers');
  });

  test('speaker picker lists "Default" plus enumerated output devices', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const spkSelect = page.locator('.sb-device-row').filter({ hasText: 'Speaker' }).locator('select');
    await expect(spkSelect).toBeVisible({ timeout: 3_000 });

    const options = await getOptionTexts(page, spkSelect);
    expect(options[0]).toBe('Default');
    expect(options).toContain('HDMI Speakers');
    expect(options).toContain('Headphones');
    // Should NOT contain mic devices
    expect(options).not.toContain('USB Microphone');
  });

  // ── Selection & persistence ─────────────────────────────────────────────────

  test('selecting a mic device updates voice store', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSelect = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('select');
    await expect(micSelect).toBeVisible({ timeout: 3_000 });

    await micSelect.selectOption({ value: 'mic-aaa' });

    const stored = await page.evaluate(() =>
      (window as any).__zustand_voice.getState().micDeviceId,
    );
    expect(stored).toBe('mic-aaa');
  });

  test('selecting a speaker device updates voice store', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const spkSelect = page.locator('.sb-device-row').filter({ hasText: 'Speaker' }).locator('select');
    await expect(spkSelect).toBeVisible({ timeout: 3_000 });

    await spkSelect.selectOption({ value: 'spk-bbb' });

    const stored = await page.evaluate(() =>
      (window as any).__zustand_voice.getState().speakerDeviceId,
    );
    expect(stored).toBe('spk-bbb');
  });

  test('selecting "Default" resets device to empty string', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSelect = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('select');
    await expect(micSelect).toBeVisible({ timeout: 3_000 });

    // Select a specific device first
    await micSelect.selectOption({ value: 'mic-bbb' });
    expect(await page.evaluate(() => (window as any).__zustand_voice.getState().micDeviceId)).toBe('mic-bbb');

    // Switch back to Default
    await micSelect.selectOption({ value: '' });
    expect(await page.evaluate(() => (window as any).__zustand_voice.getState().micDeviceId)).toBe('');
  });

  // ── Device hot-plug ─────────────────────────────────────────────────────────

  test('device list updates on devicechange event', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSelect = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('select');
    await expect(micSelect).toBeVisible({ timeout: 3_000 });

    // Add a new device
    await mockEnumerateDevices(page, [
      ...MOCK_DEVICES,
      { deviceId: 'mic-ccc', label: 'New Fancy Mic', kind: 'audioinput' },
    ]);
    await fireDeviceChangeEvent(page);

    // Wait for the new option to appear in the select
    await page.waitForFunction(() => {
      const sel = document.querySelector('.sb-device-row:last-child select') as HTMLSelectElement | null;
      if (!sel) return false;
      return Array.from(sel.options).some(o => o.text === 'New Fancy Mic');
    }, undefined, { timeout: 3_000 });

    const options = await getOptionTexts(page, micSelect);
    expect(options).toContain('New Fancy Mic');
  });

  // ── Mic deviceId wiring ─────────────────────────────────────────────────────

  test('getUserMedia receives selected deviceId constraint', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSelect = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('select');
    await expect(micSelect).toBeVisible({ timeout: 3_000 });

    // Select a specific mic device
    await micSelect.selectOption({ value: 'mic-aaa' });

    // Install mic mock that captures the constraints
    await page.evaluate(() => {
      let capturedConstraints: any = null;
      const mockTrack = { stop: () => {}, kind: 'audio', enabled: true };
      const mockStream = { getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] };

      (navigator.mediaDevices as any).getUserMedia = async (constraints: any) => {
        capturedConstraints = constraints;
        return mockStream;
      };
      (window as any).__capturedConstraints = () => capturedConstraints;

      // Minimal AudioContext mock
      (window as any).AudioContext = class {
        sampleRate = 16000;
        destination = {};
        currentTime = 0;
        state = 'running';
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
        createScriptProcessor() {
          return { onaudioprocess: null, connect: () => {}, disconnect: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
        }
        createOscillator() { return { connect: () => {}, frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, start: () => {}, stop: () => {}, onended: null }; }
        createGain() { return { connect: () => {}, gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } }; }
        close() { return Promise.resolve(); }
      };
    });
    await mockSTT(page, '');

    // Click mic to start recording
    const mic = page.locator('#mic');
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3_000 });

    // Check the constraints
    const constraints = await page.evaluate(() => (window as any).__capturedConstraints());
    expect(constraints).toBeTruthy();
    expect(constraints.audio.deviceId).toEqual({ exact: 'mic-aaa' });
    expect(constraints.audio.channelCount).toBe(1);
  });

  test('getUserMedia uses default when no device selected', async () => {
    const page = getPage();
    await enableVoiceServices(page);

    // Ensure default (empty string) is selected
    await page.evaluate(() => {
      (window as any).__zustand_voice.getState().setMicDeviceId('');
    });

    await page.evaluate(() => {
      let capturedConstraints: any = null;
      const mockTrack = { stop: () => {}, kind: 'audio', enabled: true };
      const mockStream = { getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] };

      (navigator.mediaDevices as any).getUserMedia = async (constraints: any) => {
        capturedConstraints = constraints;
        return mockStream;
      };
      (window as any).__capturedConstraints = () => capturedConstraints;

      (window as any).AudioContext = class {
        sampleRate = 16000;
        destination = {};
        currentTime = 0;
        state = 'running';
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
        createScriptProcessor() {
          return { onaudioprocess: null, connect: () => {}, disconnect: () => {}, addEventListener: () => {}, removeEventListener: () => {} };
        }
        createOscillator() { return { connect: () => {}, frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, start: () => {}, stop: () => {}, onended: null }; }
        createGain() { return { connect: () => {}, gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } }; }
        close() { return Promise.resolve(); }
      };
    });
    await mockSTT(page, '');

    const mic = page.locator('#mic');
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3_000 });

    const constraints = await page.evaluate(() => (window as any).__capturedConstraints());
    expect(constraints).toBeTruthy();
    // No deviceId constraint when default is selected
    expect(constraints.audio.deviceId).toBeUndefined();
    expect(constraints.audio.channelCount).toBe(1);
  });
});
