/** Audio device enumeration and selection helpers. */

export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

/**
 * List available audio devices of a given kind.
 * Returns `[{ deviceId: '', label: 'Default' }]` as the first entry,
 * followed by all real devices the browser reports.
 *
 * NOTE: Device labels are empty until the user grants mic permission.
 * Callers should request mic permission first (getUserMedia) if labels matter.
 */
export async function listAudioDevices(kind: 'audioinput' | 'audiooutput'): Promise<AudioDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [{ deviceId: '', label: 'Default', kind }];
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const filtered = all.filter(d => d.kind === kind);
    const devices: AudioDevice[] = [{ deviceId: '', label: 'Default', kind }];
    for (const d of filtered) {
      // Skip the browser's built-in "default" virtual device — we already have our own
      if (d.deviceId === 'default' || d.deviceId === 'communications') continue;
      devices.push({
        deviceId: d.deviceId,
        label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${devices.length}`,
        kind,
      });
    }
    return devices;
  } catch {
    return [{ deviceId: '', label: 'Default', kind }];
  }
}
