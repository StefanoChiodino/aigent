/**
 * Supervisor process for graceful hot-reload.
 *
 * Instead of tsx --watch (which brutally kills mid-conversation),
 * this supervisor:
 * 1. Spawns the agent process (tsx /app/src/index.tsx)
 * 2. Watches /app/src/ for file changes
 * 3. On change, sends SIGUSR1 to the agent (graceful restart signal)
 * 4. The agent finishes its current turn, then exits
 * 5. Supervisor respawns the agent
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import { resolve, join } from 'node:path';

const APP_DIR = resolve('/app');
const SRC_DIR = join(APP_DIR, 'src');
const ENTRY = join(SRC_DIR, 'index.tsx');

let child: ChildProcess | null = null;
let restartPending = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function startAgent(): void {
  restartPending = false;

  child = spawn('tsx', ['--tsconfig', join(APP_DIR, 'tsconfig.json'), ENTRY], {
    stdio: 'inherit',
    cwd: '/workspace',
    env: process.env,
  });

  child.on('exit', (code, signal) => {
    child = null;

    // If restart is pending (we asked it to restart), respawn immediately
    if (restartPending) {
      console.log('\n🔄 Restarting agent with updated code...\n');
      startAgent();
      return;
    }

    // If the agent exited on its own (user quit), exit the supervisor too
    if (signal === 'SIGINT' || signal === 'SIGTERM' || code === 0) {
      process.exit(code ?? 0);
    }

    // Unexpected crash — restart after a brief delay
    console.error(`\n⚠️  Agent exited unexpectedly (code=${code}, signal=${signal}). Restarting in 1s...\n`);
    setTimeout(startAgent, 1000);
  });
}

function requestRestart(): void {
  if (!child) return;
  restartPending = true;
  child.kill('SIGUSR1');
}

// Watch for source file changes with debouncing
function watchSources(): FSWatcher[] {
  const watchers: FSWatcher[] = [];

  function watchDir(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        // Only care about TypeScript/TSX files
        if (!filename.endsWith('.ts') && !filename.endsWith('.tsx')) return;
        // Ignore node_modules
        if (filename.includes('node_modules')) return;

        // Debounce: wait 500ms after last change before signaling
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (child && !restartPending) {
            console.log(`\n📝 Source changed: ${filename}`);
            requestRestart();
          }
        }, 500);
      });
      watchers.push(watcher);
    } catch {
      // Directory might not exist yet, that's fine
    }
  }

  watchDir(SRC_DIR);
  return watchers;
}

// Forward signals to child
process.on('SIGINT', () => {
  if (child) {
    child.kill('SIGINT');
  } else {
    process.exit(0);
  }
});

process.on('SIGTERM', () => {
  if (child) {
    child.kill('SIGTERM');
  } else {
    process.exit(0);
  }
});

// Start everything
watchSources();
startAgent();
