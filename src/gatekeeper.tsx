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
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config'; // Load .env from cwd (repo root)
import { fileURLToPath } from 'node:url';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');

// --- Types ---

interface Mount {
  hostPath: string;        // Absolute path on host
  containerPath: string;   // Path inside container (e.g., /project/myapp)
  mode: 'ro' | 'rw';
  expiresAt?: number;      // Timestamp for timed grants
}

interface GatekeeperArgs {
  projectFolder?: string;
  writeAccess: boolean;
  model?: string;
  thinking?: string;
}

// --- State ---

const mounts: Mount[] = [];
let containerProcess: ChildProcess | null = null;
let containerName = '';
let gatekeeperArgs: GatekeeperArgs;
let client: InstanceType<typeof import('./client.js').AgentClient> | null = null;
let isRestarting = false;

// --- CLI args ---

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
    if (existing.mode === mode) {
      return { ok: false, message: `Already mounted: ${normalized} (${mode})` };
    }
    // Upgrade/downgrade mode
    existing.mode = mode;
    return { ok: true, message: `Updated ${normalized} to ${mode}. Sandbox restarting...` };
  }

  mounts.push({
    hostPath: normalized,
    containerPath: toContainerPath(normalized),
    mode,
  });

  return { ok: true, message: `Mounted ${normalized} (${mode}). Sandbox restarting...` };
}

function removeMount(hostPath: string): { ok: boolean; message: string } {
  const normalized = resolve(hostPath);
  const idx = mounts.findIndex((m) => m.hostPath === normalized);
  if (idx === -1) {
    return { ok: false, message: `Not mounted: ${normalized}` };
  }
  mounts.splice(idx, 1);
  return { ok: true, message: `Unmounted ${normalized}. Sandbox restarting...` };
}

function listMounts(): string {
  if (mounts.length === 0) return 'No active mounts.';
  const lines = mounts.map((m) => {
    const expiry = m.expiresAt ? ` (expires ${new Date(m.expiresAt).toLocaleTimeString()})` : '';
    return `  ${m.hostPath} → ${m.containerPath} (${m.mode})${expiry}`;
  });
  return `Active mounts:\n${lines.join('\n')}`;
}

// --- Container lifecycle ---

