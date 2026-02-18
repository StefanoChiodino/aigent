/**
 * Supervisor — starts the agent server, then runs the TUI.
 *
 * Architecture:
 *   1. Starts the server as a background child process
 *   2. Watches src/ for changes and restarts the server (debounced 2s)
 *   3. Runs the TUI in-process so it gets direct TTY access
 *   4. Conversation auto-saves on every response — seamless restart
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync, statSync, existsSync } from 'node:fs';

// Resolve paths relative to this file's location
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

let serverProcess: ChildProcess | null = null;
let isRestarting = false;

// --- Server management ---

function startServer(): void {
  isRestarting = false;
  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: process.cwd(),
    env: process.env,
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    // If we're intentionally restarting (file change), start fresh
    if (isRestarting) {
      setTimeout(startServer, 300);
      return;
    }

    // Unexpected crash — restart after delay
    if (signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
      console.error(`\n[supervisor] Server crashed (code=${code}, signal=${signal}). Restarting in 1s...`);
      setTimeout(startServer, 1000);
    }
  });
}

function restartServer(): void {
  if (!serverProcess) {
    startServer();
    return;
  }
  isRestarting = true;
  serverProcess.kill('SIGTERM');
  // The 'exit' handler will call startServer() after a brief delay
}

// --- File watcher (polling, debounced) ---
// Uses polling because fs.watch is unreliable on Docker bind mounts (WSL2/macOS).
// Debounced at 2s so multi-file self-edits don't cause intermediate restarts.

const POLL_INTERVAL = 1000; // Check every second
const DEBOUNCE_MS = 2000;  // Wait 2s after last change before restarting

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const fileTimestamps = new Map<string, number>();

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories (e.g., ui/)
        files.push(...collectFiles(full));
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        files.push(full);
      }
    }
  } catch {
    // Permission error or similar — skip
  }
  return files;
}

function snapshotTimestamps(): void {
  fileTimestamps.clear();
  for (const file of collectFiles(SRC_DIR)) {
    try {
      fileTimestamps.set(file, statSync(file).mtimeMs);
    } catch {
      // File disappeared between listing and stat — ignore
    }
  }
}

function checkForChanges(): void {
  let changed = false;

  for (const file of collectFiles(SRC_DIR)) {
    try {
      const mtime = statSync(file).mtimeMs;
      const prev = fileTimestamps.get(file);
      if (prev === undefined || mtime !== prev) {
        changed = true;
        fileTimestamps.set(file, mtime);
      }
    } catch {
      // ignore
    }
  }

  if (changed) {
    // Reset debounce timer on every detected change
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      console.error('[supervisor] Source changed — restarting server...');
      snapshotTimestamps(); // Re-snapshot so we don't re-trigger
      restartServer();
    }, DEBOUNCE_MS);
  }
}

// --- Shutdown ---

function shutdown(code: number = 0): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));

// --- Start ---

// 1. Start the server as a background child
startServer();

// 2. Start file watcher for self-authoring (auto-restart on code changes)
snapshotTimestamps();
setInterval(checkForChanges, POLL_INTERVAL);

// 3. Give server a moment to start, then run the TUI in-process
//    (runs in this process so it gets direct TTY access)
await new Promise<void>((resolve) => setTimeout(resolve, 500));

// Import and run the TUI entry point directly
const { AgentClient } = await import('./client.js');
const client = new AgentClient();

const canUseTUI = Boolean(
  process.stdin.isTTY &&
  typeof process.stdin.setRawMode === 'function'
);

if (canUseTUI) {
  const { render } = await import('ink');
  const { App } = await import('./ui/App.js');

  const { waitUntilExit } = render(<App client={client} />, { exitOnCtrlC: false });
  client.connect();

  await waitUntilExit();
  shutdown(0);
} else {
  const { startRepl } = await import('./repl.js');
  // REPL handles its own exit
  client.connect();
  startRepl(client);
}
