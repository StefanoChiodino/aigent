#!/usr/bin/env tsx
/**
 * Gatekeeper — runs on the host, manages the Docker sandbox, runs the TUI.
 *
 * Architecture:
 *   1. Creates shared socket directory
 *   2. Starts the Docker container (worker) in detached mode
 *   3. Waits for the worker socket to appear
 *   4. Runs the TUI, connecting to the worker socket
 *   5. On exit, stops the container and cleans up
 *
 * Usage:
 *   tsx src/gatekeeper.tsx [project-folder] [--rw] [--model <model>]
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');
const CONTAINER_NAME = `aigent-worker-${process.pid}`;

// --- Parse CLI args ---

interface GatekeeperArgs {
  projectFolder?: string;
  writeAccess: boolean;
  model?: string;
  thinking?: string;
}

function parseArgs(): GatekeeperArgs {
  const args = process.argv.slice(2);
  const result: GatekeeperArgs = { writeAccess: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--rw') {
      result.writeAccess = true;
    } else if (arg === '--model' && args[i + 1]) {
      result.model = args[++i];
    } else if (arg === '--thinking' && args[i + 1]) {
      result.thinking = args[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(`aigent — AI agent with sandboxed execution

Usage: aigent [project-folder] [options]

Options:
  --rw              Mount project folder read-write (default: read-only)
  --model <model>   Model to use (default: claude-opus-4-6-20250514)
  --thinking <level> Thinking level: off, low, medium, high, max

Examples:
  aigent                           # Start with no project folder
  aigent ~/projects/myapp          # Mount project read-only
  aigent ~/projects/myapp --rw     # Mount project read-write
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      result.projectFolder = resolve(arg);
    }
  }

  return result;
}

// --- Container management ---

function buildDockerRunArgs(args: GatekeeperArgs): string[] {
  const dockerArgs: string[] = [
    'compose', 'run', '--rm', '-T',
    '--name', CONTAINER_NAME,
  ];

  // Socket directory — shared between host and container
  dockerArgs.push('-v', `${SOCKET_DIR}:${SOCKET_DIR}`);

  // Project folder mount
  if (args.projectFolder) {
    const mode = args.writeAccess ? 'rw' : 'ro';
    dockerArgs.push('-v', `${resolve(args.projectFolder)}:/project:${mode}`);
  }

  // Environment overrides
  if (args.model) {
    dockerArgs.push('-e', `AIGENT_MODEL=${args.model}`);
  }
  if (args.thinking) {
    dockerArgs.push('-e', `AIGENT_THINKING=${args.thinking}`);
  }

  dockerArgs.push('aigent');
  return dockerArgs;
}

function startContainer(args: GatekeeperArgs): ChildProcess {
  const dockerArgs = buildDockerRunArgs(args);
  console.error(`[gatekeeper] Starting sandbox...`);
  if (args.projectFolder) {
    const mode = args.writeAccess ? 'rw' : 'ro';
    console.error(`[gatekeeper] Project: ${args.projectFolder} (${mode})`);
  }

  const container = spawn('docker', dockerArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: REPO_DIR,
  });

  container.on('error', (err) => {
    console.error(`[gatekeeper] Failed to start container: ${err.message}`);
    process.exit(1);
  });

  return container;
}

/** Wait for the worker socket to appear (with timeout). */
async function waitForSocket(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(SOCKET_PATH)) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`Worker socket not found at ${SOCKET_PATH} after ${timeoutMs / 1000}s`);
}

// --- Cleanup ---

function cleanup(): void {
  // Stop container
  try {
    execSync(`docker rm -f ${CONTAINER_NAME} 2>/dev/null`, { stdio: 'ignore' });
  } catch {}

  // Clean up socket
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {}
}

// --- Main ---

const gatekeeperArgs = parseArgs();

// Ensure socket directory exists and is clean
mkdirSync(SOCKET_DIR, { recursive: true });
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH); } catch {}
}

// Start container
const containerProcess = startContainer(gatekeeperArgs);

containerProcess.on('exit', (code, signal) => {
  console.error(`[gatekeeper] Sandbox exited (code=${code}, signal=${signal})`);
  cleanup();
  process.exit(code ?? 1);
});

// Wait for socket
try {
  await waitForSocket();
} catch (err) {
  console.error(`[gatekeeper] ${(err as Error).message}`);
  cleanup();
  process.exit(1);
}

console.error('[gatekeeper] Sandbox ready');

// Run TUI
const { AgentClient } = await import('./client.js');
const client = new AgentClient();

const canUseTUI = Boolean(
  process.stdin.isTTY &&
  typeof process.stdin.setRawMode === 'function'
);

if (canUseTUI) {
  const { render } = await import('ink');
  const { App } = await import('./ui/App.js');

  const { waitUntilExit } = render(<App client={client} />, { exitOnCtrlC: false });
  client.connect();

  await waitUntilExit();
} else {
  const { startRepl } = await import('./repl.js');
  client.connect();

  // startRepl doesn't return a promise we can await, so wait for container exit
  await new Promise<void>((r) => {
    containerProcess.on('exit', r);
  });
}

// Shutdown
cleanup();
process.exit(0);
