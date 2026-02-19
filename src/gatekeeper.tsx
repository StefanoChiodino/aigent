#!/usr/bin/env tsx
/**
 * Gatekeeper — runs on the host, manages the Docker sandbox, runs the TUI.
 *
 * Responsibilities:
 *   - Container lifecycle (start, stop, restart with updated mounts)
 *   - Mount management (add/remove folders, ro/rw, timed grants)
 *   - Permission prompts (inline in TUI)
 *   - OS bridge (clipboard, audio, etc. — future)
 *   - LLM proxy (future — API keys out of sandbox)
 *
 * The gatekeeper intercepts certain commands before they reach the worker:
 *   /mount, /unmount, /mounts — handled locally
 *   Everything else — forwarded to the worker
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync, createWriteStream } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config'; // Load .env from cwd (repo root)
import { fileURLToPath } from 'node:url';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';
import { createLogger } from './logger.js';

const log = createLogger('gatekeeper');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');

// --- Types ---

interface Mount {
  hostPath: string;        // Absolute path on host
  containerPath: string;   // Path inside container (e.g., /project/myapp)
  mode: 'ro' | 'rw';
  expiresAt?: number;      // Timestamp for timed grants
  implicit?: boolean;      // true for docker-compose.yml built-in mounts (not passed as -v)
}

interface GatekeeperArgs {
  projectFolder?: string;
  writeAccess: boolean;
  model?: string;
  thinking?: string;
  headless: boolean;
}

// --- State ---

const mounts: Mount[] = [
  // Implicit mounts from docker-compose.yml — shown in UI but not passed as -v flags.
  { hostPath: resolve(REPO_DIR), containerPath: '/app', mode: 'rw', implicit: true },
  { hostPath: resolve(REPO_DIR, 'workspace'), containerPath: '/workspace', mode: 'rw', implicit: true },
  { hostPath: resolve(REPO_DIR, 'workspace', 'config'), containerPath: '/workspace/config', mode: 'ro', implicit: true },
];
let containerProcess: ChildProcess | null = null;
let containerName = '';
let gatekeeperArgs: GatekeeperArgs;
let client: InstanceType<typeof import('./client.js').AgentClient> | null = null;
let isRestarting = false;

// --- CLI args ---

function parseArgs(): GatekeeperArgs {
  const args = process.argv.slice(2);
  const result: GatekeeperArgs = { writeAccess: false, headless: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--rw') {
      result.writeAccess = true;
    } else if (arg === '--model' && args[i + 1]) {
      result.model = args[++i]!;
    } else if (arg === '--thinking' && args[i + 1]) {
      result.thinking = args[++i]!;
    } else if (arg === '--headless') {
      result.headless = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`aigent — AI agent with sandboxed execution

Usage: aigent [project-folder] [options]

Options:
  --rw              Mount project folder read-write (default: read-only)
  --model <model>   Model to use (default: claude-opus-4-6-20250514)
  --thinking <level> Thinking level: off, low, medium, high, max
  --headless        Web UI only, no terminal interface

Examples:
  aigent                           # Start with no project folder
  aigent ~/projects/myapp          # Mount project read-only
  aigent ~/projects/myapp --rw     # Mount project read-write
  aigent --headless                # Web UI only at localhost:3141

Mount management (inside the TUI):
  /mount <path> [ro|rw]   Mount a host folder into the sandbox
  /unmount <path>          Remove a mount (sandbox restarts)
  /mounts                  List active mounts
`);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      result.projectFolder = resolve(arg);
    }
  }

  return result;
}

// --- Mount management ---

/** Resolve ~ and relative paths. */
function resolveHostPath(input: string): string {
  if (input.startsWith('~')) {
    return resolve(homedir(), input.slice(2));
  }
  return resolve(input);
}

/** Generate a container mount path from a host path. */
function toContainerPath(hostPath: string): string {
  // /project/<folder-name> — simple and predictable
  return `/project/${basename(hostPath)}`;
}

