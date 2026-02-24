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

  // Clean up stale Unix sockets left by the test gatekeeper.
  // Uses the test-specific socket dir so we never touch dev sockets.
  const TEST_SOCKET_DIR = '/tmp/aigent-test';
  for (const sock of ['worker.sock', 'host.sock', 'llm-proxy.sock', 'host-daemon.pid']) {
    const sockPath = `${TEST_SOCKET_DIR}/${sock}`;
    if (existsSync(sockPath)) {
      try { unlinkSync(sockPath); } catch { /* ignore */ }
    }
  }

  // Clean up any orphaned aigent-test Docker containers from this test run.
  // Only targets aigent-test-worker containers — never touches dev containers.
  cleanupDockerContainers();

  // Brief wait for OS cleanup
  await new Promise((r) => setTimeout(r, 800));
  console.log('[test-teardown] Done');
}

/** Remove aigent-test-worker Docker containers that may have been orphaned. */
function cleanupDockerContainers(): void {
  try {
    // Only target test containers (aigent-test-worker) — never dev containers (aigent-worker).
    spawnSync('sh', ['-c', 'docker ps -q --filter name=aigent-test-worker | xargs -r docker rm -f'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch { /* ignore */ }
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
