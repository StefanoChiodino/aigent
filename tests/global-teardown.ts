/**
 * Playwright global teardown — kills the test gatekeeper process and its Docker container.
 */

import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PID_FILE = '/tmp/aigent-test-gatekeeper.pid';

export default async function globalTeardown() {
  // Kill via stored reference (same process)
  const proc = (globalThis as Record<string, unknown>).__AIGENT_TEST_PROC__;
  if (proc && typeof (proc as { kill?: (sig: string) => void }).kill === 'function') {
    try {
      (proc as { kill: (sig: string) => void }).kill('SIGTERM');
      console.log('[test-teardown] Sent SIGTERM to gatekeeper');
    } catch { /* already dead */ }
  }

  // Also kill by PID in case the reference was lost
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGTERM');
    } catch { /* already dead */ }
    unlinkSync(PID_FILE);
  }

  // Stop the test Docker container
  try {
    execSync('docker stop aigent-test 2>/dev/null || true', { stdio: 'ignore' });
    console.log('[test-teardown] Stopped aigent-test container');
  } catch { /* ignore */ }

  // Brief wait for cleanup
  await new Promise((r) => setTimeout(r, 1000));
}
