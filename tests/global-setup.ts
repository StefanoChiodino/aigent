/**
 * Playwright global setup — spawns a dedicated aigent gatekeeper instance for tests.
 *
 * Uses port 3142 (not 3141) so it doesn't conflict with a running dev instance.
 * Sets AIGENT_TEST_MODE=1 to enable the /test/inject endpoint in web-bridge.ts.
 * Waits for the WebSocket endpoint to be ready before handing off to tests.
 * If port 3142 is already occupied (stale from a previous failed run), it kills
 * whatever is there rather than throwing.
 */

import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync, openSync } from 'node:fs';
import { createConnection } from 'node:net';
import { WebSocket } from 'ws';

const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PID_FILE = '/tmp/aigent-test-gatekeeper.pid';
const LOG_FILE = '/tmp/aigent-test-gatekeeper.log';

export default async function globalSetup() {
  if (await checkPortInUse(PORT)) {
    console.log(`[test-setup] Port ${PORT} in use — killing stale process...`);
    killPort(PORT);
    await sleep(1_500);
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

  console.log('[test-setup] Waiting for WebSocket to be ready (up to 60s)...');
  await Promise.race([
    waitForWebSocket(`ws://localhost:${PORT}/ws`, 60_000),
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

function killPort(port: number): void {
  // fuser -k (Linux) kills all processes on the TCP port
  try {
    spawnSync('fuser', ['-k', `${port}/tcp`], { stdio: 'ignore' });
    return;
  } catch { /* not available */ }
  // Fallback: lsof + kill (macOS/Linux)
  try {
    const result = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
    const pids = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    for (const p of pids) {
      try { process.kill(parseInt(p, 10), 'SIGTERM'); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function waitForWebSocket(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await tryWebSocketConnect(url, 2_000);
      return;
    } catch {
      await sleep(1_000);
    }
  }
  throw new Error(`Timed out waiting for WebSocket at ${url} after ${timeoutMs}ms`);
}

function tryWebSocketConnect(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('timeout')); }, timeoutMs);
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve(); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
