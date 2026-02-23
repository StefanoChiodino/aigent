/**
 * Playwright global teardown — kills the test gatekeeper and its Docker container.
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';

const PID_FILE = '/tmp/aigent-test-gatekeeper.pid';

export default async function globalTeardown() {
  // Kill via in-process reference
  const proc = (globalThis as Record<string, unknown>).__AIGENT_TEST_PROC__;
  if (proc && typeof (proc as { kill?: (sig: string) => void }).kill === 'function') {
    try { (proc as { kill: (sig: string) => void }).kill('SIGTERM'); } catch { /* dead */ }
  }

  // Kill by PID (and its whole process group) from the saved PID file
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      // Kill the process group so child Docker processes also die
      try { process.kill(-pid, 'SIGTERM'); } catch { /* not a group leader */ }
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    } catch { /* ignore */ }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }

  // Kill anything still holding port 3142 (catches stray Docker processes)
  killPort(3142);

  // Brief wait for OS cleanup
  await new Promise((r) => setTimeout(r, 800));
  console.log('[test-teardown] Done');
}

/** Kill any process listening on the given port using fuser or lsof. */
function killPort(port: number): void {
  // Try fuser first (Linux), fall back to lsof (macOS/Linux)
  try {
    spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' });
  } catch {
    try {
      const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
      const pids = (result.stdout ?? '').trim().split('\n').filter(Boolean);
      for (const p of pids) {
        try { process.kill(parseInt(p, 10), 'SIGTERM'); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}