/** Reverse-map a container path to a host path.
 *  The agent sees paths like /app/src or /project/myapp inside the container.
 *  This maps them back to the corresponding host paths using known mounts. */
function resolveContainerToHost(containerPath: string): string | null {
  // Check dynamic mounts first (e.g., /project/myapp → host path)
  for (const m of mounts) {
    if (containerPath === m.containerPath || containerPath.startsWith(m.containerPath + '/')) {
      const relative = containerPath.slice(m.containerPath.length);
      return m.hostPath + relative;
    }
  }

  // Implicit mount: /app → REPO_DIR (from docker-compose.yml)
  if (containerPath === '/app' || containerPath.startsWith('/app/')) {
    const relative = containerPath.slice('/app'.length);
    return REPO_DIR + relative;
  }

  // Implicit mount: /workspace → REPO_DIR/workspace
  if (containerPath === '/workspace' || containerPath.startsWith('/workspace/')) {
    const relative = containerPath.slice('/workspace'.length);
    return resolve(REPO_DIR, 'workspace') + relative;
  }

  return null;
}

/** Paths that must never be mounted. */
const FORBIDDEN_PATHS = ['/', '/etc', '/var', '/usr', '/bin', '/sbin', '/lib', '/boot', '/dev', '/proc', '/sys'];

function isForbiddenPath(hostPath: string): boolean {
  const normalized = resolve(hostPath);
  return FORBIDDEN_PATHS.includes(normalized) || normalized === homedir();
}

function findMount(hostPath: string): Mount | undefined {
  const normalized = resolve(hostPath);
  return mounts.find((m) => m.hostPath === normalized);
}

function addMount(hostPath: string, mode: 'ro' | 'rw'): { ok: boolean; message: string } {
  const normalized = resolve(hostPath);

  if (isForbiddenPath(normalized)) {
    return { ok: false, message: `Refusing to mount ${normalized} — sensitive path` };
  }

  if (!existsSync(normalized)) {
    return { ok: false, message: `Path does not exist: ${normalized}` };
  }

  const existing = findMount(normalized);
  if (existing) {
    if (existing.implicit) {
      return { ok: false, message: `Already a built-in mount: ${normalized} (${existing.mode})` };
    }
    if (existing.mode === mode) {
      return { ok: false, message: `Already mounted: ${normalized} (${mode})` };
    }
    // Upgrade/downgrade mode
    existing.mode = mode;
    return { ok: true, message: `Updated ${normalized} to ${mode}.` };
  }

  mounts.push({
    hostPath: normalized,
    containerPath: toContainerPath(normalized),
    mode,
  });

  return { ok: true, message: `Mounted ${normalized} (${mode}).` };
}

function removeMount(hostPath: string): { ok: boolean; message: string } {
  const normalized = resolve(hostPath);
  const idx = mounts.findIndex((m) => m.hostPath === normalized);
  if (idx === -1) {
    return { ok: false, message: `Not mounted: ${normalized}` };
  }
  if (mounts[idx]!.implicit) {
    return { ok: false, message: `Cannot unmount built-in mount: ${normalized}` };
  }
  mounts.splice(idx, 1);
  return { ok: true, message: `Unmounted ${normalized}.` };
}

function listMounts(): string {
  if (mounts.length === 0) return 'No active mounts.';
  const lines = mounts.map((m) => {
    const tag = m.implicit ? ' [built-in]' : '';
    const expiry = m.expiresAt ? ` (expires ${new Date(m.expiresAt).toLocaleTimeString()})` : '';
    return `  ${m.hostPath} → ${m.containerPath} (${m.mode})${tag}${expiry}`;
  });
  return `Active mounts:\n${lines.join('\n')}`;
}

