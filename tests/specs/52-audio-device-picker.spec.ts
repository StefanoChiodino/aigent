/**
 * 52 — Audio device picker: sidebar device selectors for mic (STT) and
 *       speaker (TTS), persistence in voice store, and mic deviceId wiring.
 *
 * The DevicePicker renders a custom dropdown (button + picker panel) rather
 * than a native <select>. Each .sb-device-row contains a .sb-device-section
 * with a .sb-device-btn (shows selected label) and a .sb-device-picker
 * (dropdown with .sb-model-option buttons).
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
    // Install mock FIRST, before enabling TTS/STT flags (which mounts the pickers)
    await mockEnumerateDevices(page, MOCK_DEVICES);
    // Set flags directly via store to avoid WS async race with injectEvent
    await page.evaluate(() => {
      (window as any).__zustand_ui.getState().setTtsAvailable(true);
      (window as any).__zustand_ui.getState().setSttAvailable(true);
    });
    // Wait for the device sections to render, then fire devicechange so they
    // re-enumerate with the mock in place.
    await page.waitForSelector('.sb-device-section', { timeout: 3_000 });
    await fireDeviceChangeEvent(page);
    // Give the async enumerateDevices a moment to resolve
    await page.waitForTimeout(200);
  }

  /** Helper: get all option labels from a device picker dropdown. */
  async function getPickerOptionTexts(page: import('@playwright/test').Page, sectionLocator: import('@playwright/test').Locator) {
    // Open the dropdown
    await sectionLocator.locator('.sb-device-btn').click();
    const picker = sectionLocator.locator('.sb-device-picker');
    await expect(picker).not.toHaveClass(/\bhidden\b/, { timeout: 1_000 });
    // Collect button texts
    const texts = await picker.locator('.sb-model-option').allTextContents();
    // Close the dropdown by clicking the button again
    await sectionLocator.locator('.sb-device-btn').click();
    return texts;
  }

  /** Helper: select a device option by label text from a device picker. */
  async function selectDeviceByLabel(sectionLocator: import('@playwright/test').Locator, label: string) {
    await sectionLocator.locator('.sb-device-btn').click();
    const picker = sectionLocator.locator('.sb-device-picker');
    await expect(picker).not.toHaveClass(/\bhidden\b/, { timeout: 1_000 });
    await picker.locator('.sb-model-option', { hasText: label }).click();
  }

  // ── Visibility ──────────────────────────────────────────────────────────────

  test('device pickers are hidden when TTS/STT are unavailable', async () => {
    const page = getPage();
    await page.evaluate(() => {
      (window as any).__zustand_ui.getState().setTtsAvailable(false);
      (window as any).__zustand_ui.getState().setSttAvailable(false);
    });
    await expect(page.locator('.sb-device-section')).toHaveCount(0);
  });

  test('speaker picker appears when TTS is available', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const speakerRow = page.locator('.sb-device-row').filter({ hasText: 'Speaker' });
    await expect(speakerRow).toBeVisible({ timeout: 3_000 });
    await expect(speakerRow.locator('.sb-device-section')).toBeVisible();
  });

  test('mic picker appears when STT is available', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micRow = page.locator('.sb-device-row').filter({ hasText: 'Mic' });
    await expect(micRow).toBeVisible({ timeout: 3_000 });
    await expect(micRow.locator('.sb-device-section')).toBeVisible();
  });

  // ── Device listing ──────────────────────────────────────────────────────────

  test('mic picker lists "Default" plus enumerated input devices', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSection = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('.sb-device-section');
    await expect(micSection).toBeVisible({ timeout: 3_000 });

    const options = await getPickerOptionTexts(page, micSection);
    expect(options[0]).toBe('Default');
    expect(options).toContain('USB Microphone');
    expect(options).toContain('Built-in Mic');
    // Should NOT contain speaker devices
    expect(options).not.toContain('HDMI Speakers');
  });

  test('speaker picker lists "Default" plus enumerated output devices', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const spkSection = page.locator('.sb-device-row').filter({ hasText: 'Speaker' }).locator('.sb-device-section');
    await expect(spkSection).toBeVisible({ timeout: 3_000 });

    const options = await getPickerOptionTexts(page, spkSection);
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
    const micSection = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('.sb-device-section');
    await expect(micSection).toBeVisible({ timeout: 3_000 });

    await selectDeviceByLabel(micSection, 'USB Microphone');

    const stored = await page.evaluate(() =>
      (window as any).__zustand_voice.getState().micDeviceId,
    );
    expect(stored).toBe('mic-aaa');
  });

  test('selecting a speaker device updates voice store', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const spkSection = page.locator('.sb-device-row').filter({ hasText: 'Speaker' }).locator('.sb-device-section');
    await expect(spkSection).toBeVisible({ timeout: 3_000 });

    await selectDeviceByLabel(spkSection, 'Headphones');

    const stored = await page.evaluate(() =>
      (window as any).__zustand_voice.getState().speakerDeviceId,
    );
    expect(stored).toBe('spk-bbb');
  });

  test('selecting "Default" resets device to empty string', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSection = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('.sb-device-section');
    await expect(micSection).toBeVisible({ timeout: 3_000 });

    // Select a specific device first
    await selectDeviceByLabel(micSection, 'Built-in Mic');
    expect(await page.evaluate(() => (window as any).__zustand_voice.getState().micDeviceId)).toBe('mic-bbb');

    // Switch back to Default
    await selectDeviceByLabel(micSection, 'Default');
    expect(await page.evaluate(() => (window as any).__zustand_voice.getState().micDeviceId)).toBe('');
  });

  // ── Device hot-plug ─────────────────────────────────────────────────────────

  test('device list updates on devicechange event', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSection = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('.sb-device-section');
    await expect(micSection).toBeVisible({ timeout: 3_000 });

    // Add a new device
    await mockEnumerateDevices(page, [
      ...MOCK_DEVICES,
      { deviceId: 'mic-ccc', label: 'New Fancy Mic', kind: 'audioinput' },
    ]);
    await fireDeviceChangeEvent(page);
    // Wait for re-enumerate
    await page.waitForTimeout(300);

    const options = await getPickerOptionTexts(page, micSection);
    expect(options).toContain('New Fancy Mic');
  });

  // ── Mic deviceId wiring ─────────────────────────────────────────────────────

  test('getUserMedia receives selected deviceId constraint', async () => {
    const page = getPage();
    await enableVoiceServices(page);
    const micSection = page.locator('.sb-device-row').filter({ hasText: 'Mic' }).locator('.sb-device-section');
    await expect(micSection).toBeVisible({ timeout: 3_000 });

    // Select a specific mic device
    await selectDeviceByLabel(micSection, 'USB Microphone');

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

      // Minimal AudioContext + AudioWorkletNode mock
      (window as any).AudioWorkletNode = class {
        port = { onmessage: null, postMessage: () => {} };
        connect() {}
        disconnect() {}
        addEventListener() {}
        removeEventListener() {}
      };
      (window as any).AudioContext = class {
        sampleRate = 16000;
        destination = {};
        currentTime = 0;
        state = 'running';
        audioWorklet = { addModule: () => Promise.resolve() };
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
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

  // ── Stale device ID handling ───────────────────────────────────────────────

  test('stale device ID is reset to default when device not found', async () => {
    const page = getPage();

    // Set a device ID that won't match any enumerated device
    await page.evaluate(() => {
      (window as any).__zustand_voice.getState().setMicDeviceId('stale-device-id');
    });

    await enableVoiceServices(page);

    // The DevicePicker should detect the mismatch and reset to ''
    const stored = await page.evaluate(() =>
      (window as any).__zustand_voice.getState().micDeviceId,
    );
    expect(stored).toBe('');
  });

  test('startMic falls back to default when stored device is stale', async () => {
    const page = getPage();
    await enableVoiceServices(page);

    // Set a stale device ID directly in the store
    await page.evaluate(() => {
      (window as any).__zustand_voice.getState().setMicDeviceId('nonexistent-device');
    });

    // Install mic mock that captures constraints
    await page.evaluate(() => {
      let capturedConstraints: any = null;
      const mockTrack = { stop: () => {}, kind: 'audio', enabled: true };
      const mockStream = { getTracks: () => [mockTrack], getAudioTracks: () => [mockTrack] };

      (navigator.mediaDevices as any).getUserMedia = async (constraints: any) => {
        capturedConstraints = constraints;
        return mockStream;
      };
      (window as any).__capturedConstraints = () => capturedConstraints;

      (window as any).AudioWorkletNode = class {
        port = { onmessage: null, postMessage: () => {} };
        connect() {}
        disconnect() {}
        addEventListener() {}
        removeEventListener() {}
      };
      (window as any).AudioContext = class {
        sampleRate = 16000;
        destination = {};
        currentTime = 0;
        state = 'running';
        audioWorklet = { addModule: () => Promise.resolve() };
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
        createOscillator() { return { connect: () => {}, frequency: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, start: () => {}, stop: () => {} }; }
        createGain() { return { connect: () => {}, gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} } }; }
        close() { return Promise.resolve(); }
      };
    });
    await mockSTT(page, '');

    const mic = page.locator('#mic');
    await mic.click();
    await expect(mic).toHaveClass(/\brecording\b/, { timeout: 3_000 });

    // Should have fallen back to no deviceId constraint
    const constraints = await page.evaluate(() => (window as any).__capturedConstraints());
    expect(constraints).toBeTruthy();
    expect(constraints.audio.deviceId).toBeUndefined();

    // Store should have been reset to ''
    const stored = await page.evaluate(() =>
      (window as any).__zustand_voice.getState().micDeviceId,
    );
    expect(stored).toBe('');
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

      (window as any).AudioWorkletNode = class {
        port = { onmessage: null, postMessage: () => {} };
        connect() {}
        disconnect() {}
        addEventListener() {}
        removeEventListener() {}
      };
      (window as any).AudioContext = class {
        sampleRate = 16000;
        destination = {};
        currentTime = 0;
        state = 'running';
        audioWorklet = { addModule: () => Promise.resolve() };
        createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
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
