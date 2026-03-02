/**
 * Playwright global setup — spawns a dedicated aigent gatekeeper instance for tests.
 *
 * Uses port 3142 (not 3141) so it doesn't conflict with a running dev instance.
 * Sets AIGENT_TEST_MODE=1 to enable the /test/inject endpoint in web-bridge.ts.
 * Waits for the /healthz endpoint to be ready before handing off to tests.
 * If port 3142 is already occupied (stale from a previous failed run), it kills
 * whatever is there rather than throwing.
 */

import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, openSync, readFileSync, existsSync, renameSync, copyFileSync } from 'node:fs';
import { createConnection } from 'node:net';

const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PID_FILE = '/tmp/aigent-test-gatekeeper.pid';
const LOG_FILE = '/tmp/aigent-test-gatekeeper.log';
const AUTOSAVE = resolve(ROOT, 'workspace/.autosave.json');
const AUTOSAVE_BACKUP = `${AUTOSAVE}.test-backup`;
const SETTINGS = resolve(ROOT, 'settings.json');
const SETTINGS_BACKUP = '/tmp/aigent-settings.json.test-backup';
const TEST_SETTINGS = '/tmp/aigent-test-settings.json';

export default async function globalSetup() {
  // Temporarily move the autosave file so the test worker starts with a clean
  // conversation (otherwise it replays the production session's messages).
  if (existsSync(AUTOSAVE)) {
    renameSync(AUTOSAVE, AUTOSAVE_BACKUP);
    console.log('[test-setup] Moved .autosave.json aside');
  }

  // Isolate settings.json: copy to a temp file for the test gatekeeper so
  // tests never modify the user's real permission lists and other settings.
  // Also keep a backup of the original as a safety net.
  if (existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, SETTINGS_BACKUP);
    copyFileSync(SETTINGS, TEST_SETTINGS);
    // Strip AIGENT_MODEL from test settings so the user's model preference
    // doesn't leak into tests (e.g. disabling reasoning toggle for non-Opus models).
    try {
      const testSettings = JSON.parse(readFileSync(TEST_SETTINGS, 'utf-8'));
      delete testSettings['AIGENT_MODEL'];
      writeFileSync(TEST_SETTINGS, JSON.stringify(testSettings, null, 2) + '\n');
    } catch { /* leave as-is if parse fails */ }
    console.log(`[test-setup] Copied settings.json → ${TEST_SETTINGS} (real file untouched)`);
  } else {
    writeFileSync(TEST_SETTINGS, '{}');
    console.log('[test-setup] No settings.json found; test will use empty settings');
  }

  // Kill any previous test gatekeeper by saved PID first (more reliable than by port).
  await killByPidFile();

  // Belt-and-suspenders: if something else grabbed the port, kill it too.
  if (await checkPortInUse(PORT)) {
    console.log(`[test-setup] Port ${PORT} still in use — killing by port...`);
    killByPort(PORT);
    await waitForPortFree(PORT, 5_000);
    if (await checkPortInUse(PORT)) {
      throw new Error(`Port ${PORT} still in use after kill attempt. Run: lsof -i :${PORT}`);
    }
  }

  console.log(`[test-setup] Spawning aigent gatekeeper on port ${PORT}...`);
  console.log(`[test-setup] Server log: ${LOG_FILE}`);

  const logFd = openSync(LOG_FILE, 'w');

  const gatekeeper = spawn(
    'npx',
    ['tsx', 'src/gatekeeper.tsx', '--headless'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AIGENT_WEB_PORT: String(PORT),
        AIGENT_TEST_MODE: '1',
        AIGENT_SOCKET_DIR: '/tmp/aigent-test2',
        AIGENT_SETTINGS_PATH: TEST_SETTINGS,
        // Force Opus model so reasoning toggle and effort pills are enabled.
        // The user's .env may have a non-Opus model which disables these controls.
        AIGENT_MODEL: 'claude-opus-4-6',
      },
      stdio: ['ignore', logFd, logFd],
      detached: false,
    }
  );

  if (gatekeeper.pid === undefined) {
    throw new Error('[test-setup] Failed to spawn gatekeeper process');
  }

  writeFileSync(PID_FILE, String(gatekeeper.pid));
  (globalThis as Record<string, unknown>).__AIGENT_TEST_PROC__ = gatekeeper;

  // Detect early crash before WS is ready
  const earlyExit = new Promise<never>((_, reject) => {
    gatekeeper.on('exit', (code) => {
      reject(new Error(
        `Gatekeeper exited early (code ${code ?? 'unknown'}).\n` +
        `Check logs: cat ${LOG_FILE}`
      ));
    });
  });

  console.log('[test-setup] Waiting for /healthz to be ready (up to 30s)...');
  await Promise.race([
    waitForHealthz(`http://localhost:${PORT}`, 30_000),
    earlyExit,
  ]);

  console.log(`[test-setup] aigent ready at http://localhost:${PORT}`);
}

function checkPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, '127.0.0.1');
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

/** Kill the process saved in PID_FILE and wait for the port to free up. */
async function killByPidFile(): Promise<void> {
  if (!existsSync(PID_FILE)) return;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const pid = parseInt(raw, 10);
  if (!pid || isNaN(pid)) return;

  const alive = isProcessAlive(pid);
  if (!alive) return;

  console.log(`[test-setup] Killing stale gatekeeper (pid ${pid})...`);
  try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }

  // Wait up to 3s for graceful exit, then SIGKILL.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && isProcessAlive(pid)) {
    await sleep(100);
  }
  if (isProcessAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    await sleep(300);
  }

  // Wait for the port to free.
  await waitForPortFree(PORT, 3_000);
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function killByPort(port: number): void {
  // lsof + SIGKILL (works on Linux/macOS)
  try {
    const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
    const pids = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    for (const p of pids) {
      try { process.kill(parseInt(p, 10), 'SIGKILL'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await checkPortInUse(port)) return;
    await sleep(100);
  }
}

async function waitForHealthz(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
    } catch { /* server not up yet */ }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/healthz after ${timeoutMs}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