/** Read capability permissions from the host daemon's config file. */
function readCapabilities(): Record<string, string> {
  const configPath = join(homedir(), '.config', 'aigent', 'permissions.json');
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, { grant: string }>;
    const result: Record<string, string> = {};
    for (const [cap, entry] of Object.entries(parsed)) {
      result[cap] = entry.grant;
    }
    return result;
  } catch {
    // No config or invalid — return defaults
    return {
      'clipboard.read': 'prompt',
      'clipboard.write': 'prompt',
      'screen.capture': 'prompt',
      'screen.list': 'prompt',
      'audio.play': 'prompt',
      'audio.record': 'prompt',
      'notify': 'prompt',
      'open': 'prompt',
      'fs.read': 'deny',
      'fs.write': 'deny',
    };
  }
}

/** Push current host state (mounts + capabilities) to all UI listeners. */
function emitHostState(): void {
  if (!client) return;
  client.emit(
    'host_state',
    mounts.map((m) => ({
      hostPath: m.hostPath,
      containerPath: m.containerPath,
      mode: m.mode,
    })),
    readCapabilities(),
  );
}

// --- Container lifecycle ---

function buildDockerArgs(): string[] {
  const args: string[] = [
    'compose', 'run', '--rm', '-T',
    '--name', containerName,
  ];

  // Socket directory
  args.push('-v', `${SOCKET_DIR}:${SOCKET_DIR}`);

  // Dynamic mounts (skip implicit ones — those come from docker-compose.yml)
  for (const mount of mounts) {
    if (mount.implicit) continue;
    args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
  }

  // Environment
  if (gatekeeperArgs.model) {
    args.push('-e', `AIGENT_MODEL=${gatekeeperArgs.model}`);
  }
  if (gatekeeperArgs.thinking) {
    args.push('-e', `AIGENT_THINKING=${gatekeeperArgs.thinking}`);
  }
  if (process.env['AIGENT_DEBUG']) {
    args.push('-e', `AIGENT_DEBUG=${process.env['AIGENT_DEBUG']}`);
  }
  if (process.env['AIGENT_LOG_LEVEL']) {
    args.push('-e', `AIGENT_LOG_LEVEL=${process.env['AIGENT_LOG_LEVEL']}`);
  }

  args.push('aigent');
  return args;
}

async function startContainer(): Promise<void> {
  containerName = `aigent-worker-${Date.now()}`;

  const dockerArgs = buildDockerArgs();
  log.info('Starting sandbox...');
  const userMounts = mounts.filter((m) => !m.implicit);
  if (userMounts.length > 0) {
    for (const m of userMounts) {
      log.info('Mount', { path: m.hostPath, mode: m.mode });
    }
  }

  containerProcess = spawn('docker', dockerArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_DIR,
  });

  // Pipe container stdout/stderr to log file instead of terminal.
  // Without this, server console.error (via worker → container → gatekeeper) corrupts the TUI.
  // { end: false } prevents pipe from closing logStream when the container exits.
  containerProcess.stdout?.pipe(logStream, { end: false });
  containerProcess.stderr?.pipe(logStream, { end: false });

  containerProcess.on('error', (err) => {
    log.error('Failed to start container', { error: err.message });
    if (!isRestarting) process.exit(1);
  });

  containerProcess.on('exit', (code, signal) => {
    containerProcess = null;
    if (!isRestarting) {
      log.info('Sandbox exited', { code, signal });
      cleanupSocket();
      process.exit(code ?? 1);
    }
  });

  // Wait for socket
  await waitForSocket();
  log.info('Sandbox ready');
}

async function restartContainer(): Promise<void> {
  isRestarting = true;

  // Remove exit handler from old process BEFORE killing it.
  // Without this, the async 'exit' event fires after isRestarting is cleared,
  // causing the handler to call process.exit() and kill the gatekeeper.
  if (containerProcess) {
    containerProcess.removeAllListeners('exit');
    containerProcess.removeAllListeners('error');
    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
    containerProcess = null;
  }

  // Clean socket
  cleanupSocket();

  // Small delay for clean shutdown
  await new Promise<void>((r) => setTimeout(r, 500));

  // Start new container with updated mounts.
  // isRestarting stays true until startContainer() completes, so the new
  // process's exit handler won't prematurely kill the gatekeeper if the
  // container takes a moment to stabilize.
  try {
    await startContainer();
  } catch (err) {
    // Socket timeout — the container may still be starting (Docker can be slow).
    // Don't throw — the client's auto-reconnect will recover once the socket appears.
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Container restart slow', { error: msg });
    injectSystemMessage(
      `Sandbox is slow to start. Will auto-reconnect when ready.\n` +
      `If it doesn't recover, try /restart.`
    );
  } finally {
    isRestarting = false;
    emitHostState();
  }
}

