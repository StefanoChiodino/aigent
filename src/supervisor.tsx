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
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

    if (isRestarting) {
      setTimeout(startServer, 300);
      return;
    }

    // Code 100 = /restart command — clean restart
    if (code === 100) {
      console.error('[supervisor] Restart requested — restarting server...');
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
  client.connect();
  startRepl(client);
}