function buildDockerArgs(): string[] {
  const args: string[] = [
    'compose', 'run', '--rm', '-T',
    '--name', containerName,
  ];

  // Socket directory
  args.push('-v', `${SOCKET_DIR}:${SOCKET_DIR}`);

  // Dynamic mounts
  for (const mount of mounts) {
    args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mount.mode}`);
  }

  // Environment
  if (gatekeeperArgs.model) {
    args.push('-e', `AIGENT_MODEL=${gatekeeperArgs.model}`);
  }
  if (gatekeeperArgs.thinking) {
    args.push('-e', `AIGENT_THINKING=${gatekeeperArgs.thinking}`);
  }

  args.push('aigent');
  return args;
}

async function startContainer(): Promise<void> {
  containerName = `aigent-worker-${Date.now()}`;

  const dockerArgs = buildDockerArgs();
  log('Starting sandbox...');
  if (mounts.length > 0) {
    for (const m of mounts) {
      log(`  ${m.hostPath} (${m.mode})`);
    }
  }

  containerProcess = spawn('docker', dockerArgs, {
    stdio: ['ignore', 'inherit', 'inherit'],
    cwd: REPO_DIR,
  });

  containerProcess.on('error', (err) => {
    log(`Failed to start container: ${err.message}`);
    if (!isRestarting) process.exit(1);
  });

  containerProcess.on('exit', (code, signal) => {
    containerProcess = null;
    if (!isRestarting) {
      log(`Sandbox exited (code=${code}, signal=${signal})`);
      cleanupSocket();
      process.exit(code ?? 1);
    }
  });

  // Wait for socket
  await waitForSocket();
  log('Sandbox ready');
}

async function restartContainer(): Promise<void> {
  isRestarting = true;

  // Tell client it's about to disconnect
  if (client) {
    // Client will auto-reconnect when the new container comes up
  }

  // Stop current container
  if (containerProcess) {
    try {
      execSync(`docker rm -f ${containerName} 2>/dev/null`, { stdio: 'ignore' });
    } catch {}
    containerProcess = null;
  }

  // Clean socket
  cleanupSocket();

  // Small delay for clean shutdown
  await new Promise<void>((r) => setTimeout(r, 500));

  isRestarting = false;

  // Start new container with updated mounts
  await startContainer();
}

async function waitForSocket(timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(SOCKET_PATH)) return;
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`Worker socket not found after ${timeoutMs / 1000}s`);
}

function cleanupSocket(): void {
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  } catch {}
  // Also clean LLM proxy socket
  try {
    const llmSocket = `${SOCKET_DIR}/llm-proxy.sock`;
    if (existsSync(llmSocket)) unlinkSync(llmSocket);
  } catch {}
}

function cleanupAll(): void {
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
  const hostPath = resolveHostPath(path);

  // Show the request to the user
  const reasonText = reason ? `\n  Reason: "${reason}"` : '';
  injectSystemMessage(
    `Agent requests access to: ${hostPath} (${mode})${reasonText}\n` +
    `Reply: /grant ${id} [ro|rw] or /deny ${id}`
  );

  // Store pending request — resolved when user replies /grant or /deny
  pendingAgentMountRequests.set(id, { hostPath, mode });
}

const pendingAgentMountRequests = new Map<string, { hostPath: string; mode: 'ro' | 'rw' }>();

async function handleGrantDeny(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/grant') {
    const id = parts[1];
    if (!id) return false;

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
      containerPath: result.ok ? containerPath : undefined,
      message: result.message,
    });

    injectSystemMessage(result.message);
    if (result.ok) {
      await restartContainer();
    }
    return true;
  }

  if (cmd === '/deny') {
    const id = parts[1];
    if (!id) return false;

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
    `Reply: /approve ${id} or /reject ${id}\n` +
    `Preview: /preview ${id}`
  );
}

async function handleConfigApproveReject(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve') {
    const id = parts[1];
    if (!id) return false;

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
    const id = parts[1];
    if (!id) return false;

    const pending = pendingConfigWriteRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending config write: ${id}`);
      return true;
    }

    pendingConfigWriteRequests.delete(id);
    client!.send({ type: 'config_write_response', id, ok: false, message: 'Config write rejected by user' });
    injectSystemMessage(`Rejected config write to ${pending.file}`);
    return true;
  }

  if (cmd === '/preview') {
    const id = parts[1];
    if (!id) return false;

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

// --- Helpers ---

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  process.stderr.write(`[gatekeeper ${ts}] ${msg}\n`);
}

// --- LLM Proxy ---

async function startLLMProxy(): Promise<void> {
  const { createProvider, detectProvider } = await import('./provider.js');
  const providerType = detectProvider();
  const provider = createProvider(providerType);
  log(`LLM proxy: ${providerType} provider`);

  const { LLMProxy } = await import('./llm-proxy.js');
  const proxy = new LLMProxy(provider);
  proxy.start();

  // Clean up on exit
  process.on('exit', () => proxy.stop());
}

// --- Main ---

gatekeeperArgs = parseArgs();

// Set up initial mount from CLI
if (gatekeeperArgs.projectFolder) {
  const mode = gatekeeperArgs.writeAccess ? 'rw' as const : 'ro' as const;
  mounts.push({
    hostPath: resolve(gatekeeperArgs.projectFolder),
    containerPath: toContainerPath(gatekeeperArgs.projectFolder),
    mode,
  });
}

// Ensure socket directory
mkdirSync(SOCKET_DIR, { recursive: true });
cleanupSocket();

// Start LLM proxy (holds API keys, worker connects to this)
await startLLMProxy();
log('LLM proxy ready');

// Start container
try {
  await startContainer();
} catch (err) {
  log((err as Error).message);
  cleanupAll();
  process.exit(1);
}

// Set up client
const { AgentClient } = await import('./client.js');
client = new AgentClient();

// Intercept commands: wrap the client's sendMessage to catch gatekeeper commands
const originalSendMessage = client.sendMessage.bind(client);
client.sendMessage = (content: string) => {
  if (isGatekeeperCommand(content)) {
    void handleGatekeeperCommand(content);
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

// Run TUI
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
  await new Promise<void>((r) => {
    if (containerProcess) containerProcess.on('exit', r);
  });
}

// Shutdown
cleanupAll();
process.exit(0);