async function waitForSocket(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(SOCKET_PATH)) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`Worker socket not found after ${Math.round(timeoutMs / 1000)}s`);
}

function cleanupSocket(): void {
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {}
  // NOTE: Do NOT delete the LLM proxy socket here — the proxy keeps running
  // across container restarts. It cleans up its own socket in LLMProxy.start().
}

function cleanupAll(): void {
  stopHostDaemon();
  if (containerProcess) {
    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
  }
  cleanupSocket();
}

// --- Command interception ---

/** Commands the gatekeeper handles locally (not forwarded to worker). */
const GATEKEEPER_COMMANDS = new Set(['/mount', '/unmount', '/mounts', '/grant', '/deny', '/approve', '/reject', '/preview']);

function isGatekeeperCommand(input: string): boolean {
  const cmd = input.trim().split(/\s+/)[0]?.toLowerCase();
  return cmd ? GATEKEEPER_COMMANDS.has(cmd) : false;
}

async function handleGatekeeperCommand(input: string): Promise<void> {
  // Check dynamic commands first (grant/deny, approve/reject/preview)
  if (await handleGrantDeny(input)) return;
  if (await handleConfigApproveReject(input)) return;

  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case '/mounts': {
      injectSystemMessage(listMounts());
      break;
    }

    case '/mount': {
      const path = parts[1];
      if (!path) {
        injectSystemMessage('Usage: /mount <path> [ro|rw]\nExample: /mount ~/projects/myapp rw');
        return;
      }

      const mode = (parts[2]?.toLowerCase() === 'rw') ? 'rw' as const : 'ro' as const;
      const hostPath = resolveHostPath(path);
      const result = addMount(hostPath, mode);
      injectSystemMessage(result.message);

      if (result.ok) {
        injectSystemMessage('Sandbox restarting...');
        await restartContainer();
      }
      break;
    }

    case '/unmount': {
      const path = parts[1];
      if (!path) {
        injectSystemMessage('Usage: /unmount <path>\nExample: /unmount ~/projects/myapp');
        return;
      }

      const hostPath = resolveHostPath(path);
      const result = removeMount(hostPath);
      injectSystemMessage(result.message);

      if (result.ok) {
        injectSystemMessage('Sandbox restarting...');
        await restartContainer();
      }
      break;
    }
  }
}

/** Inject a system message into the TUI (shown to user, not sent to worker). */
function injectSystemMessage(content: string): void {
  // The client emits events that the TUI listens to.
  // We can emit a 'system' event directly.
  if (client) {
    client.emit('system', content);
  }
}

// --- Agent mount requests ---

async function handleAgentMountRequest(
  id: string,
  path: string,
  mode: 'ro' | 'rw',
  reason?: string,
): Promise<void> {
  // The agent sends container paths (e.g., /app/src). Try to reverse-map first.
  const hostPath = resolveContainerToHost(path) ?? resolveHostPath(path);

  // Show the request to the user
  const reasonText = reason ? `\n  Reason: "${reason}"` : '';
  injectSystemMessage(
    `Agent requests access to: ${hostPath} (${mode})${reasonText}\n` +
    `Reply: /grant or /deny`
  );

  // Store pending request — resolved when user replies /grant or /deny
  pendingAgentMountRequests.set(id, { hostPath, mode });
}

const pendingAgentMountRequests = new Map<string, { hostPath: string; mode: 'ro' | 'rw' }>();

