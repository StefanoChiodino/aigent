#!/usr/bin/env tsx
/**
 * Gatekeeper — runs on the host, manages the Docker sandbox, runs the TUI.
 * (Touched to restart tsx watcher after web-bridge.ts changes.)
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
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config'; // Load .env from cwd (repo root)
import { fileURLToPath } from 'node:url';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';
import { createLogger } from './logger.js';
import { checkExecPermission, DEFAULT_EXEC_PERMISSIONS, type ExecPermissions, checkFetchPermission, DEFAULT_FETCH_PERMISSIONS, type FetchPermissions } from './safety.js';

const log = createLogger('gatekeeper');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');

// Load settings.json and apply non-secret values to process.env.
// .env (already loaded via dotenv) takes lowest priority; CLI flags override all.
{
  const settingsPath = resolve(REPO_DIR, 'settings.json');
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      const SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
      for (const [key, value] of Object.entries(settings)) {
        if (SECRET_KEYS.has(key)) continue; // never load secrets from settings.json
        if (value !== null && value !== undefined && value !== '') {
          process.env[key] = String(value);
        }
      }
    } catch { /* malformed settings.json — ignore, fall back to .env */ }
  }
}

// --- Types ---

interface Mount {
  hostPath: string;        // Absolute path on host
  containerPath: string;   // Path inside container (mirrors host path exactly)
  mode: 'ro' | 'rw';
  expiresAt?: number;      // Timestamp for timed grants
  durationMinutes?: number; // Granted duration (for UI progress bar)
  implicit?: boolean;      // true for docker-compose.yml built-in mounts (not passed as -v)
}

interface GatekeeperArgs {
  projectFolder?: string;
  writeAccess: boolean;
  model?: string;
  thinking?: string;
  headless: boolean;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
}

// --- State ---

