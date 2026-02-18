/**
 * Worker entry point — runs inside the Docker sandbox.
 *
 * Manages the server process (restart on exit code 100 or crash).
 * Watches source files for self-modification auto-restart.
 * No TUI — the TUI runs on the host via the gatekeeper.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

// Ensure socket directory exists
const SOCKET_DIR = '/tmp/aigent';
mkdirSync(SOCKET_DIR, { recursive: true });

let serverProcess: ChildProcess | null = null;
let isRestarting = false;

// --- Server management ---

function startServer(): void {
  isRestarting = false;
  console.error('[worker] Starting server...');

  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: process.cwd(),
    env: process.env,
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    if (isRestarting) {
      setTimeout(startServer, 300);
      return;
    }

    // Code 100 = /restart command — clean restart
    if (code === 100) {
      console.error('[worker] Restart requested — restarting server...');
      setTimeout(startServer, 300);
      return;
    }

    // Unexpected crash — restart after delay
    if (signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
      console.error(`[worker] Server crashed (code=${code}, signal=${signal}). Restarting in 1s...`);
      setTimeout(startServer, 1000);
    }
  });
}

// --- Shutdown ---

function shutdown(code: number = 0): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

// --- File watcher (for self-modification auto-restart) ---

import { readdirSync, statSync, readFileSync } from 'node:fs';

function getFileHashes(dir: string): Map<string, number> {
  const hashes = new Map<string, number>();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const [k, v] of getFileHashes(full)) hashes.set(k, v);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        try {
          hashes.set(full, statSync(full).mtimeMs);
        } catch {}
      }
    }
  } catch {}
  return hashes;
}

let lastHashes = getFileHashes(SRC_DIR);
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

setInterval(() => {
  const current = getFileHashes(SRC_DIR);
  let changed = false;
  for (const [file, mtime] of current) {
    if (lastHashes.get(file) !== mtime) {
      changed = true;
      break;
    }
  }
  if (current.size !== lastHashes.size) changed = true;

  if (changed) {
    lastHashes = current;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      console.error('[worker] Source files changed — restarting server...');
      if (serverProcess) {
        isRestarting = true;
        serverProcess.kill('SIGTERM');
      } else {
        startServer();
      }
    }, 2000);
  }
}, 1000);

// --- Start ---

startServer();

// Keep alive
setInterval(() => {}, 60_000);