async function handleGrantDeny(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/grant') {
    let id = parts[1];
    // Auto-infer ID when there's exactly one pending request
    if (!id && pendingAgentMountRequests.size === 1) {
      id = pendingAgentMountRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingAgentMountRequests.size === 0
        ? 'No pending mount requests.'
        : `Multiple pending requests — specify ID: ${[...pendingAgentMountRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingAgentMountRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending mount request: ${id}`);
      return true;
    }

    const mode = (parts[2]?.toLowerCase() === 'rw') ? 'rw' as const : pending.mode;
    pendingAgentMountRequests.delete(id);

    const result = addMount(pending.hostPath, mode);
    const containerPath = toContainerPath(pending.hostPath);

    // Send response to worker
    client!.send({
      type: 'mount_response',
      id,
      ok: result.ok,
      ...(result.ok ? { containerPath } : {}),
      message: result.message,
    });

    log.info('Mount granted', { id, path: pending.hostPath, mode });
    injectSystemMessage(result.message);
    if (result.ok) {
      injectSystemMessage('Sandbox restarting...');
      await restartContainer();
    }
    return true;
  }

  if (cmd === '/deny') {
    let id = parts[1];
    if (!id && pendingAgentMountRequests.size === 1) {
      id = pendingAgentMountRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingAgentMountRequests.size === 0
        ? 'No pending mount requests.'
        : `Multiple pending requests — specify ID: ${[...pendingAgentMountRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingAgentMountRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending mount request: ${id}`);
      return true;
    }

    pendingAgentMountRequests.delete(id);

    client!.send({
      type: 'mount_response',
      id,
      ok: false,
      message: 'Mount denied by user',
    });

    log.info('Mount denied', { id, path: pending.hostPath });
    injectSystemMessage(`Denied mount request for ${pending.hostPath}`);
    return true;
  }

  return false;
}

// --- Config write requests ---

