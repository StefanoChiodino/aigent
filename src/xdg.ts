/**
 * XDG / platform-aware path helpers for aigent global install.
 *
 * Returns consistent config and data directories across Linux, macOS, and Windows.
 * All paths end without a trailing slash.
 */

import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const home = homedir();
const plat = platform();

/**
 * Config directory — user-facing settings and API keys.
 *   Linux/WSL:  ~/.config/aigent
 *   macOS:      ~/Library/Application Support/aigent
 *   Windows:    %APPDATA%\aigent   (falls back to ~/.config/aigent)
 */
export function getConfigDir(): string {
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'aigent');
  if (plat === 'win32') {
    const appdata = process.env['APPDATA'];
    return appdata ? join(appdata, 'aigent') : join(home, '.config', 'aigent');
  }
  // Linux / WSL / other POSIX — respect XDG_CONFIG_HOME if set
  const xdgConfig = process.env['XDG_CONFIG_HOME'];
  return xdgConfig ? join(xdgConfig, 'aigent') : join(home, '.config', 'aigent');
}

/**
 * Data directory — workspace, memory, logs.
 *   Linux/WSL:  ~/.local/share/aigent
 *   macOS:      ~/Library/Application Support/aigent   (same as config)
 *   Windows:    %LOCALAPPDATA%\aigent  (falls back to ~/.local/share/aigent)
 */
export function getDataDir(): string {
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'aigent');
  if (plat === 'win32') {
    const localAppdata = process.env['LOCALAPPDATA'];
    return localAppdata ? join(localAppdata, 'aigent') : join(home, '.local', 'share', 'aigent');
  }
  // Linux / WSL — respect XDG_DATA_HOME if set
  const xdgData = process.env['XDG_DATA_HOME'];
  return xdgData ? join(xdgData, 'aigent') : join(home, '.local', 'share', 'aigent');
}

/** Default workspace directory (inside data dir). */
export function getDefaultWorkspace(): string {
  return join(getDataDir(), 'workspace');
}

/** Path to the .env file (API keys). */
export function getEnvFile(): string {
  return join(getConfigDir(), '.env');
}

/** Path to settings.json. */
export function getSettingsFile(): string {
  return join(getConfigDir(), 'settings.json');
}
