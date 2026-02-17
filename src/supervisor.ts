/**
 * Supervisor — manages the agent server and TUI as separate processes.
 *
 * Architecture:
 *   supervisor (this) ─┬─ server process (agent backend, Unix socket)
 *                      └─ TUI process (frontend, inherits stdio)
 *
 * On source file changes:
 *   1. Sends SIGTERM to the server (graceful shutdown, auto-saves state)
 *   2. Respawns the server
 *   3. TUI detects disconnect, reconnects automatically
 *   4. Server reloads auto-saved conversation state
 *
 * The TUI is never restarted — it survives server restarts seamlessly.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { resolve, join } from 'node:path';

const APP_DIR = resolve('/app');
const SRC_DIR = join(APP_DIR, 'src');
const SERVER_ENTRY = join(SRC_DIR, 'server.ts');
const TUI_ENTRY = join(SRC_DIR, 'index.tsx');
const TSCONFIG = join(APP_DIR, 'tsconfig.json');

let serverProcess: ChildProcess | null = null;
let tuiProcess: ChildProcess | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let serverRestarting = false;

// --- Server management ---

function startServer(): void {
  serverRestarting = false;

  serverProcess = spawn('tsx', ['--tsconfig', TSCONFIG, SERVER_ENTRY], {
    stdio: ['pipe', 'inherit', 'inherit'],
    cwd: '/workspace',
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

// --- TUI management ---

function startTUI(): void {
  // Small delay to let server start up
  setTimeout(() => {
    tuiProcess = spawn('tsx', ['--tsconfig', TSCONFIG, TUI_ENTRY], {
      stdio: 'inherit',
      cwd: '/workspace',
      env: process.env,
    });

    tuiProcess.on('exit', (code) => {
      tuiProcess = null;
      // TUI exited (user quit) — shut everything down
      shutdown(code ?? 0);
    });
  }, 500);
}

// --- File watcher ---

function watchSources(): FSWatcher[] {
  const watchers: FSWatcher[] = [];

  function watchDir(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) return;
        if (filename.includes('node_modules')) return;

        // Debounce: wait 500ms after last change
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.error(`\n[supervisor] Source changed: ${filename} — restarting server...`);
          restartServer();
        }, 500);
      });
      watchers.push(watcher);
    } catch {
      // Directory might not exist yet
    }
  }

  watchDir(SRC_DIR);
  return watchers;
}

// --- Signal handling ---

function shutdown(code: number = 0): void {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
  if (tuiProcess) {
    tuiProcess.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// --- Start ---

watchSources();
startServer();
startTUI();