const VALID_CONFIG_FILES = new Set(['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'IDENTITY.md']);
const pendingConfigWriteRequests = new Map<string, { file: string; content: string }>();

function handleConfigWriteRequest(id: string, file: string, content: string, reason: string): void {
  if (!VALID_CONFIG_FILES.has(file)) {
    client!.send({ type: 'config_write_response', id, ok: false, message: `${file} is not a config file` });
    return;
  }

  // Read current content for diff
  const configPath = join(REPO_DIR, 'workspace', 'config', file);
  const fallbackPath = join(REPO_DIR, 'workspace', file);
  let current = '';
  try {
    current = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : 
              existsSync(fallbackPath) ? readFileSync(fallbackPath, 'utf-8') : '';
  } catch {}

  // Generate a simple diff summary
  const currentLines = current.split('\n');
  const newLines = content.split('\n');
  const added = newLines.filter((l) => !currentLines.includes(l)).length;
  const removed = currentLines.filter((l) => !newLines.includes(l)).length;

  pendingConfigWriteRequests.set(id, { file, content });

  injectSystemMessage(
    `Agent wants to edit config/${file}:\n` +
    `  Reason: "${reason}"\n` +
    `  Changes: +${added} lines, -${removed} lines\n` +
    `  New size: ${content.length} bytes\n\n` +
    `Reply: /approve or /reject\n` +
    `Preview: /preview`
  );
}

async function handleConfigApproveReject(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve') {
    let id = parts[1];
    if (!id && pendingConfigWriteRequests.size === 1) {
      id = pendingConfigWriteRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingConfigWriteRequests.size === 0
        ? 'No pending config writes.'
        : `Multiple pending — specify ID: ${[...pendingConfigWriteRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    pendingConfigWriteRequests.delete(id);

    // Write the file on the host side
    const configDir = join(REPO_DIR, 'workspace', 'config');
    mkdirSync(configDir, { recursive: true });
    const filePath = join(configDir, pending.file);
    try {
      writeFileSync(filePath, pending.content);
      // Also write to workspace root for backward compat
      writeFileSync(join(REPO_DIR, 'workspace', pending.file), pending.content);

      log.info('Config write approved', { id, file: pending.file });
      client!.send({ type: 'config_write_response', id, ok: true, message: `${pending.file} updated` });
      injectSystemMessage(`Approved: config/${pending.file} updated`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      client!.send({ type: 'config_write_response', id, ok: false, message: msg });
      injectSystemMessage(`Failed to write ${pending.file}: ${msg}`);
    }
    return true;
  }

  if (cmd === '/reject') {
    let id = parts[1];
    if (!id && pendingConfigWriteRequests.size === 1) {
      id = pendingConfigWriteRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingConfigWriteRequests.size === 0
        ? 'No pending config writes.'
        : `Multiple pending — specify ID: ${[...pendingConfigWriteRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    pendingConfigWriteRequests.delete(id);
    log.info('Config write rejected', { id, file: pending.file });
    client!.send({ type: 'config_write_response', id, ok: false, message: 'Config write rejected by user' });
    injectSystemMessage(`Rejected config write to ${pending.file}`);
    return true;
  }

  if (cmd === '/preview') {
    let id = parts[1];
    if (!id && pendingConfigWriteRequests.size === 1) {
      id = pendingConfigWriteRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingConfigWriteRequests.size === 0
        ? 'No pending config writes.'
        : `Multiple pending — specify ID: ${[...pendingConfigWriteRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    // Show the proposed content (truncated if very long)
    const preview = pending.content.length > 2000
      ? pending.content.slice(0, 2000) + '\n\n... [truncated]'
      : pending.content;
    injectSystemMessage(`Preview of ${pending.file}:\n\n${preview}`);
    return true;
  }

  return false;
}

// --- Host Daemon ---

let hostDaemonProcess: ChildProcess | null = null;

async function startHostDaemon(): Promise<void> {
  const { HOST_SOCKET_PATH } = await import('./host/protocol.js');

  // Clean up stale socket
  if (existsSync(HOST_SOCKET_PATH)) {
    try { unlinkSync(HOST_SOCKET_PATH); } catch {}
  }

  // Spawn the host daemon as a child process.
  // It runs on the host (not in Docker) so it has access to clipboard, screen, etc.
  // --allow clipboard.read,clipboard.write — pre-approve clipboard (no prompts)
  const daemonScript = resolve(__dirname, 'host', 'daemon.js');
  
  // Check if compiled JS exists, fall back to tsx for .ts
  const scriptPath = existsSync(daemonScript) ? daemonScript : resolve(__dirname, 'host', 'daemon.ts');
  const runner = existsSync(daemonScript) ? 'node' : 'tsx';

  hostDaemonProcess = spawn(runner, [
    scriptPath,
    '--allow', 'clipboard.read,clipboard.write',
    '--socket', HOST_SOCKET_PATH,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe daemon output to log file
  hostDaemonProcess.stdout?.pipe(logStream, { end: false });
  hostDaemonProcess.stderr?.pipe(logStream, { end: false });

  hostDaemonProcess.on('error', (err) => {
    log.warn('Host daemon failed to start', { error: err.message });
    hostDaemonProcess = null;
  });

  hostDaemonProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      log.warn('Host daemon exited', { code });
    }
    hostDaemonProcess = null;
  });

  // Wait briefly for socket to appear
  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (existsSync(HOST_SOCKET_PATH)) {
      log.info('Host daemon ready');
      return;
    }
    await new Promise<void>((r) => setTimeout(r, 100));
  }

  log.warn('Host daemon socket not found after 3s — continuing without it');
}

function stopHostDaemon(): void {
  if (hostDaemonProcess) {
    hostDaemonProcess.kill('SIGTERM');
    hostDaemonProcess = null;
  }
}

// --- LLM Proxy ---

async function startLLMProxy(): Promise<void> {
  const { createProvider, detectProvider } = await import('./provider.js');
  const providerType = detectProvider();
  const provider = createProvider(providerType);
  log.info('LLM proxy provider', { provider: providerType });

  const { LLMProxy } = await import('./llm-proxy.js');
  const proxy = new LLMProxy(provider);
  proxy.start();

  // Clean up on exit
  process.on('exit', () => proxy.stop());
}

// --- Main ---

gatekeeperArgs = parseArgs();

// --- Log setup ---
// Redirect ALL console/stderr output to a log file.
// The TUI writes directly via process.stdout.write(); everything else must go to the log file.
// Without this, stray writes (from libraries, Node internals, container output) corrupt the terminal.
const LOG_PATH = process.env['AIGENT_LOG'] ?? '/tmp/aigent-gatekeeper.log';
const logStream = createWriteStream(LOG_PATH, { flags: 'a' });

console.log = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.error = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.warn = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
process.stderr.write = ((chunk: string | Uint8Array) => {
  logStream.write(chunk);
  return true;
}) as typeof process.stderr.write;

// Set up initial mount from CLI
if (gatekeeperArgs.projectFolder) {
  const mode = gatekeeperArgs.writeAccess ? 'rw' as const : 'ro' as const;
  mounts.push({
    hostPath: resolve(gatekeeperArgs.projectFolder),
    containerPath: toContainerPath(gatekeeperArgs.projectFolder),
    mode,
  });
}

// Ensure socket directory — mode 0o777 so the container's `node` user can create sockets too
mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o777 });
cleanupSocket();

// Start host daemon (clipboard, screen capture, etc.)
await startHostDaemon();

// Start LLM proxy (holds API keys, worker connects to this)
await startLLMProxy();
log.info('LLM proxy ready');

// Start container
try {
  await startContainer();
} catch (err) {
  log.error('Container start failed', { error: (err as Error).message });
  cleanupAll();
  process.exit(1);
}

// Set up client
const { AgentClient } = await import('./client.js');
client = new AgentClient();

// Start web UI server (non-blocking, runs alongside TUI)
const { startWebServer } = await import('./web-bridge.js');
startWebServer(client).then(({ port }) => {
  log.info('Web UI ready', { url: `http://localhost:${port}` });
}).catch((err) => {
  log.error('Web UI failed to start', { error: (err as Error).message });
});

// Push mount state to web UI when client connects to the worker
client.on('connected', () => {
  setTimeout(() => emitHostState(), 100);
});

// Intercept commands: wrap the client's sendMessage to catch gatekeeper commands
const originalSendMessage = client.sendMessage.bind(client);
client.sendMessage = (content: string) => {
  if (isGatekeeperCommand(content)) {
    handleGatekeeperCommand(content).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Gatekeeper command error', { error: msg });
      injectSystemMessage(`Error: ${msg}`);
    });
    return;
  }
  originalSendMessage(content);
};

// Handle mount requests from the worker (agent requests a folder)
client.on('mount_request', (id: string, path: string, mode: 'ro' | 'rw', reason?: string) => {
  void handleAgentMountRequest(id, path, mode, reason);
});

// Handle config write requests from the worker
client.on('config_write_request', (id: string, file: string, content: string, reason: string) => {
  handleConfigWriteRequest(id, file, content, reason);
});

// Run UI
if (gatekeeperArgs.headless) {
  // Headless mode: web UI only, no terminal interface
  client.connect();
  log.info('Running in headless mode (web UI only)');
  // Keep process alive until container exits or SIGINT
  await new Promise<void>((r) => {
    process.on('SIGINT', r);
    process.on('SIGTERM', r);
    if (containerProcess) containerProcess.on('exit', r);
  });
} else {
  const canUseTUI = Boolean(
    process.stdin.isTTY &&
    typeof process.stdin.setRawMode === 'function'
  );

  if (canUseTUI) {
    const { AnsiTUI } = await import('./ui/AnsiTUI.js');
    const tui = new AnsiTUI(client);
    tui.start();

    await tui.waitForExit();
  } else {
    const { startRepl } = await import('./repl.js');
    client.connect();
    startRepl(client);
    await new Promise<void>((r) => {
      if (containerProcess) containerProcess.on('exit', r);
      else r();
    });
  }
}

// Shutdown
cleanupAll();
process.exit(0);
