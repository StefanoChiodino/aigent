/**
 * Supervisor — starts the agent server, then runs the TUI.
 *
 * Architecture:
 *   1. Starts the server as a background child process
 *   2. Runs the TUI in-process so it gets direct TTY access
 *   3. Conversation auto-saves on every response — restart to pick up code changes
 *
 * To apply code changes: Ctrl+C, then `make dev`. Session restores automatically.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to this file's location
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

let serverProcess: ChildProcess | null = null;

// --- Server management ---

function startServer(): void {
  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: process.cwd(),
    env: process.env,
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    // Unexpected crash — restart after delay
    if (signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
      console.error(`\n[supervisor] Server crashed (code=${code}, signal=${signal}). Restarting in 1s...`);
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

// 1. Start the server as a background child
startServer();

// 2. Give server a moment to start, then run the TUI in-process
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

  const { waitUntilExit } = render(<App client={client} />);
  client.connect();

  await waitUntilExit();
  shutdown(0);
} else {
  const { startRepl } = await import('./repl.js');
  // REPL handles its own exit
  client.connect();
  startRepl(client);
}
