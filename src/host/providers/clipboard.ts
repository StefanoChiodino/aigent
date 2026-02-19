/**
 * Clipboard capability provider.
 *
 * Platform detection:
 *   - WSL2: powershell.exe (Get-Clipboard / Set-Clipboard)
 *   - macOS: pbpaste / pbcopy
 *   - Linux/X11: xclip
 *   - Linux/Wayland: wl-paste / wl-copy
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, unlinkSync } from 'node:fs';
import type { CapabilityName, CapabilityProvider, CapabilityResult } from '../protocol.js';

type ClipboardBackend = 'wsl' | 'macos' | 'xclip' | 'wayland';

/** Full path to powershell.exe for WSL interop. */
let powershellPath = 'powershell.exe';

function which(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the full path to powershell.exe (needed for reliable WSL interop). */
function findPowershell(): string | null {
  // Try well-known Windows paths first
  const candidates = [
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Fall back to which
  try {
    return execSync('which powershell.exe', { encoding: 'utf-8', timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

function isWSL(): boolean {
  try {
    const release = readFileSync('/proc/version', 'utf-8');
    return /microsoft|wsl/i.test(release);
  } catch {
    return false;
  }
}

/** Test that powershell.exe actually works (binfmt_misc/WSL interop is functional). */
function testPowershell(psPath: string): boolean {
  try {
    const result = execSync(`"${psPath}" -NoProfile -Command "echo ok"`, {
      encoding: 'utf-8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.includes('ok');
  } catch {
    return false;
  }
}

function detectBackend(): ClipboardBackend | null {
  if (isWSL()) {
    const ps = findPowershell();
    if (ps && testPowershell(ps)) {
      powershellPath = ps;
      return 'wsl';
    }
    // WSL but powershell broken — fall through to xclip/wayland
    // Log this for debugging
    process.stderr.write(`[clipboard] WSL detected but powershell not functional (path: ${ps})\n`);
  }
  if (process.platform === 'darwin') return 'macos';
  if (process.env.WAYLAND_DISPLAY && which('wl-paste')) return 'wayland';
  if (process.env.DISPLAY && which('xclip')) return 'xclip';
  return null;
}

// --- Read clipboard ---

function readText(backend: ClipboardBackend): string {
  switch (backend) {
    case 'wsl':
      return execSync(`"${powershellPath}" -NoProfile -Command "Get-Clipboard"`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).replace(/\r\n/g, '\n').trimEnd();

    case 'macos':
      return execSync('pbpaste', { encoding: 'utf-8', timeout: 5000 });

    case 'wayland':
      return execSync('wl-paste --no-newline 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });

    case 'xclip':
      return execSync('xclip -selection clipboard -o 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
  }
}

function readImage(backend: ClipboardBackend): { mediaType: string; data: string } | null {
  const tmp = join(tmpdir(), `aigent-clipboard-${Date.now()}.png`);

  try {
    switch (backend) {
      case 'wsl': {
        // PowerShell: save clipboard image to file
        const winTmp = tmp.replace(/\//g, '\\');
        const ps = `$img = Get-Clipboard -Format Image; if ($img) { $img.Save('${winTmp}', [System.Drawing.Imaging.ImageFormat]::Png) } else { exit 1 }`;
        try {
          execSync(`"${powershellPath}" -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 15000 });
        } catch {
          return null;
        }
        break;
      }

      case 'macos': {
        // macOS: use osascript to check, pngpaste if available
        if (which('pngpaste')) {
          try {
            execSync(`pngpaste ${tmp}`, { timeout: 5000 });
          } catch {
            return null;
          }
        } else {
          return null; // No image paste tool available
        }
        break;
      }

      case 'wayland': {
        try {
          execSync(`wl-paste --type image/png > ${tmp} 2>/dev/null`, { timeout: 5000 });
        } catch {
          return null;
        }
        break;
      }

      case 'xclip': {
        try {
          execSync(`xclip -selection clipboard -t image/png -o > ${tmp} 2>/dev/null`, { timeout: 5000 });
        } catch {
          return null;
        }
        break;
      }
    }

    if (!existsSync(tmp)) return null;
    const buf = readFileSync(tmp);
    if (buf.length === 0) return null;
    return { mediaType: 'image/png', data: buf.toString('base64') };
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// --- Write clipboard ---

function writeText(backend: ClipboardBackend, text: string): void {
  switch (backend) {
    case 'wsl': {
      // Pipe text to clip.exe — simpler and more reliable than Set-Clipboard
      execSync('clip.exe', { input: text, timeout: 5000 });
      break;
    }

    case 'macos':
      execSync('pbcopy', { input: text, timeout: 5000 });
      break;

    case 'wayland':
      execSync('wl-copy', { input: text, timeout: 5000 });
      break;

    case 'xclip':
      execSync('xclip -selection clipboard', { input: text, timeout: 5000 });
      break;
  }
}

// --- Provider ---

export class ClipboardProvider implements CapabilityProvider {
  capabilities: CapabilityName[] = ['clipboard.read', 'clipboard.write'];
  private backend: ClipboardBackend | null = null;

  async detect(): Promise<CapabilityName[]> {
    this.backend = detectBackend();
    if (!this.backend) return [];
    return this.capabilities;
  }

  async execute(capability: CapabilityName, params: Record<string, unknown>): Promise<CapabilityResult> {
    if (!this.backend) throw new Error('Clipboard not available');

    switch (capability) {
      case 'clipboard.read': {
        const format = (params.format as string) ?? 'auto';

        if (format === 'text') {
          return { type: 'text', text: readText(this.backend) };
        }

        if (format === 'image') {
          const img = readImage(this.backend);
          if (!img) return { type: 'text', text: readText(this.backend) };
          return { type: 'image', ...img };
        }

        // auto: try image first, fall back to text
        const img = readImage(this.backend);
        if (img) return { type: 'image', ...img };
        return { type: 'text', text: readText(this.backend) };
      }

      case 'clipboard.write': {
        const text = params.text as string;
        if (!text) throw new Error('clipboard.write requires a "text" parameter');
        writeText(this.backend, text);
        return { ok: true };
      }

      default:
        throw new Error(`Unknown clipboard capability: ${capability}`);
    }
  }
}
