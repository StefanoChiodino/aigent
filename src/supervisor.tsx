/**
 * Supervisor — manages the agent server, then becomes the TUI.
 *
 * Architecture:
 *   1. Starts the server as a background child process
 *   2. Watches source files for changes
 *   3. On change: kills server, respawns it (TUI reconnects automatically)
 *   4. Runs the TUI in-process (not as a child) so it gets direct TTY access
 *
 * The TUI is never restarted — it survives server restarts seamlessly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to this file's location
const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

let serverProcess: ChildProcess | null = null;
let serverRestarting = false;

// --- Server management ---

function startServer(): void {
  serverRestarting = false;

  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: process.cwd(),
    env: process.env,
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    if (serverRestarting) {
      // Deliberate restart — respawn immediately
      startServer();
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

  serverRestarting = true;
  serverProcess.kill('SIGTERM');
  // The exit handler will respawn
}

// --- File watcher (polling — fs.watch doesn't work in Docker bind mounts) ---

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        files.push(...collectSourceFiles(full));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
        files.push(full);
      }
    }
  } catch {
    // Directory might not exist
  }
  return files;
}

function getMtimes(dir: string): Map<string, number> {
  const mtimes = new Map<string, number>();
  for (const file of collectSourceFiles(dir)) {
    try {
      mtimes.set(file, statSync(file).mtimeMs);
    } catch {
      // File may have been deleted
    }
  }
  return mtimes;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function watchSources(): void {
  let known = getMtimes(SRC_DIR);

  pollTimer = setInterval(() => {
    const current = getMtimes(SRC_DIR);

    // Check for changed or new files
    for (const [file, mtime] of current) {
      const prev = known.get(file);
      if (prev === undefined || prev !== mtime) {
        const rel = file.replace(SRC_DIR + '/', '');
        known = current;
        console.error(`\n[supervisor] Source changed: ${rel} — restarting server...`);
        restartServer();
        return;
      }
    }

    // Check for deleted files
    if (current.size !== known.size) {
      known = current;
      console.error(`\n[supervisor] Source file removed — restarting server...`);
      restartServer();
      return;
    }
  }, 1000);
}

// --- Shutdown ---

function shutdown(code: number = 0): void {
  if (pollTimer) clearInterval(pollTimer);
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));

// --- Start ---

// 1. Watch source files
watchSources();

// 2. Start the server as a background child
startServer();

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