const mounts: Mount[] = [
  // Implicit mounts from docker-compose.yml — shown in UI but not passed as -v flags.
  { hostPath: resolve(REPO_DIR), containerPath: '/app', mode: 'ro', implicit: true },
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
    } else if (arg === '--provider' && args[i + 1]) {
      result.provider = args[++i]!;
    } else if (arg === '--base-url' && args[i + 1]) {
      result.baseURL = args[++i]!;
    } else if (arg === '--api-key' && args[i + 1]) {
      result.apiKey = args[++i]!;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`aigent — AI agent with sandboxed execution

Usage: aigent [project-folder] [options]

Options:
  --rw                   Mount project folder read-write (default: read-only)
  --model <model>        Model to use (default: claude-opus-4-6)
  --thinking <level>     Thinking level: off, low, medium, high, max
  --headless             Web UI only, no terminal interface
  --provider <type>      LLM provider: anthropic (default) or openai
  --base-url <url>       Base URL for OpenAI-compatible endpoint
  --api-key <key>        API key / token for the LLM provider

Examples:
  aigent                                         # Anthropic (from env or ~/.config/aigent/provider.json)
  aigent ~/projects/myapp                        # Mount project read-only
  aigent ~/projects/myapp --rw                   # Mount project read-write
  aigent --headless                              # Web UI only at localhost:3141
  aigent --provider openai --base-url http://localhost:11434/v1 --api-key x  # Ollama

Persistent config (~/.config/aigent/provider.json):
  { "provider": "openai", "baseURL": "http://localhost:11434/v1", "apiKey": "your-token" }

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
  // Mirror the host path exactly so the agent never has to guess or translate.
  return hostPath;
}

/** Reverse-map a container path to a host path.
 *  Container paths mirror host paths, so this is mostly a passthrough with
 *  prefix matching for the implicit /app and /workspace mounts. */
function resolveContainerToHost(containerPath: string): string | null {
  // Check dynamic mounts first (container path mirrors host path)
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

function addMount(hostPath: string, mode: 'ro' | 'rw', expiresAt?: number, durationMinutes?: number): { ok: boolean; message: string } {
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
    if (expiresAt !== undefined) existing.expiresAt = expiresAt;
    return { ok: true, message: `Updated ${normalized} to ${mode}.` };
  }

  mounts.push({
    hostPath: normalized,
    containerPath: toContainerPath(normalized),
    mode,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(durationMinutes !== undefined ? { durationMinutes } : {}),
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
      ...(m.expiresAt !== undefined ? { expiresAt: m.expiresAt } : {}),
      ...(m.durationMinutes !== undefined ? { durationMinutes: m.durationMinutes } : {}),
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

  // Environment — CLI flags take precedence over .env values
  const model = gatekeeperArgs.model ?? process.env['AIGENT_MODEL'];
  if (model) {
    args.push('-e', `AIGENT_MODEL=${model}`);
  }
  const thinking = gatekeeperArgs.thinking ?? process.env['AIGENT_THINKING'];
  if (thinking) {
    args.push('-e', `AIGENT_THINKING=${thinking}`);
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
      // Graceful shutdown: SIGTERM lets the worker run shutdown() → doAutoSave()
      // so conversation history (including any in-flight mount request turn) is preserved.
      // docker stop waits up to 15s before SIGKILL.
      execSync(`docker stop --time 15 ${containerName} 2>/dev/null`, { stdio: 'ignore' });
      execSync(`docker rm ${containerName} 2>/dev/null`, { stdio: 'ignore' });
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
const GATEKEEPER_COMMANDS = new Set(['/mount', '/unmount', '/mounts', '/grant', '/deny', '/approve', '/reject', '/preview', '/approve-patch', '/reject-patch', '/approve-exec', '/deny-exec', '/approve-fetch', '/deny-fetch', '/set-env']);

function isGatekeeperCommand(input: string): boolean {
  const cmd = input.trim().split(/\s+/)[0]?.toLowerCase();
  return cmd ? GATEKEEPER_COMMANDS.has(cmd) : false;
}

/**
 * Update or insert env vars in the .env file.
 * Empty-string values remove the key. Boolean false for toggle keys → removes key.
 */
function writeEnvVars(updates: Record<string, boolean | number | string>): void {
  const envPath = resolve(REPO_DIR, '.env');
  let content = existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
  const lines = content.split('\n');

  for (const [key, rawValue] of Object.entries(updates)) {
    // Determine the string value to write
    let value: string | null;
    if (typeof rawValue === 'boolean') {
      value = rawValue ? '1' : null; // false → remove the line
    } else {
      const s = String(rawValue).trim();
      value = s === '' ? null : s; // empty string → remove
    }

    // Apply immediately to running process
    if (value !== null) {
      process.env[key] = value;
    } else {
      delete process.env[key];
    }

    // Find existing line (active or commented)
    const activeIdx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const commentedIdx = lines.findIndex((l) => /^#+\s*/.test(l) && l.includes(`${key}=`));

    if (value === null) {
      // Remove active line if present
      if (activeIdx !== -1) lines.splice(activeIdx, 1);
    } else {
      const newLine = `${key}=${value}`;
      if (activeIdx !== -1) {
        lines[activeIdx] = newLine;
      } else if (commentedIdx !== -1) {
        // Replace commented line with active one
        lines[commentedIdx] = newLine;
      } else {
        lines.push(newLine);
      }
    }
  }

  writeFileSync(envPath, lines.join('\n'), 'utf-8');
}

async function handleGatekeeperCommand(input: string): Promise<void> {
  // Check dynamic commands first (grant/deny, approve/reject/preview)
  if (await handleGrantDeny(input)) return;
  if (await handleConfigApproveReject(input)) return;
  if (await handleEditFileApproveReject(input)) return;
  if (await handleExecApproveReject(input)) return;
  if (await handleFetchApproveReject(input)) return;

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
        injectSystemMessage('Sandbox restarting with new mount...');
        await restartContainer();
        injectSystemMessage(`Sandbox ready. ${hostPath} is now mounted at ${toContainerPath(hostPath)} (${mode}).`);
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
        injectSystemMessage('Sandbox restarting without the removed mount...');
        await restartContainer();
        injectSystemMessage(`Sandbox ready. ${hostPath} has been unmounted.`);
      }
      break;
    }

    case '/set-env': {
      const jsonStr = input.slice('/set-env'.length).trim();
      let updates: Record<string, boolean | number | string>;
      try {
        updates = JSON.parse(jsonStr) as Record<string, boolean | number | string>;
      } catch {
        injectSystemMessage('Settings: failed to parse update payload.');
        break;
      }
      try {
        writeEnvVars(updates);
        const keys = Object.keys(updates).join(', ');
        injectSystemMessage(`Settings saved to .env: ${keys}\nRestart the gatekeeper for changes to take effect.`);
      } catch (err) {
        injectSystemMessage(`Settings: failed to write .env — ${(err as Error).message}`);
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
  _reason?: string,
  durationMinutes?: number,
): Promise<void> {
  // The agent sends container paths (e.g., /app/src). Try to reverse-map first.
  const hostPath = resolveContainerToHost(path) ?? resolveHostPath(path);

  // Store pending request — resolved when user replies /grant or /deny
  pendingAgentMountRequests.set(id, { hostPath, mode, ...(durationMinutes !== undefined ? { durationMinutes } : {}) });
}

const pendingAgentMountRequests = new Map<string, { hostPath: string; mode: 'ro' | 'rw'; durationMinutes?: number }>();

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

    const expiresAt = pending.durationMinutes
      ? Date.now() + pending.durationMinutes * 60_000
      : undefined;
    const result = addMount(pending.hostPath, mode, expiresAt, pending.durationMinutes);
    const containerPath = toContainerPath(pending.hostPath);

    // Send response to worker
    client!.send({
      type: 'mount_response',
      id,
      ok: result.ok,
      ...(result.ok ? { containerPath } : {}),
      message: result.message,
    });

    log.info('Mount granted', { id, path: pending.hostPath, mode, durationMinutes: pending.durationMinutes });
    injectSystemMessage(result.message);
    if (result.ok) {
      injectSystemMessage('Sandbox restarting with new mount...');
      await restartContainer();
      const expiryText = pending.durationMinutes
        ? ` (auto-expires in ${pending.durationMinutes} min)`
        : '';
      injectSystemMessage(`Sandbox ready. ${pending.hostPath} is now mounted at ${containerPath} (${mode})${expiryText}.`);
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

// --- Host edit-file requests (str_replace with index disambiguation) ---

interface ResolvedEdit {
  old_str: string;
  new_str: string;
  /** Which occurrence to replace (0-based). Resolved eagerly from index or default 0 when unambiguous. */
  occurrenceIndex: number;
  /** Line number (1-based) of the chosen occurrence in the original file. For diff display. */
  lineNumber: number;
}

interface PendingEditFile {
  hostPath: string;
  /** Original file content at request time. Applied against this. */
  originalContent: string;
  /** Resolved edits ready to apply in order. */
  resolvedEdits: ResolvedEdit[];
  reason: string;
}

const pendingEditFileRequests = new Map<string, PendingEditFile>();

/** Find all start indices of needle in haystack. */
function findAllOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + 1;
  }
  return positions;
}

/** Return the 1-based line number for a char offset in text. */
function lineOfOffset(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/** Build a simple unified-diff-style string for display (no need for exact unified format, just readable). */
function buildDisplayDiff(original: string, updated: string, label: string): string {
  const origLines = original.split('\n');
  const updLines = updated.split('\n');
  const maxLen = Math.max(origLines.length, updLines.length);
  const hunks: string[] = [`--- ${label} (original)`, `+++ ${label} (proposed)`];
  for (let i = 0; i < maxLen; i++) {
    const o = origLines[i];
    const u = updLines[i];
    if (o === u) {
      if (o !== undefined) hunks.push(`  ${o}`);
    } else {
      if (o !== undefined) hunks.push(`- ${o}`);
      if (u !== undefined) hunks.push(`+ ${u}`);
    }
  }
  return hunks.join('\n');
}

function handleEditFileRequest(
  id: string,
  containerPath: string,
  edits: Array<{ old_str: string; new_str: string; index?: number }>,
  reason: string,
): void {
  const hostPath = resolveContainerToHost(containerPath) ?? resolveHostPath(containerPath);

  if (isForbiddenPath(hostPath)) {
    client!.send({ type: 'edit_file_response', id, ok: false, message: `Refusing to edit ${hostPath} — sensitive path` });
    return;
  }

  let originalContent: string;
  try {
    originalContent = readFileSync(hostPath, 'utf-8');
  } catch {
    client!.send({ type: 'edit_file_response', id, ok: false, message: `Cannot read ${hostPath}` });
    return;
  }

  // Eagerly resolve each edit against the file state after previous edits.
  const resolvedEdits: ResolvedEdit[] = [];
  let workingContent = originalContent;
  let lineOffset = 0; // net line delta from edits applied so far

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]!;
    const positions = findAllOccurrences(workingContent, edit.old_str);

    if (positions.length === 0) {
      client!.send({ type: 'edit_file_response', id, ok: false, message: `Edit ${i + 1}: old_str not found in ${hostPath}` });
      return;
    }

    if (positions.length > 1 && edit.index === undefined) {
      const lineNumbers = positions.map((p) => lineOfOffset(workingContent, p) + lineOffset);
      client!.send({
        type: 'edit_file_response',
        id,
        ok: false,
        message:
          `Edit ${i + 1}: old_str matches ${positions.length} times in ${hostPath} at lines [${lineNumbers.join(', ')}]. ` +
          `Retry with index (0-based) to select which occurrence to replace.`,
      });
      return;
    }

    const occurrenceIndex = edit.index ?? 0;
    if (occurrenceIndex < 0 || occurrenceIndex >= positions.length) {
      client!.send({
        type: 'edit_file_response',
        id,
        ok: false,
        message: `Edit ${i + 1}: index ${occurrenceIndex} out of range — only ${positions.length} occurrence(s) found.`,
      });
      return;
    }

    const charPos = positions[occurrenceIndex]!;
    const lineNumber = lineOfOffset(workingContent, charPos) + lineOffset;

    resolvedEdits.push({ old_str: edit.old_str, new_str: edit.new_str, occurrenceIndex, lineNumber });

    // Apply to working content so subsequent edits see the updated file.
    workingContent =
      workingContent.slice(0, charPos) +
      edit.new_str +
      workingContent.slice(charPos + edit.old_str.length);

    // Track line offset shift for subsequent edits' line number reporting.
    lineOffset += edit.new_str.split('\n').length - edit.old_str.split('\n').length;
  }

  pendingEditFileRequests.set(id, { hostPath, originalContent, resolvedEdits, reason });

  const diff = buildDisplayDiff(originalContent, workingContent, hostPath);
  const editSummary = resolvedEdits.map((e, i) =>
    `  Edit ${i + 1}: replace occurrence ${e.occurrenceIndex} at line ${e.lineNumber}`
  ).join('\n');

  // Emit a patch_request event so the web UI shows the diff modal with approve/reject buttons.
  // Fall back to a system message if no client is connected yet.
  if (client) {
    client.emit('patch_request', id, diff, reason);
  } else {
    injectSystemMessage(
      `Agent wants to edit ${hostPath}\n` +
      `  Reason: "${reason}"\n` +
      `  ${resolvedEdits.length} edit${resolvedEdits.length > 1 ? 's' : ''}:\n${editSummary}\n\n` +
      `\`\`\`diff\n${diff}\n\`\`\`\n\n` +
      `Reply: /approve-edit or /reject-edit`
    );
  }
}

