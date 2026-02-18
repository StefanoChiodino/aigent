/**
 * Supervisor — starts the agent server, then runs the TUI.
 *
 * Architecture:
 *   1. Starts the server as a background child process
 *   2. Runs the TUI in-process so it gets direct TTY access
 *   3. Conversation auto-saves on every response
 *   4. /restart command triggers a clean server restart
 *
 * No auto-reloading — this is a self-modifying codebase, so restarts
 * are explicit and user-controlled.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

// Server logs go to a file instead of the terminal to avoid corrupting Ink's rendering.
// Any output to stdout/stderr between Ink's erase-and-render cycles gets stuck in
// scrollback, causing the input box to duplicate into the chat area.
const LOG_PATH = process.env['AIGENT_LOG'] ?? '/tmp/aigent-server.log';
const logStream = createWriteStream(LOG_PATH, { flags: 'a' });

// Silence ALL console/stderr output from the supervisor process.
// The TUI writes directly via process.stdout.write(); everything else must go to the log file.
// Without this, stray writes (from libraries, Node internals, or pipe leaks) corrupt the terminal.
console.log = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.error = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.warn = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
process.stderr.write = ((chunk: string | Uint8Array) => {
  logStream.write(chunk);
  return true;
}) as typeof process.stderr.write;

let serverProcess: ChildProcess | null = null;
let isRestarting = false;

// --- Server management ---

function startServer(): void {
  isRestarting = false;
  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: process.cwd(),
    env: process.env,
  });

  // Pipe server stdout/stderr to log file instead of terminal.
  // { end: false } prevents pipe from closing logStream when the server exits.
  serverProcess.stdout?.pipe(logStream, { end: false });
  serverProcess.stderr?.pipe(logStream, { end: false });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    if (isRestarting) {
      setTimeout(startServer, 300);
      return;
    }

    // Code 100 = /restart command — clean restart
    if (code === 100) {
      logStream.write('[supervisor] Restart requested — restarting server...\n');
      setTimeout(startServer, 300);
      return;
    }

    // Unexpected crash — restart after delay
    if (signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
      logStream.write(`[supervisor] Server crashed (code=${code}, signal=${signal}). Restarting in 1s...\n`);
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

// --- Start ---

startServer();

// Give server a moment to start, then run the TUI
await new Promise<void>((resolve) => setTimeout(resolve, 500));

const { AgentClient } = await import('./client.js');
const client = new AgentClient();

// Start web UI server (non-blocking, runs alongside TUI)
const { startWebServer } = await import('./web-bridge.js');
startWebServer(client).catch((err) => {
  console.error('Web UI failed to start:', (err as Error).message);
});

const canUseTUI = Boolean(
  process.stdin.isTTY &&
  typeof process.stdin.setRawMode === 'function'
);

if (canUseTUI) {
  const { AnsiTUI } = await import('./ui/AnsiTUI.js');
  const tui = new AnsiTUI(client);
  tui.start();

  await tui.waitForExit();
  shutdown(0);
} else {
  const { startRepl } = await import('./repl.js');
  client.connect();
  startRepl(client);
}
