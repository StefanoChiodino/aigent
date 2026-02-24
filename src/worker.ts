/**
 * Worker entry point — runs inside the Docker sandbox.
 *
 * Manages the server process (restart on exit code 100 or crash).
 * Watches source files for self-modification auto-restart.
 * No TUI — the TUI runs on the host via the gatekeeper.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { mkdirSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

// Ensure socket directory exists (matches AIGENT_SOCKET_DIR on host)
const SOCKET_DIR = process.env['AIGENT_SOCKET_DIR'] ?? '/tmp/aigent';
mkdirSync(SOCKET_DIR, { recursive: true });

// ALL output goes to a log file — NOT to stdout/stderr.
// Without this, server console.error output leaks through Docker to the
// gatekeeper's terminal, corrupting the TUI.
const LOG_PATH = process.env['AIGENT_LOG'] ?? '/tmp/aigent-server.log';
const logStream = createWriteStream(LOG_PATH, { flags: 'a' });

// Redirect worker's own output to the log file too.
// Catches stray writes from tsx, Node internals, or imported modules.
console.log = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.error = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.warn = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
process.stdout.write = ((chunk: string | Uint8Array) => {
  logStream.write(chunk);
  return true;
}) as typeof process.stdout.write;
process.stderr.write = ((chunk: string | Uint8Array) => {
  logStream.write(chunk);
  return true;
}) as typeof process.stderr.write;

// Logger must be created after console/stderr redirects above
const log = createLogger('worker');

let serverProcess: ChildProcess | null = null;
let isRestarting = false;

// Restart rate limiting — prevent crash loops
const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 30_000;
let crashTimestamps: number[] = [];

// --- Server management ---

function startServer(): void {
  isRestarting = false;
  log.info('Starting server');

  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: process.env,
  });

  // Pipe server output to log file instead of terminal.
  // { end: false } prevents pipe from closing logStream when the server exits.
  serverProcess.stdout?.pipe(logStream, { end: false });
  serverProcess.stderr?.pipe(logStream, { end: false });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    if (isRestarting) {
      setTimeout(startServer, 300);
      return;
    }

    // Code 100 = /restart command — clean restart (not a crash)
    if (code === 100) {
      log.info('Restart requested — restarting server');
      setTimeout(startServer, 300);
      return;
    }

    // Unexpected crash — restart with rate limiting
    if (signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
      const now = Date.now();
      crashTimestamps = crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS);
      crashTimestamps.push(now);

      if (crashTimestamps.length >= MAX_CRASH_RESTARTS) {
        log.error('Crash loop — stopping', { crashes: crashTimestamps.length, windowSec: CRASH_WINDOW_MS / 1000, logPath: LOG_PATH });
        // Write a marker file the TUI can detect
        process.exit(1);
      }

      log.warn('Server crashed — restarting', { code, signal, crashes: crashTimestamps.length, maxCrashes: MAX_CRASH_RESTARTS });
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

import { readdirSync, statSync } from 'node:fs';

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

      // Typecheck before restarting — don't break the running server
      log.info('Source files changed — typechecking');
      try {
        execSync('npx tsc --noEmit', {
          cwd: APP_DIR,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 30_000,
        });
        log.info('Typecheck passed — restarting server');
      } catch (err: unknown) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
        const errorLines = stderr.split('\n').filter((l) => l.includes('error TS')).slice(0, 5);
        const detail = errorLines.length > 0 ? errorLines.map((l) => l.trim()).join('; ') : stderr.slice(0, 500);
        log.warn('Typecheck failed — not restarting', { errors: detail });
        return; // Don't restart — current code is still running fine
      }

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