async function handleEditFileApproveReject(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve-edit' || cmd === '/approve-patch') {
    let id = parts[1];
    if (!id && pendingEditFileRequests.size === 1) {
      id = pendingEditFileRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingEditFileRequests.size === 0
        ? 'No pending edit requests.'
        : `Multiple pending — specify ID: ${[...pendingEditFileRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingEditFileRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending edit request: ${id}`);
      return true;
    }

    pendingEditFileRequests.delete(id);

    // Re-apply edits against the original snapshot in order.
    let content = pending.originalContent;
    for (let i = 0; i < pending.resolvedEdits.length; i++) {
      const edit = pending.resolvedEdits[i]!;
      const positions = findAllOccurrences(content, edit.old_str);
      if (positions.length === 0 || edit.occurrenceIndex >= positions.length) {
        const msg = `Edit ${i + 1}: file changed since approval — old_str no longer found at expected position.`;
        log.error('Edit apply failed', { id, error: msg });
        client!.send({ type: 'edit_file_response', id, ok: false, message: msg });
        injectSystemMessage(`Edit failed: ${msg}`);
        return true;
      }
      const charPos = positions[edit.occurrenceIndex]!;
      content = content.slice(0, charPos) + edit.new_str + content.slice(charPos + edit.old_str.length);
    }

    try {
      writeFileSync(pending.hostPath, content, 'utf-8');
      log.info('Edit applied', { id, path: pending.hostPath, edits: pending.resolvedEdits.length });
      client!.send({ type: 'edit_file_response', id, ok: true, message: `Applied ${pending.resolvedEdits.length} edit(s) to ${pending.hostPath}` });
      injectSystemMessage(`Approved: edit applied to ${pending.hostPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Edit write failed', { id, error: msg });
      client!.send({ type: 'edit_file_response', id, ok: false, message: `Write failed: ${msg}` });
      injectSystemMessage(`Edit failed: ${msg}`);
    }
    return true;
  }

  if (cmd === '/reject-edit' || cmd === '/reject-patch') {
    let id = parts[1];
    if (!id && pendingEditFileRequests.size === 1) {
      id = pendingEditFileRequests.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingEditFileRequests.size === 0
        ? 'No pending edit requests.'
        : `Multiple pending — specify ID: ${[...pendingEditFileRequests.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingEditFileRequests.get(id);
    if (!pending) {
      injectSystemMessage(`No pending edit request: ${id}`);
      return true;
    }

    pendingEditFileRequests.delete(id);
    log.info('Edit rejected', { id });
    client!.send({ type: 'edit_file_response', id, ok: false, message: 'Edit rejected by user' });
    injectSystemMessage(`Rejected edit for ${pending.hostPath}`);
    return true;
  }

  return false;
}

// --- Exec command approval ---

const pendingExecApprovals = new Map<string, { command: string }>();
// IDs auto-handled (allow/deny) before any browser listener fires — web-bridge skips these
const autoHandledExecIds = new Set<string>();

const SETTINGS_PATH = resolve(REPO_DIR, 'settings.json');

function readExecPermissions(): ExecPermissions {
  try {
    if (!existsSync(SETTINGS_PATH)) return DEFAULT_EXEC_PERMISSIONS;
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = settings['exec_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_EXEC_PERMISSIONS;
    const p = perms as Partial<ExecPermissions>;
    return {
      alwaysAllow: Array.isArray(p.alwaysAllow) ? p.alwaysAllow : DEFAULT_EXEC_PERMISSIONS.alwaysAllow,
      prompt: Array.isArray(p.prompt) ? p.prompt : DEFAULT_EXEC_PERMISSIONS.prompt,
      deny: Array.isArray(p.deny) ? p.deny : DEFAULT_EXEC_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_EXEC_PERMISSIONS;
  }
}

function addCommandToAlwaysAllow(command: string): void {
  try {
    const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf-8') : '{}';
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
    const current = Array.isArray(perms.alwaysAllow) ? perms.alwaysAllow : [...DEFAULT_EXEC_PERMISSIONS.alwaysAllow];
    if (!current.includes(command)) {
      current.push(command);
    }
    settings['exec_permissions'] = { ...DEFAULT_EXEC_PERMISSIONS, ...perms, alwaysAllow: current };
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    log.info('Added command to always-allow', { command });
  } catch (err) {
    log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function handleAgentExecRequest(id: string, command: string): void {
  const permissions = readExecPermissions();
  const level = checkExecPermission(command, permissions);

  if (level === 'allow') {
    log.info('Exec auto-allowed', { id, command });
    autoHandledExecIds.add(id);
    client!.send({ type: 'exec_response', id, ok: true, message: 'Allowed by permission policy' });
    return;
  }

  if (level === 'deny') {
    log.info('Exec auto-denied', { id, command });
    autoHandledExecIds.add(id);
    client!.send({ type: 'exec_response', id, ok: false, message: 'Denied by permission policy' });
    injectSystemMessage(`[exec] Blocked by deny policy: ${command}`);
    return;
  }

  // 'prompt' — store and forward to web UI for user approval
  pendingExecApprovals.set(id, { command });
  log.info('Exec approval requested', { id, command });

  // Inject a message so TUI users also see the prompt
  injectSystemMessage(
    `Agent wants to run: ${command}\n` +
    `  Reply: /approve-exec ${id} or /deny-exec ${id}\n` +
    `  To always allow: /approve-exec ${id} --always`
  );
}

async function handleExecApproveReject(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve-exec') {
    let id = parts[1];
    if (!id && pendingExecApprovals.size === 1) {
      id = pendingExecApprovals.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingExecApprovals.size === 0
        ? 'No pending exec requests.'
        : `Multiple pending — specify ID: ${[...pendingExecApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingExecApprovals.get(id);
    if (!pending) {
      injectSystemMessage(`No pending exec request: ${id}`);
      return true;
    }

    const alwaysAllow = parts.includes('--always');
    pendingExecApprovals.delete(id);

    if (alwaysAllow) {
      addCommandToAlwaysAllow(pending.command);
      injectSystemMessage(`Approved and added to always-allow: ${pending.command}`);
    } else {
      injectSystemMessage(`Approved (once): ${pending.command}`);
    }

    client!.send({ type: 'exec_response', id, ok: true, alwaysAllow, message: 'Approved by user' });
    return true;
  }

  if (cmd === '/deny-exec') {
    let id = parts[1];
    if (!id && pendingExecApprovals.size === 1) {
      id = pendingExecApprovals.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingExecApprovals.size === 0
        ? 'No pending exec requests.'
        : `Multiple pending — specify ID: ${[...pendingExecApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingExecApprovals.get(id);
    if (!pending) {
      injectSystemMessage(`No pending exec request: ${id}`);
      return true;
    }

    pendingExecApprovals.delete(id);
    injectSystemMessage(`Denied: ${pending.command}`);
    client!.send({ type: 'exec_response', id, ok: false, alwaysAllow: false, message: 'Denied by user' });
    return true;
  }

  return false;
}

// --- Fetch URL approval ---

const pendingFetchApprovals = new Map<string, { url: string; method?: string }>();
const autoHandledFetchIds = new Set<string>();

function readFetchPermissions(): FetchPermissions {
  try {
    if (!existsSync(SETTINGS_PATH)) return DEFAULT_FETCH_PERMISSIONS;
    const raw = readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = settings['fetch_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_FETCH_PERMISSIONS;
    const p = perms as Partial<FetchPermissions>;
    return {
      alwaysAllow: Array.isArray(p.alwaysAllow) ? p.alwaysAllow : DEFAULT_FETCH_PERMISSIONS.alwaysAllow,
      prompt: Array.isArray(p.prompt) ? p.prompt : DEFAULT_FETCH_PERMISSIONS.prompt,
      deny: Array.isArray(p.deny) ? p.deny : DEFAULT_FETCH_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_FETCH_PERMISSIONS;
  }
}

function addDomainToAlwaysAllow(hostname: string): void {
  try {
    const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf-8') : '{}';
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = (settings['fetch_permissions'] as Partial<FetchPermissions> | undefined) ?? {};
    const current = Array.isArray(perms.alwaysAllow) ? perms.alwaysAllow : [...DEFAULT_FETCH_PERMISSIONS.alwaysAllow];
    if (!current.includes(hostname)) {
      current.push(hostname);
    }
    settings['fetch_permissions'] = { ...DEFAULT_FETCH_PERMISSIONS, ...perms, alwaysAllow: current };
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    log.info('Added domain to fetch always-allow', { hostname });
  } catch (err) {
    log.error('Failed to update fetch permissions', { error: String(err) });
  }
}

function handleAgentFetchRequest(id: string, url: string, method?: string): void {
  const permissions = readFetchPermissions();
  const level = checkFetchPermission(url, permissions);

  if (level === 'allow') {
    log.info('Fetch auto-allowed', { id, url });
    autoHandledFetchIds.add(id);
    client!.send({ type: 'fetch_response', id, ok: true, message: 'Allowed by permission policy' });
    return;
  }

  if (level === 'deny') {
    log.info('Fetch auto-denied', { id, url });
    autoHandledFetchIds.add(id);
    client!.send({ type: 'fetch_response', id, ok: false, message: 'Denied by permission policy' });
    injectSystemMessage(`[fetch] Blocked by deny policy: ${url}`);
    return;
  }

  // 'prompt' — store and forward to web UI for user approval
  pendingFetchApprovals.set(id, { url, ...(method !== undefined ? { method } : {}) });
  log.info('Fetch approval requested', { id, url, method });

  injectSystemMessage(
    `Agent wants to fetch: ${method ?? 'GET'} ${url}\n` +
    `  Reply: /approve-fetch ${id} or /deny-fetch ${id}\n` +
    `  To always allow this domain: /approve-fetch ${id} --always`
  );
}

async function handleFetchApproveReject(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd === '/approve-fetch') {
    let id = parts[1];
    if (!id && pendingFetchApprovals.size === 1) {
      id = pendingFetchApprovals.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingFetchApprovals.size === 0
        ? 'No pending fetch requests.'
        : `Multiple pending — specify ID: ${[...pendingFetchApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingFetchApprovals.get(id);
    if (!pending) {
      injectSystemMessage(`No pending fetch request: ${id}`);
      return true;
    }

    const alwaysAllow = parts.includes('--always');
    pendingFetchApprovals.delete(id);

    if (alwaysAllow) {
      let hostname = pending.url;
      try { hostname = new URL(pending.url).hostname; } catch { /* keep raw */ }
      addDomainToAlwaysAllow(hostname);
      injectSystemMessage(`Approved and domain added to always-allow: ${hostname}`);
    } else {
      injectSystemMessage(`Approved (once): ${pending.url}`);
    }

    client!.send({ type: 'fetch_response', id, ok: true, alwaysAllow, message: 'Approved by user' });
    return true;
  }

  if (cmd === '/deny-fetch') {
    let id = parts[1];
    if (!id && pendingFetchApprovals.size === 1) {
      id = pendingFetchApprovals.keys().next().value as string;
    }
    if (!id) {
      injectSystemMessage(pendingFetchApprovals.size === 0
        ? 'No pending fetch requests.'
        : `Multiple pending — specify ID: ${[...pendingFetchApprovals.keys()].join(', ')}`);
      return true;
    }

    const pending = pendingFetchApprovals.get(id);
    if (!pending) {
      injectSystemMessage(`No pending fetch request: ${id}`);
      return true;
    }

    pendingFetchApprovals.delete(id);
    injectSystemMessage(`Denied: ${pending.url}`);
    client!.send({ type: 'fetch_response', id, ok: false, alwaysAllow: false, message: 'Denied by user' });
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
  // CLI flags take highest priority — apply them to env before detection
  if (gatekeeperArgs.provider) process.env['AIGENT_PROVIDER'] = gatekeeperArgs.provider;
  if (gatekeeperArgs.baseURL)  process.env['AIGENT_BASE_URL'] = gatekeeperArgs.baseURL;
  if (gatekeeperArgs.apiKey)   process.env['AIGENT_API_KEY']  = gatekeeperArgs.apiKey;

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
startWebServer(client, undefined, { autoHandledExecIds, getExecPermissions: readExecPermissions, autoHandledFetchIds, getFetchPermissions: readFetchPermissions }).then(({ port }) => {
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
client.on('mount_request', (id: string, path: string, mode: 'ro' | 'rw', reason?: string, durationMinutes?: number) => {
  void handleAgentMountRequest(id, path, mode, reason, durationMinutes);
});

// Handle config write requests from the worker
client.on('config_write_request', (id: string, file: string, content: string, reason: string) => {
  handleConfigWriteRequest(id, file, content, reason);
});

// Handle edit_file requests from the worker
client.on('edit_file_request', (id: string, path: string, edits: Array<{ old_str: string; new_str: string; index?: number }>, reason: string) => {
  handleEditFileRequest(id, path, edits, reason);
});

// Handle exec approval requests from the worker
client.on('exec_request', (id: string, command: string) => {
  handleAgentExecRequest(id, command);
});

// Handle fetch approval requests from the worker
client.on('fetch_request', (id: string, url: string, method?: string) => {
  handleAgentFetchRequest(id, url, method);
});

// Expiry timer — check every 30s for mounts that have timed out
let expiryRestartInProgress = false;
setInterval(() => {
  const now = Date.now();
  const expired = mounts.filter((m) => !m.implicit && m.expiresAt !== undefined && m.expiresAt <= now);
  if (expired.length === 0 || expiryRestartInProgress) return;

  expiryRestartInProgress = true;
  for (const m of expired) {
    removeMount(m.hostPath);
    injectSystemMessage(`Mount expired and removed: ${m.hostPath}`);
  }
  injectSystemMessage('Sandbox restarting to apply expired mount removal...');
  restartContainer()
    .then(() => {
      injectSystemMessage('Sandbox ready.');
      emitHostState();
    })
    .finally(() => { expiryRestartInProgress = false; });
}, 30_000);

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
