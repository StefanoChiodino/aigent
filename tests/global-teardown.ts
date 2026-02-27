/**
 * Playwright global teardown — kills the test gatekeeper and its Docker container.
 *
 * Wrapped in a 15-second timeout to prevent the teardown from hanging forever
 * (e.g. if fuser or docker blocks on a stuck process).
 */

import { readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PID_FILE = '/tmp/aigent-test-gatekeeper.pid';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTOSAVE = resolve(ROOT, 'workspace/.autosave.json');
const AUTOSAVE_BACKUP = `${AUTOSAVE}.test-backup`;
const SETTINGS_BACKUP = resolve(ROOT, 'settings.json.test-backup');
const TEST_SETTINGS = '/tmp/aigent-test-settings.json';

export default async function globalTeardown() {
  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('Teardown timed out after 15s')), 15_000),
  );
  await Promise.race([doTeardown(), timeout]).catch(err => {
    console.warn(`[test-teardown] Warning: ${err.message}`);
  });
}

async function doTeardown() {
  // Kill via in-process reference
  const proc = (globalThis as Record<string, unknown>).__AIGENT_TEST_PROC__;
  if (proc && typeof (proc as { kill?: (sig: string) => void }).kill === 'function') {
    try { (proc as { kill: (sig: string) => void }).kill('SIGTERM'); } catch { /* dead */ }
  }

  // Kill by PID (and its whole process group) from the saved PID file
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      try { process.kill(-pid, 'SIGTERM'); } catch { /* not a group leader */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    } catch { /* ignore */ }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  // Kill anything still holding the test port (catches stray Docker processes)
  const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);
  killPort(PORT);

  // Clean up stale Unix sockets left by the test gatekeeper.
  const TEST_SOCKET_DIR = '/tmp/aigent-test';
  for (const sock of ['worker.sock', 'host.sock', 'llm-proxy.sock', 'host-daemon.pid']) {
    const sockPath = `${TEST_SOCKET_DIR}/${sock}`;
    if (existsSync(sockPath)) {
      try { unlinkSync(sockPath); } catch { /* ignore */ }
    }
  }

  // Clean up any orphaned aigent-test Docker containers from this test run.
  cleanupDockerContainers();

  // Restore the production autosave that was moved aside during setup.
  if (existsSync(AUTOSAVE_BACKUP)) {
    try { renameSync(AUTOSAVE_BACKUP, AUTOSAVE); } catch { /* ignore */ }
    console.log('[test-teardown] Restored .autosave.json');
  }

  // Clean up the isolated test settings file.
  if (existsSync(TEST_SETTINGS)) {
    try { unlinkSync(TEST_SETTINGS); } catch { /* ignore */ }
    console.log('[test-teardown] Removed test settings file');
  }
  // Remove the settings backup (no longer needed — real file was never touched).
  if (existsSync(SETTINGS_BACKUP)) {
    try { unlinkSync(SETTINGS_BACKUP); } catch { /* ignore */ }
    console.log('[test-teardown] Removed settings.json backup');
  }

  // Brief wait for OS cleanup (reduced from 800ms)
  await new Promise((r) => setTimeout(r, 300));
  console.log('[test-teardown] Done');
}

/** Remove aigent-test-worker Docker containers that may have been orphaned. */
function cleanupDockerContainers(): void {
  try {
    spawnSync('sh', ['-c', 'docker ps -q --filter name=aigent-test-worker | xargs -r docker rm -f'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch { /* ignore */ }
}

/** Kill any process listening on the given port. Retries up to 3 times on WSL2/Linux. */
function killPort(port: number): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore', timeout: 5_000 });
      return;
    } catch { /* fuser not available or failed */ }
    try {
      const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8', timeout: 5_000 });
      const pids = (result.stdout ?? '').trim().split('\n').filter(Boolean);
      for (const p of pids) {
        // Use SIGKILL on retry attempts to force-kill stuck processes
        const signal = attempt === 0 ? 'SIGTERM' : 'SIGKILL';
        try { process.kill(parseInt(p, 10), signal); } catch { /* ignore */ }
      }
      if (pids.length > 0) return;
    } catch { /* ignore */ }
  }
}
