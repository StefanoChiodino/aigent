#!/usr/bin/env tsx
/**
 * Gatekeeper — runs on the host, spawns the server process directly.
 *
 * Responsibilities:
 *   - Server process lifecycle (start, stop, restart)
 *   - Three-tier command safety (static deny → static allow → Haiku classifier)
 *   - LLM proxy (API keys never enter the server process)
 *   - Web UI bridge (WebSocket ↔ Unix socket)
 *   - OS bridge (clipboard, audio, etc.)
 *   - File watcher for self-modification auto-restart
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync, createWriteStream, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config'; // Load .env from cwd (repo root)
import { fileURLToPath } from 'node:url';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';
import { createLogger } from './logger.js';
import { checkExecPermission, checkTier1Deny, DEFAULT_EXEC_PERMISSIONS, type ExecPermissions, checkFetchPermission, DEFAULT_FETCH_PERMISSIONS, type FetchPermissions, checkFilePermission, DEFAULT_FILE_PERMISSIONS, type FilePermissions, checkMCPPermission, DEFAULT_MCP_PERMISSIONS, type MCPPermissions, parseCommandPipeline, shouldForceClassify } from './safety.js';
import { initClassifier, classifyCommand, classifyFileAccess, isClassifierAvailable } from './classifier.js';
import { extensionBridge } from './ext-bridge.js';
import { auditLog } from './audit.js';
import { detectDestructiveSteps, validateBrowserUrls } from './browser-safety.js';
import { readSettingsSync, writeSettingsSync, getSettingsPath } from './settings-file.js';
import {
  handleConfigWriteRequest as _handleConfigWriteRequest,
  handleConfigApproveReject as _handleConfigApproveReject,
  handleEditFileRequest as _handleEditFileRequest,
  handleEditFileApproveReject as _handleEditFileApproveReject,
  type ConfigWriteContext,
} from './gk-config-writes.js';

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

interface GatekeeperArgs {
  model?: string;
  thinking?: string;
  headless: boolean;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
}

// --- State ---

let serverProcess: ChildProcess | null = null;
let gatekeeperArgs: GatekeeperArgs;
let client: InstanceType<typeof import('./client.js').AgentClient> | null = null;
let isRestarting = false;

// In test mode the server is not started, so injected requests are never registered
// in the pending maps. Suppress "no pending X" error messages to keep tests clean.
const IS_TEST_MODE = process.env['AIGENT_TEST_MODE'] === '1';

// --- CLI args ---

function parseArgs(): GatekeeperArgs {
  const args = process.argv.slice(2);
  const result: GatekeeperArgs = { headless: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--model' && args[i + 1]) {
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
      console.log(`aigent — AI agent with three-tier command safety

Usage: aigent [options]

Options:
  --model <model>        Model to use (default: claude-opus-4-6)
  --thinking <level>     Thinking level: off, low, medium, high, max
  --headless             Web UI only, no terminal interface
  --provider <type>      LLM provider: anthropic (default) or openai
  --base-url <url>       Base URL for OpenAI-compatible endpoint
  --api-key <key>        API key / token for the LLM provider

Examples:
  aigent                                         # Anthropic (from env or ~/.config/aigent/provider.json)
  aigent --headless                              # Web UI only at localhost:3141
  aigent --provider openai --base-url http://localhost:11434/v1 --api-key x  # Ollama

Persistent config (~/.config/aigent/provider.json):
  { "provider": "openai", "baseURL": "http://localhost:11434/v1", "apiKey": "your-token" }
`);
      process.exit(0);
    }
  }

  return result;
}

// --- Utility ---

/** Resolve ~ and relative paths. */
function resolveHostPath(input: string): string {
  if (input.startsWith('~')) {
    return resolve(homedir(), input.slice(2));
  }
  return resolve(input);
}

/** Capabilities that have an actual provider implementation. */
const IMPLEMENTED_CAPS = new Set(['clipboard.read', 'clipboard.write']);

/** Read capability permissions from the host daemon's config file. */
function readCapabilities(): Record<string, { grant: string; available: boolean }> {
  const configPath = join(homedir(), '.config', 'aigent', 'permissions.json');
  let grants: Record<string, string>;
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, { grant: string }>;
    grants = {};
    for (const [cap, entry] of Object.entries(parsed)) {
      grants[cap] = entry.grant;
    }
  } catch {
    // No config or invalid — use defaults
    grants = {
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
  const result: Record<string, { grant: string; available: boolean }> = {};
  for (const [cap, grant] of Object.entries(grants)) {
    result[cap] = { grant, available: IMPLEMENTED_CAPS.has(cap) };
  }
  return result;
}

/** Push current host state (capabilities) to all UI listeners. */
function emitHostState(): void {
  if (!client) return;
  client.emit('host_state', readCapabilities());
}

// --- Server lifecycle (direct spawn, no Docker) ---

// Crash restart rate limiting
const MAX_CRASH_RESTARTS = 3;
const CRASH_WINDOW_MS = 30_000;
let crashTimestamps: number[] = [];

function startServerProcess(): void {
  const serverEntry = resolve(__dirname, 'server.ts');
  const tsconfig = resolve(REPO_DIR, 'tsconfig.json');

  log.info('Starting server...');

  serverProcess = spawn('tsx', ['--tsconfig', tsconfig, serverEntry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: REPO_DIR,
    env: {
      ...process.env,
      AIGENT_WORKSPACE: process.env['AIGENT_WORKSPACE'] ?? resolve(REPO_DIR, 'workspace'),
    },
  });

  // Pipe server output to log file instead of terminal
  serverProcess.stdout?.pipe(logStream, { end: false });
  serverProcess.stderr?.pipe(logStream, { end: false });

  serverProcess.on('error', (err) => {
    log.error('Failed to start server', { error: err.message });
    if (!isRestarting) process.exit(1);
  });

  serverProcess.on('exit', (code, signal) => {
    serverProcess = null;

    if (isRestarting) {
      setTimeout(startServerProcess, 300);
      return;
    }

    // Code 100 = /restart command — clean restart
    if (code === 100) {
      log.info('Restart requested — restarting server');
      setTimeout(startServerProcess, 300);
      return;
    }

    // Unexpected crash — restart with rate limiting
    if (signal !== 'SIGTERM' && signal !== 'SIGINT' && code !== 0) {
      const now = Date.now();
      crashTimestamps = crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS);
      crashTimestamps.push(now);

      if (crashTimestamps.length >= MAX_CRASH_RESTARTS) {
        log.error('Crash loop — stopping', { crashes: crashTimestamps.length });
        process.exit(1);
      }

      log.warn('Server crashed — restarting', { code, signal, crashes: crashTimestamps.length });
      setTimeout(startServerProcess, 1000);
      return;
    }

    // Normal exit
    log.info('Server exited', { code, signal });
    cleanupSocket();
    process.exit(code ?? 0);
  });
}

async function restartServer(): Promise<void> {
  isRestarting = true;

  if (serverProcess) {
    serverProcess.removeAllListeners('exit');
    serverProcess.removeAllListeners('error');
    try { serverProcess.kill('SIGTERM'); } catch {}
    serverProcess = null;
  }

  cleanupSocket();
  await new Promise<void>((r) => setTimeout(r, 500));

  try {
    startServerProcess();
    await waitForSocket();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('Server restart slow', { error: msg });
    injectSystemMessage(
      `Server is slow to start. Will auto-reconnect when ready.\n` +
      `If it doesn't recover, try /restart.`
    );
  } finally {
    isRestarting = false;
    emitHostState();
  }
}

// --- File watcher (self-modification auto-restart, ported from worker.ts) ---

const SRC_DIR = join(REPO_DIR, 'src');

function getFileHashes(dir: string): Map<string, number> {
  const hashes = new Map<string, number>();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const [k, v] of getFileHashes(full)) hashes.set(k, v);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        try {
          hashes.set(full, statSync(full).mtimeMs);
        } catch {}
      }
    }
  } catch {}
  return hashes;
}

let lastFileHashes = getFileHashes(SRC_DIR);
let fileWatchDebounce: ReturnType<typeof setTimeout> | null = null;

function startFileWatcher(): void {
  setInterval(() => {
    const current = getFileHashes(SRC_DIR);
    let changed = false;
    for (const [file, mtime] of current) {
      if (lastFileHashes.get(file) !== mtime) {
        changed = true;
        break;
      }
    }
    if (current.size !== lastFileHashes.size) changed = true;

    if (changed) {
      lastFileHashes = current;
      if (fileWatchDebounce) clearTimeout(fileWatchDebounce);
      fileWatchDebounce = setTimeout(() => {
        fileWatchDebounce = null;

        // Typecheck before restarting
        log.info('Source files changed — typechecking');
        try {
          execSync('npx tsc --noEmit', {
            cwd: REPO_DIR,
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 30_000,
          });
          log.info('Typecheck passed — restarting server');
        } catch (err: unknown) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
          const errorLines = stderr.split('\n').filter((l: string) => l.includes('error TS')).slice(0, 5);
          const detail = errorLines.length > 0 ? errorLines.map((l: string) => l.trim()).join('; ') : stderr.slice(0, 500);
          log.warn('Typecheck failed — not restarting', { errors: detail });
          return;
        }

        void restartServer();
      }, 2000);
    }
  }, 1000);
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
  // across server restarts. It cleans up its own socket in LLMProxy.start().
}

function cleanupAll(): void {
  stopHostDaemon();
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
  }
  cleanupSocket();
}

// --- Command interception ---

/** Commands the gatekeeper handles locally (not forwarded to worker). */
const GATEKEEPER_COMMANDS = new Set(['/approve', '/reject', '/preview', '/approve-patch', '/reject-patch', '/approve-exec', '/deny-exec', '/approve-fetch', '/deny-fetch', '/approve-file', '/deny-file', '/approve-fetchsize', '/deny-fetchsize', '/approve-mcp', '/deny-mcp', '/approve-browser-write', '/deny-browser-write', '/grant-browser-autonomous', '/revoke-browser-autonomous', '/set-env']);

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
  // Check dynamic commands first (approve/reject/preview)
  if (await handleConfigApproveReject(input)) return;
  if (await handleEditFileApproveReject(input)) return;
  if (await handleExecApproveReject(input)) return;
  if (await handleFetchApproveReject(input)) return;
  if (handleFileAccessApproveReject(input)) return;
  if (handleFetchSizeApproveReject(input)) return;
  if (handleMcpToolApproveReject(input)) return;
  if (await handleBrowserWriteApproveReject(input)) return;
  if (handleBrowserAutonomousGrant(input)) return;

  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
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

// --- Config write & edit-file requests (delegated to gk-config-writes.ts) ---

function getConfigWriteContext(): ConfigWriteContext {
  return { client, log, injectSystemMessage, IS_TEST_MODE, REPO_DIR, resolveHostPath };
}

function handleConfigWriteRequest(id: string, file: string, content: string, reason: string): void {
  _handleConfigWriteRequest(getConfigWriteContext(), id, file, content, reason);
}

function handleConfigApproveReject(input: string): Promise<boolean> {
  return _handleConfigApproveReject(getConfigWriteContext(), input);
}

function handleEditFileRequest(
  id: string,
  containerPath: string,
  edits: Array<{ old_str: string; new_str: string; index?: number }>,
  reason: string,
): void {
  // --- YOLO mode: auto-approve host_edit_file writes ---
  if (readSettingsSync()['file_perm_yolo'] === true) {
    const hostPath = resolveHostPath(containerPath);
    log.info('Edit auto-allowed (YOLO mode)', { id, path: hostPath });
    auditLog({ type: 'file_write_yolo_allow', detail: hostPath });
    _handleEditFileRequest(getConfigWriteContext(), id, containerPath, edits, reason, true);
    return;
  }

  // Check file permissions — auto-apply if allowed, block if denied
  const filePerms = readFilePermissions();
  const hostPath = resolveHostPath(containerPath);
  const level = checkFilePermission(hostPath, filePerms, 'write');

  if (level === 'deny') {
    log.info('Edit auto-denied by file permission policy', { id, path: hostPath });
    auditLog({ type: 'file_write_block', detail: hostPath, reason: 'denied by file_permissions (host_edit_file)' });
    client!.send({ type: 'edit_file_response', id, ok: false, message: 'Denied by file permission policy' });
    injectSystemMessage(`[file] Blocked by deny policy: ${hostPath}`);
    return;
  }

  if (level === 'allow') {
    log.info('Edit auto-allowed by file permission policy', { id, path: hostPath });
    auditLog({ type: 'file_write', detail: hostPath, reason: 'allowed by file_permissions (host_edit_file)' });
  }

  _handleEditFileRequest(getConfigWriteContext(), id, containerPath, edits, reason, level === 'allow');
}

function handleEditFileApproveReject(input: string): Promise<boolean> {
  return _handleEditFileApproveReject(getConfigWriteContext(), input);
}

// --- Classifier decision metadata ---
// Shared with web-bridge so it can broadcast decisions to browser clients.
export interface ClassifierDecision { tier: 1 | 2 | 3; action: 'allow' | 'block' | 'ask'; reason: string }
const classifierDecisions = new Map<string, ClassifierDecision>();

// Rolling buffer of recent conversation messages (last 2 rounds = up to 4 messages).
// Used to give the Tier 3 classifier conversation context.
const RECENT_MSG_LIMIT = 4;
const recentMessages: Array<{ role: string; content: string }> = [];

function getRecentContext(): string | undefined {
  if (recentMessages.length === 0) return undefined;
  return recentMessages
    .map(m => `[${m.role}]: ${m.content.slice(0, 300)}`)
    .join('\n');
}

// --- Exec command approval ---

const pendingExecApprovals = new Map<string, {
  command: string;
  classifierReason?: string;
  suggestedPatterns?: string[];
}>();
// IDs auto-handled (allow/deny) before any browser listener fires — web-bridge skips these
const autoHandledExecIds = new Set<string>();

function readExecPermissions(): ExecPermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['exec_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_EXEC_PERMISSIONS;
    const p = perms as Partial<ExecPermissions>;
    return {
      // alwaysAllow/alwaysClassify: user's list is authoritative — no default merging.
      // Defaults are only used as a fallback when the key doesn't exist at all.
      alwaysAllow: Array.isArray(p.alwaysAllow)
        ? p.alwaysAllow
        : DEFAULT_EXEC_PERMISSIONS.alwaysAllow,
      alwaysClassify: Array.isArray(p.alwaysClassify)
        ? p.alwaysClassify
        : DEFAULT_EXEC_PERMISSIONS.alwaysClassify,
      // deny: always merge with defaults for safety — prevents accidentally un-blocking
      // dangerous patterns like sudo, rm -rf /, etc.
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_EXEC_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_EXEC_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_EXEC_PERMISSIONS;
  }
}

/** Called by web-bridge when POST /settings completes — re-evaluate all pending approvals. */
function handleSettingsChanged(): void {
  broadcastUpdatedPermissions();
  flushPendingExecApprovals();
  flushPendingFetchApprovals();
  flushPendingFileAccessApprovals();
  flushPendingMCPApprovals();
}

function broadcastUpdatedPermissions(): void {
  if (!client) return;
  const settings = readSettingsSync();
  const execPerms = readExecPermissions();
  const fetchPerms = readFetchPermissions();
  const filePerms = readFilePermissions();
  const mcpPerms = readMCPPermissions();
  client.emit('permissions_updated', {
    exec_perm_alwaysAllow: JSON.stringify(execPerms.alwaysAllow),
    exec_perm_alwaysClassify: JSON.stringify(execPerms.alwaysClassify),
    exec_perm_deny: JSON.stringify(execPerms.deny),
    exec_perm_yolo: settings['exec_perm_yolo'] === true,
    fetch_perm_alwaysAllow: JSON.stringify(fetchPerms.alwaysAllow),
    fetch_perm_deny: JSON.stringify(fetchPerms.deny),
    fetch_perm_yolo: settings['fetch_perm_yolo'] === true,
    file_perm_readWrite: JSON.stringify(filePerms.readWrite),
    file_perm_readOnly: JSON.stringify(filePerms.readOnly),
    file_perm_deny: JSON.stringify(filePerms.deny),
    file_perm_yolo: settings['file_perm_yolo'] === true,
    mcp_perm_servers: JSON.stringify(mcpPerms.servers),
  });
}

/**
 * Derive glob patterns from a command for "always allow".
 * For simple commands, extracts the executable and returns both `"<exe>"` and `"<exe> *"`.
 * For pipelines or commands already containing globs, returns the raw command as-is.
 */
function deriveExecPatterns(command: string): string[] {
  const cmd = command.trim();
  // Already a glob pattern — save as-is
  if (cmd.includes('*') || cmd.includes('?') || cmd.includes('[')) return [cmd];
  // Pipeline — too complex to extract a meaningful pattern
  const segments = parseCommandPipeline(cmd);
  if (segments.length > 1) return [cmd];
  const exe = segments[0]?.executable;
  if (!exe) return [cmd];
  // Save both bare executable and "<exe> *" to cover args/no-args
  return [exe, `${exe} *`];
}

function addCommandToAlwaysAllow(command: string): void {
  try {
    const patterns = deriveExecPatterns(command);
    writeSettingsSync('gatekeeper:addToExecAlwaysAllow', (settings) => {
      const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.alwaysAllow) ? [...perms.alwaysAllow] : [...DEFAULT_EXEC_PERMISSIONS.alwaysAllow];
      for (const pattern of patterns) {
        if (!current.includes(pattern)) {
          current.push(pattern);
        }
      }
      return { ...settings, exec_permissions: { ...DEFAULT_EXEC_PERMISSIONS, ...perms, alwaysAllow: current } };
    });
    log.info('Added command to always-allow', { command, patterns });
    broadcastUpdatedPermissions();
    flushPendingExecApprovals();
  } catch (err) {
    log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function addCommandToDenyList(command: string): void {
  try {
    const patterns = deriveExecPatterns(command);
    writeSettingsSync('gatekeeper:addToExecDeny', (settings) => {
      const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.deny) ? [...perms.deny] : [...DEFAULT_EXEC_PERMISSIONS.deny];
      for (const pattern of patterns) {
        if (!current.includes(pattern)) {
          current.push(pattern);
        }
      }
      return { ...settings, exec_permissions: { ...DEFAULT_EXEC_PERMISSIONS, ...perms, deny: current } };
    });
    log.info('Added command to deny list', { command, patterns });
    broadcastUpdatedPermissions();
  } catch (err) {
    log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function addPatternsToAlwaysAllow(patterns: string[]): void {
  try {
    writeSettingsSync('gatekeeper:addClassifierPatterns', (settings) => {
      const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.alwaysAllow) ? [...perms.alwaysAllow] : [...DEFAULT_EXEC_PERMISSIONS.alwaysAllow];
      for (const pattern of patterns) {
        if (!current.includes(pattern)) {
          current.push(pattern);
        }
      }
      return { ...settings, exec_permissions: { ...DEFAULT_EXEC_PERMISSIONS, ...perms, alwaysAllow: current } };
    });
    log.info('Added classifier-suggested patterns to always-allow', { patterns });
    broadcastUpdatedPermissions();
    flushPendingExecApprovals();
  } catch (err) {
    log.error('Failed to update exec permissions', { error: String(err) });
  }
}

/** Re-check pending exec approvals against updated permissions and auto-resolve matches. */
function flushPendingExecApprovals(): void {
  if (pendingExecApprovals.size === 0) return;
  const yolo = readSettingsSync()['exec_perm_yolo'] === true;
  const permissions = readExecPermissions();
  const dismissed: string[] = [];
  for (const [id, pending] of pendingExecApprovals) {
    const shouldAllow = yolo || (checkExecPermission(pending.command, permissions) === 'allow' && !shouldForceClassify(pending.command, permissions.alwaysClassify));
    if (shouldAllow) {
      const reason = yolo ? 'YOLO mode' : 'updated permission policy';
      log.info('Flush: auto-approving pending exec', { id, command: pending.command, reason });
      auditLog({ type: 'exec_tier2_allow', detail: pending.command });
      pendingExecApprovals.delete(id);
      client!.send({ type: 'exec_response', id, ok: true, message: `Allowed by ${reason}` });
      dismissed.push(id);
    }
  }
  if (dismissed.length > 0 && client) {
    client.emit('perm_dismissed', dismissed);
  }
}

function handleAgentExecRequest(id: string, command: string): void {
  // --- Tier 1: Static deny (instant block, no override) ---
  const tier1 = checkTier1Deny(command);
  if (tier1) {
    log.info('Exec blocked by Tier 1 (static deny)', { id, command, reason: tier1 });
    auditLog({ type: 'exec_tier1_block', detail: command, reason: tier1 });
    autoHandledExecIds.add(id);
    classifierDecisions.set(id, { tier: 1, action: 'block', reason: tier1 });
    client!.send({ type: 'exec_response', id, ok: false, message: `Blocked (safety): ${tier1}` });
    injectSystemMessage(`[exec] Blocked by safety engine: ${tier1}\n  Command: ${command}`);
    return;
  }

  // --- YOLO mode: auto-approve everything that passed Tier 1 ---
  if (readSettingsSync()['exec_perm_yolo'] === true) {
    log.info('Exec auto-allowed (YOLO mode)', { id, command });
    auditLog({ type: 'exec_yolo_allow', detail: command });
    autoHandledExecIds.add(id);
    classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'YOLO mode' });
    client!.send({ type: 'exec_response', id, ok: true, message: 'Allowed (YOLO mode)' });
    return;
  }

  // --- Tier 2: Static allow/deny (from settings.json) ---
  const permissions = readExecPermissions();
  const level = checkExecPermission(command, permissions);

  if (level === 'allow') {
    // Check if this command should be forced through the classifier despite matching alwaysAllow
    if (shouldForceClassify(command, permissions.alwaysClassify)) {
      log.info('Exec Tier 2 allow overridden by alwaysClassify', { id, command });
      auditLog({ type: 'exec_tier2_force_classify', detail: command });
      // Fall through to Tier 3 below
    } else {
      log.info('Exec auto-allowed (Tier 2)', { id, command });
      auditLog({ type: 'exec_tier2_allow', detail: command });
      autoHandledExecIds.add(id);
      classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'Allowed by permission policy' });
      client!.send({ type: 'exec_response', id, ok: true, message: 'Allowed by permission policy' });
      return;
    }
  }

  if (level === 'deny') {
    log.info('Exec auto-denied (Tier 2)', { id, command });
    auditLog({ type: 'exec_tier2_deny', detail: command });
    autoHandledExecIds.add(id);
    classifierDecisions.set(id, { tier: 2, action: 'block', reason: 'Denied by permission policy' });
    client!.send({ type: 'exec_response', id, ok: false, message: 'Denied by permission policy' });
    injectSystemMessage(`[exec] Blocked by deny policy: ${command}`);
    return;
  }

  // --- Tier 3: Haiku classifier (async) ---
  if (isClassifierAvailable() && process.env['AIGENT_CLASSIFIER'] !== '0') {
    const ctx = getRecentContext();
    classifyCommand(command, { cwd: process.cwd(), ...(ctx ? { recentContext: ctx } : {}) })
      .then(result => {
        if (result.action === 'allow') {
          log.info('Exec auto-allowed (Tier 3 classifier)', { id, command, reason: result.reason });
          auditLog({ type: 'exec_tier3_allow', detail: command, reason: result.reason });
          autoHandledExecIds.add(id);
          classifierDecisions.set(id, { tier: 3, action: 'allow', reason: result.reason });
          client!.send({ type: 'exec_response', id, ok: true, message: `Allowed by classifier: ${result.reason}` });
          return;
        }

        if (result.action === 'block') {
          log.info('Exec blocked (Tier 3 classifier)', { id, command, reason: result.reason });
          auditLog({ type: 'exec_tier3_block', detail: command, reason: result.reason });
          autoHandledExecIds.add(id);
          classifierDecisions.set(id, { tier: 3, action: 'block', reason: result.reason });
          client!.send({ type: 'exec_response', id, ok: false, message: `Blocked by classifier: ${result.reason}` });
          injectSystemMessage(`[exec] Blocked by classifier: ${result.reason}\n  Command: ${command}`);
          return;
        }

        // 'ask' — prompt the user with the classifier's assessment
        promptUserForExec(id, command, result.reason, result.suggestedPatterns);
      })
      .catch(() => {
        // Classifier failed — fall back to user prompt
        promptUserForExec(id, command);
      });
    return;
  }

  // No classifier — fall back to user prompt
  promptUserForExec(id, command);
}

function promptUserForExec(
  id: string,
  command: string,
  classifierReason?: string,
  suggestedPatterns?: string[],
): void {
  pendingExecApprovals.set(id, {
    command,
    ...(classifierReason ? { classifierReason } : {}),
    ...(suggestedPatterns?.length ? { suggestedPatterns } : {}),
  });
  log.info('Exec approval requested', { id, command, classifierReason, suggestedPatterns });

  let msg = `Agent wants to run: ${command}\n`;
  if (classifierReason) {
    msg += `  Classifier: ${classifierReason}\n`;
  }
  if (suggestedPatterns?.length) {
    msg += `  Suggested always-allow patterns: ${suggestedPatterns.join(', ')}\n`;
  }
  msg += `  Reply: /approve-exec ${id} or /deny-exec ${id}\n`;
  msg += `  To always allow: /approve-exec ${id} --always`;
  msg += `  To always deny: /deny-exec ${id} --always`;
  injectSystemMessage(msg);
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
      // Request was already auto-resolved by flushPendingExecApprovals() — silently ignore
      return true;
    }

    const alwaysAllow = parts.includes('--always');
    pendingExecApprovals.delete(id);

    if (alwaysAllow) {
      if (pending.suggestedPatterns?.length) {
        addPatternsToAlwaysAllow(pending.suggestedPatterns);
        injectSystemMessage(`Approved and added to always-allow: ${pending.suggestedPatterns.join(', ')}`);
      } else {
        addCommandToAlwaysAllow(pending.command);
        const patterns = deriveExecPatterns(pending.command);
        injectSystemMessage(`Approved and added to always-allow: ${patterns.join(', ')}`);
      }
    } else {
      injectSystemMessage(`Approved (once): ${pending.command}`);
    }

    auditLog({ type: 'exec_user_approve', detail: pending.command, approved: true });
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
      // Request was already auto-resolved by flushPendingExecApprovals() — silently ignore
      return true;
    }

    const alwaysDeny = parts.includes('--always');
    pendingExecApprovals.delete(id);

    if (alwaysDeny) {
      addCommandToDenyList(pending.command);
      const patterns = deriveExecPatterns(pending.command);
      injectSystemMessage(`Denied and added to always-deny: ${patterns.join(', ')}`);
    } else {
      injectSystemMessage(`Denied: ${pending.command}`);
    }

    auditLog({ type: 'exec_user_deny', detail: pending.command, approved: false });
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
    const settings = readSettingsSync();
    const perms = settings['fetch_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_FETCH_PERMISSIONS;
    const p = perms as Partial<FetchPermissions>;
    return {
      alwaysAllow: Array.isArray(p.alwaysAllow)
        ? p.alwaysAllow
        : DEFAULT_FETCH_PERMISSIONS.alwaysAllow,
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_FETCH_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_FETCH_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_FETCH_PERMISSIONS;
  }
}

function addToFetchAlwaysAllow(pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToFetchAlwaysAllow', (settings) => {
      const perms = (settings['fetch_permissions'] as Partial<FetchPermissions> | undefined) ?? {};
      const current = Array.isArray(perms.alwaysAllow) ? [...perms.alwaysAllow] : [...DEFAULT_FETCH_PERMISSIONS.alwaysAllow];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, fetch_permissions: { ...DEFAULT_FETCH_PERMISSIONS, ...perms, alwaysAllow: current } };
    });
    log.info('Added pattern to fetch always-allow', { pattern });
    broadcastUpdatedPermissions();
    flushPendingFetchApprovals();
  } catch (err) {
    log.error('Failed to update fetch permissions', { error: String(err) });
  }
}

/** Re-check pending fetch approvals against updated permissions and auto-resolve matches. */
function flushPendingFetchApprovals(): void {
  if (pendingFetchApprovals.size === 0) return;
  const yolo = readSettingsSync()['fetch_perm_yolo'] === true;
  const permissions = readFetchPermissions();
  const dismissed: string[] = [];
  for (const [id, pending] of pendingFetchApprovals) {
    const shouldAllow = yolo || checkFetchPermission(pending.url, permissions) === 'allow';
    if (shouldAllow) {
      const reason = yolo ? 'YOLO mode' : 'updated permission policy';
      log.info('Flush: auto-approving pending fetch', { id, url: pending.url, reason });
      pendingFetchApprovals.delete(id);
      client!.send({ type: 'fetch_response', id, ok: true, message: `Allowed by ${reason}` });
      dismissed.push(id);
    }
  }
  if (dismissed.length > 0 && client) {
    client.emit('perm_dismissed', dismissed);
  }
}

/** Re-check pending file access approvals against updated permissions and auto-resolve matches. */
function flushPendingFileAccessApprovals(): void {
  if (pendingFileAccessApprovals.size === 0) return;
  const yolo = readSettingsSync()['file_perm_yolo'] === true;
  const permissions = readFilePermissions();
  const dismissed: string[] = [];
  for (const [id, pending] of pendingFileAccessApprovals) {
    const shouldAllow = yolo || checkFilePermission(pending.path, permissions, pending.operation) === 'allow';
    if (shouldAllow) {
      const reason = yolo ? 'YOLO mode' : 'updated file permission policy';
      log.info('Flush: auto-approving pending file access', { id, path: pending.path, operation: pending.operation, reason });
      pendingFileAccessApprovals.delete(id);
      client!.send({ type: 'file_access_response', id, ok: true, message: `Allowed by ${reason}` });
      dismissed.push(id);
    }
  }
  if (dismissed.length > 0 && client) {
    client.emit('perm_dismissed', dismissed);
  }
}

// --- File path permissions ---

function readFilePermissions(): FilePermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['file_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_FILE_PERMISSIONS;
    const p = perms as Partial<FilePermissions> & { alwaysAllow?: string[] };
    // Backward compat: if readWrite is missing but legacy alwaysAllow exists, use it
    const readWrite = Array.isArray(p.readWrite)
      ? p.readWrite
      : Array.isArray(p.alwaysAllow)
        ? p.alwaysAllow
        : DEFAULT_FILE_PERMISSIONS.readWrite;
    return {
      readWrite,
      readOnly: Array.isArray(p.readOnly)
        ? p.readOnly
        : DEFAULT_FILE_PERMISSIONS.readOnly,
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_FILE_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_FILE_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_FILE_PERMISSIONS;
  }
}

function addPathToFileReadWrite(pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToFileReadWrite', (settings) => {
      const perms = (settings['file_permissions'] as Partial<FilePermissions> | undefined) ?? {};
      const current = Array.isArray(perms.readWrite) ? [...perms.readWrite] : [...DEFAULT_FILE_PERMISSIONS.readWrite];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, file_permissions: { ...DEFAULT_FILE_PERMISSIONS, ...perms, readWrite: current } };
    });
    log.info('Added path to file read-write', { pattern });
    broadcastUpdatedPermissions();
    flushPendingFileAccessApprovals();
  } catch (err) {
    log.error('Failed to update file permissions', { error: String(err) });
  }
}

function addPathToFileReadOnly(pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToFileReadOnly', (settings) => {
      const perms = (settings['file_permissions'] as Partial<FilePermissions> | undefined) ?? {};
      const current = Array.isArray(perms.readOnly) ? [...perms.readOnly] : [...DEFAULT_FILE_PERMISSIONS.readOnly];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, file_permissions: { ...DEFAULT_FILE_PERMISSIONS, ...perms, readOnly: current } };
    });
    log.info('Added path to file read-only', { pattern });
    broadcastUpdatedPermissions();
    flushPendingFileAccessApprovals();
  } catch (err) {
    log.error('Failed to update file permissions', { error: String(err) });
  }
}

function handleAgentFetchRequest(id: string, url: string, method?: string): void {
  // --- YOLO mode: auto-approve all fetch requests ---
  if (readSettingsSync()['fetch_perm_yolo'] === true) {
    log.info('Fetch auto-allowed (YOLO mode)', { id, url });
    auditLog({ type: 'fetch_yolo_allow', detail: url });
    autoHandledFetchIds.add(id);
    client!.send({ type: 'fetch_response', id, ok: true, message: 'Allowed (YOLO mode)' });
    return;
  }

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
    `  To always allow this URL: /approve-fetch ${id} --always\n` +
    `  To always allow this domain: /approve-fetch ${id} --always-domain`
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending fetch request: ${id}`);
      return true;
    }

    const alwaysAllow = parts.includes('--always') || parts.includes('--always-domain');
    const alwaysDomain = parts.includes('--always-domain');
    pendingFetchApprovals.delete(id);

    if (alwaysDomain) {
      let hostname = pending.url;
      try { hostname = new URL(pending.url).hostname; } catch { /* keep raw */ }
      addToFetchAlwaysAllow(hostname);
      injectSystemMessage(`Approved and domain added to always-allow: ${hostname}`);
    } else if (alwaysAllow) {
      addToFetchAlwaysAllow(pending.url);
      injectSystemMessage(`Approved and URL added to always-allow: ${pending.url}`);
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending fetch request: ${id}`);
      return true;
    }

    pendingFetchApprovals.delete(id);
    injectSystemMessage(`Denied: ${pending.url}`);
    client!.send({ type: 'fetch_response', id, ok: false, alwaysAllow: false, message: 'Denied by user' });
    return true;
  }

  return false;
}

// --- File access approval (sensitive paths / out-of-project writes) ---

const pendingFileAccessApprovals = new Map<string, { path: string; operation: 'read' | 'write' }>();
const autoHandledFileAccessIds = new Set<string>();

function handleAgentFileAccessRequest(id: string, path: string, operation: 'read' | 'write', reason: string): void {
  // --- YOLO mode: auto-approve all file access ---
  if (readSettingsSync()['file_perm_yolo'] === true) {
    const auditType = operation === 'read' ? 'file_read' : 'file_write';
    log.info(`File ${operation} auto-allowed (YOLO mode)`, { id, path });
    auditLog({ type: `${auditType}_yolo_allow`, detail: path });
    autoHandledFileAccessIds.add(id);
    classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'YOLO mode' });
    client!.send({ type: 'file_access_response', id, ok: true, message: 'Allowed (YOLO mode)' });
    return;
  }

  // Check file permissions (deny/readOnly/readWrite) for all operations
  const filePerms = readFilePermissions();
  const level = checkFilePermission(path, filePerms, operation);

  if (level === 'allow') {
    const auditType = operation === 'read' ? 'file_read' : 'file_write';
    log.info(`File ${operation} auto-allowed by permission policy`, { id, path });
    auditLog({ type: auditType, detail: path, reason: 'allowed by file_permissions' });
    autoHandledFileAccessIds.add(id);
    classifierDecisions.set(id, { tier: 2, action: 'allow', reason: 'Allowed by file_permissions' });
    client!.send({ type: 'file_access_response', id, ok: true, message: 'Allowed by file permission policy' });
    return;
  }
  if (level === 'deny') {
    const auditType = operation === 'read' ? 'file_read_block' : 'file_write_block';
    log.info(`File ${operation} auto-denied by permission policy`, { id, path });
    auditLog({ type: auditType, detail: path, reason: 'denied by file_permissions' });
    autoHandledFileAccessIds.add(id);
    classifierDecisions.set(id, { tier: 2, action: 'block', reason: 'Denied by file_permissions' });
    client!.send({ type: 'file_access_response', id, ok: false, message: 'Denied by file permission policy' });
    injectSystemMessage(`[file] Blocked by ${operation === 'write' ? 'deny/read-only' : 'deny'} policy: ${path}`);
    return;
  }

  // --- Tier 3: Haiku file access classifier (async) ---
  if (isClassifierAvailable() && process.env['AIGENT_CLASSIFIER'] !== '0') {
    const ctx = getRecentContext();
    classifyFileAccess(path, operation, { cwd: process.cwd(), ...(ctx ? { recentContext: ctx } : {}) })
      .then(result => {
        if (result.action === 'allow') {
          const auditType = operation === 'read' ? 'file_read' : 'file_write';
          log.info(`File ${operation} auto-allowed (Tier 3 classifier)`, { id, path, reason: result.reason });
          auditLog({ type: auditType, detail: path, reason: `classifier: ${result.reason}` });
          autoHandledFileAccessIds.add(id);
          classifierDecisions.set(id, { tier: 3, action: 'allow', reason: result.reason });
          client!.send({ type: 'file_access_response', id, ok: true, message: `Allowed by classifier: ${result.reason}` });
          return;
        }

        if (result.action === 'block') {
          const auditType = operation === 'read' ? 'file_read_block' : 'file_write_block';
          log.info(`File ${operation} blocked (Tier 3 classifier)`, { id, path, reason: result.reason });
          auditLog({ type: auditType, detail: path, reason: `classifier: ${result.reason}` });
          autoHandledFileAccessIds.add(id);
          classifierDecisions.set(id, { tier: 3, action: 'block', reason: result.reason });
          client!.send({ type: 'file_access_response', id, ok: false, message: `Blocked by classifier: ${result.reason}` });
          injectSystemMessage(`[file] Blocked by classifier: ${result.reason}\n  Path: ${path}`);
          return;
        }

        // 'ask' — prompt the user with the classifier's assessment
        promptUserForFileAccess(id, path, operation, reason, result.reason, result.suggestedPatterns);
      })
      .catch(() => {
        // Classifier failed — fall back to user prompt
        promptUserForFileAccess(id, path, operation, reason);
      });
    return;
  }

  // No classifier — fall back to user prompt
  promptUserForFileAccess(id, path, operation, reason);
}

function promptUserForFileAccess(
  id: string,
  path: string,
  operation: 'read' | 'write',
  reason: string,
  classifierReason?: string,
  suggestedPatterns?: string[],
): void {
  pendingFileAccessApprovals.set(id, { path, operation });
  log.info('File access approval requested', { id, path, operation, classifierReason, suggestedPatterns });
  let msg = `Agent wants to ${operation.toUpperCase()} file outside project or in a sensitive location:\n` +
    `  Path: ${path}\n` +
    `  Reason: "${reason}"\n`;
  if (classifierReason) {
    msg += `  Classifier: ${classifierReason}\n`;
  }
  msg += `\n  Reply: /approve-file ${id} or /deny-file ${id}\n` +
    `  To always allow this file (read-write): /approve-file ${id} --always\n` +
    `  To always allow this directory (read-write): /approve-file ${id} --always-dir\n` +
    `  To allow read-only: /approve-file ${id} --read-only\n` +
    `  To allow read-only for directory: /approve-file ${id} --read-only-dir`;
  injectSystemMessage(msg);
}

function handleFileAccessApproveReject(input: string): boolean {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-file' && cmd !== '/deny-file') return false;

  let id = parts[1];
  // If the first arg is a flag, not an id, and there's only one pending request
  if (id && id.startsWith('--')) id = undefined;
  if (!id && pendingFileAccessApprovals.size === 1) {
    id = pendingFileAccessApprovals.keys().next().value as string;
  }
  if (!id) {
    injectSystemMessage(pendingFileAccessApprovals.size === 0
      ? 'No pending file access requests.'
      : `Multiple pending — specify ID: ${[...pendingFileAccessApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingFileAccessApprovals.get(id);
  if (!pending) {
    if (!IS_TEST_MODE) injectSystemMessage(`No pending file access request: ${id}`);
    return true;
  }

  pendingFileAccessApprovals.delete(id);

  if (cmd === '/approve-file') {
    const isReadOnly = parts.includes('--read-only') || parts.includes('--read-only-dir');
    const isDir = parts.includes('--always-dir') || parts.includes('--read-only-dir');
    const isPersistent = parts.includes('--always') || isDir || isReadOnly;

    if (isDir) {
      const dirPattern = dirname(pending.path) + '/**';
      if (isReadOnly) {
        addPathToFileReadOnly(dirPattern);
        injectSystemMessage(`Approved and directory added to read-only: ${dirPattern}`);
      } else {
        addPathToFileReadWrite(dirPattern);
        injectSystemMessage(`Approved and directory added to read-write: ${dirPattern}`);
      }
    } else if (isReadOnly) {
      addPathToFileReadOnly(pending.path);
      injectSystemMessage(`Approved and path added to read-only: ${pending.path}`);
    } else if (isPersistent) {
      addPathToFileReadWrite(pending.path);
      injectSystemMessage(`Approved and path added to read-write: ${pending.path}`);
    } else {
      injectSystemMessage(`Approved (once): ${pending.path}`);
    }

    log.info('File access approved', { id, path: pending.path, persistent: isPersistent, readOnly: isReadOnly, dir: isDir });
    client!.send({ type: 'file_access_response', id, ok: true, message: 'Approved by user' });
  } else {
    log.info('File access denied', { id, path: pending.path });
    injectSystemMessage(`Denied file ${pending.operation}: ${pending.path}`);
    client!.send({ type: 'file_access_response', id, ok: false, message: 'Denied by user' });
  }
  return true;
}

// --- Fetch size approval ---

const pendingFetchSizeApprovals = new Map<string, { url: string; requestedBytes: number; defaultBytes: number }>();

function handleAgentFetchSizeRequest(id: string, url: string, requestedBytes: number, defaultBytes: number): void {
  pendingFetchSizeApprovals.set(id, { url, requestedBytes, defaultBytes });
  const mb = (requestedBytes / (1024 * 1024)).toFixed(1);
  const defaultMb = (defaultBytes / (1024 * 1024)).toFixed(0);
  log.info('Fetch size approval requested', { id, url, requestedBytes });
  injectSystemMessage(
    `Agent wants to fetch up to ${mb} MB from:\n` +
    `  ${url}\n` +
    `  Default limit is ${defaultMb} MB.\n\n` +
    `  Reply: /approve-fetchsize ${id} or /deny-fetchsize ${id}`
  );
}

function handleFetchSizeApproveReject(input: string): boolean {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-fetchsize' && cmd !== '/deny-fetchsize') return false;

  let id = parts[1];
  if (!id && pendingFetchSizeApprovals.size === 1) {
    id = pendingFetchSizeApprovals.keys().next().value as string;
  }
  if (!id) {
    injectSystemMessage(pendingFetchSizeApprovals.size === 0
      ? 'No pending fetch size requests.'
      : `Multiple pending — specify ID: ${[...pendingFetchSizeApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingFetchSizeApprovals.get(id);
  if (!pending) {
    if (!IS_TEST_MODE) injectSystemMessage(`No pending fetch size request: ${id}`);
    return true;
  }

  pendingFetchSizeApprovals.delete(id);

  if (cmd === '/approve-fetchsize') {
    log.info('Fetch size approved', { id, bytes: pending.requestedBytes });
    injectSystemMessage(`Approved fetch up to ${(pending.requestedBytes / (1024 * 1024)).toFixed(1)} MB from ${pending.url}`);
    client!.send({ type: 'fetch_size_response', id, ok: true, approvedBytes: pending.requestedBytes, message: 'Approved by user' });
  } else {
    log.info('Fetch size denied', { id });
    injectSystemMessage(`Denied larger fetch from ${pending.url}`);
    client!.send({ type: 'fetch_size_response', id, ok: false, approvedBytes: pending.defaultBytes, message: 'Denied by user' });
  }
  return true;
}

// --- MCP tool approval ---

const pendingMcpToolApprovals = new Map<string, { server: string; tool: string; params: string }>();
const autoHandledMcpIds = new Set<string>();

function readMCPPermissions(): MCPPermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['mcp_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_MCP_PERMISSIONS;
    const p = perms as Partial<MCPPermissions>;
    return {
      servers: (p.servers && typeof p.servers === 'object') ? p.servers : {},
    };
  } catch {
    return DEFAULT_MCP_PERMISSIONS;
  }
}

function addMCPToolToAlwaysAllow(server: string, tool: string): void {
  try {
    writeSettingsSync('gatekeeper:addToMCPAlwaysAllow', (settings) => {
      const perms = (settings['mcp_permissions'] as Partial<MCPPermissions> | undefined) ?? {};
      const servers = (perms.servers && typeof perms.servers === 'object') ? { ...perms.servers } : {};
      const existing = servers[server];
      const serverPerms = existing ? { ...existing } : { default: 'prompt' as const };
      const tools = serverPerms.tools ? { ...serverPerms.tools } : {};
      tools[tool] = 'allow';
      serverPerms.tools = tools;
      servers[server] = serverPerms;
      return { ...settings, mcp_permissions: { servers } };
    });
    log.info('Added MCP tool to always-allow', { server, tool });
    broadcastUpdatedPermissions();
    flushPendingMCPApprovals();
  } catch (err) {
    log.error('Failed to update MCP permissions', { error: String(err) });
  }
}

function handleAgentMcpToolRequest(id: string, server: string, tool: string, params: string): void {
  const permissions = readMCPPermissions();
  const level = checkMCPPermission(server, tool, permissions);

  if (level === 'allow') {
    log.info('MCP tool auto-allowed', { id, server, tool });
    auditLog({ type: 'mcp_tool_allow', detail: `${server}/${tool}` });
    autoHandledMcpIds.add(id);
    client!.send({ type: 'mcp_tool_response', id, ok: true, message: 'Allowed by permission policy' });
    return;
  }

  if (level === 'deny') {
    log.info('MCP tool auto-denied', { id, server, tool });
    auditLog({ type: 'mcp_tool_deny', detail: `${server}/${tool}` });
    autoHandledMcpIds.add(id);
    client!.send({ type: 'mcp_tool_response', id, ok: false, message: 'Denied by permission policy' });
    injectSystemMessage(`[mcp] Blocked by deny policy: ${server}/${tool}`);
    return;
  }

  // 'prompt' — store and forward to web UI for user approval
  pendingMcpToolApprovals.set(id, { server, tool, params });
  log.info('MCP tool approval requested', { id, server, tool });
  auditLog({ type: 'mcp_tool_prompt', detail: `${server}/${tool}` });
  const paramsPreview = params.length > 200 ? params.slice(0, 200) + '\n  ...' : params;
  injectSystemMessage(
    `Agent wants to call MCP tool: ${server}/${tool}\n` +
    `  Parameters:\n${paramsPreview}\n\n` +
    `  Reply: /approve-mcp ${id} or /deny-mcp ${id}\n` +
    `  To always allow this tool: /approve-mcp ${id} --always`
  );
}

function handleMcpToolApproveReject(input: string): boolean {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-mcp' && cmd !== '/deny-mcp') return false;

  const hasAlways = parts.includes('--always');
  let id = parts.find(p => p !== cmd && p !== '--always');
  if (!id && pendingMcpToolApprovals.size === 1) {
    id = pendingMcpToolApprovals.keys().next().value as string;
  }
  if (!id) {
    injectSystemMessage(pendingMcpToolApprovals.size === 0
      ? 'No pending MCP tool requests.'
      : `Multiple pending — specify ID: ${[...pendingMcpToolApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingMcpToolApprovals.get(id);
  if (!pending) {
    if (!IS_TEST_MODE) injectSystemMessage(`No pending MCP tool request: ${id}`);
    return true;
  }

  pendingMcpToolApprovals.delete(id);

  if (cmd === '/approve-mcp') {
    log.info('MCP tool approved', { id, server: pending.server, tool: pending.tool, always: hasAlways });
    auditLog({ type: 'mcp_user_approve', detail: `${pending.server}/${pending.tool}` });
    injectSystemMessage(`Approved MCP tool: ${pending.server}/${pending.tool}${hasAlways ? ' (always)' : ''}`);
    client!.send({ type: 'mcp_tool_response', id, ok: true, message: 'Approved by user' });
    if (hasAlways) {
      addMCPToolToAlwaysAllow(pending.server, pending.tool);
    }
  } else {
    log.info('MCP tool denied', { id, server: pending.server, tool: pending.tool });
    auditLog({ type: 'mcp_user_deny', detail: `${pending.server}/${pending.tool}` });
    injectSystemMessage(`Denied MCP tool: ${pending.server}/${pending.tool}`);
    client!.send({ type: 'mcp_tool_response', id, ok: false, message: 'Denied by user' });
  }
  return true;
}

/** Re-check pending MCP tool approvals against updated permissions and auto-resolve matches. */
function flushPendingMCPApprovals(): void {
  if (pendingMcpToolApprovals.size === 0) return;
  const permissions = readMCPPermissions();
  const dismissed: string[] = [];
  for (const [id, pending] of pendingMcpToolApprovals) {
    const level = checkMCPPermission(pending.server, pending.tool, permissions);
    if (level === 'allow') {
      log.info('Flush: auto-approving pending MCP tool', { id, server: pending.server, tool: pending.tool });
      auditLog({ type: 'mcp_tool_allow', detail: `${pending.server}/${pending.tool}` });
      pendingMcpToolApprovals.delete(id);
      client!.send({ type: 'mcp_tool_response', id, ok: true, message: 'Allowed by permission policy' });
      dismissed.push(id);
    }
  }
  if (dismissed.length > 0 && client) {
    client.emit('perm_dismissed', dismissed);
  }
}

// --- Browser write approval ---

interface PendingBrowserWrite {
  action: 'run_script' | 'navigate' | 'open_tab' | 'close_tab';
  tabId?: number;
  steps?: unknown[];
  url?: string;
}

const pendingBrowserWriteApprovals = new Map<string, PendingBrowserWrite>();
// Session-scoped grant: when true, all browser write actions skip the approval queue
const browserWriteGranted = { value: false };
// Session-scoped grant: when true, all browser actions (including destructive) skip approval
const browserAutonomousGranted = { value: false };
// IDs auto-handled (grant active) before web-bridge listener fires — web-bridge skips these
const autoHandledBrowserWriteIds = new Set<string>();
// IDs flagged as destructive — web-bridge reads this to annotate the permission request
const destructiveBrowserWriteIds = new Map<string, string>();

function summariseBrowserWriteAction(action: 'run_script' | 'navigate' | 'open_tab' | 'close_tab', steps?: unknown[], url?: string, tabId?: number): string {
  if (action === 'navigate') return `Navigate to ${url ?? '(no url)'}`;
  if (action === 'open_tab') return `Open new tab: ${url ?? '(no url)'}`;
  if (action === 'close_tab') return `Close tab ${tabId ?? '(unknown)'}`;
  if (!steps || steps.length === 0) return 'run_script (no steps)';

  const verbs: string[] = [];
  for (const step of steps) {
    const s = step as Record<string, unknown>;
    if ('navigate' in s) verbs.push(`navigate ${s['navigate']}`);
    else if ('fill' in s) verbs.push(`fill ${s['fill']}`);
    else if ('click' in s) verbs.push(`click ${s['click']}`);
    else if ('clear' in s) verbs.push(`clear ${s['clear']}`);
    else if ('select' in s) verbs.push(`select ${s['select']}`);
    else if ('check' in s) verbs.push(`check ${s['check']}`);
    else if ('scroll' in s) verbs.push(`scroll ${s['scroll']}`);
    else if ('wait' in s) verbs.push(`wait ${s['wait']}ms`);
    else if ('waitFor' in s) verbs.push(`waitFor ${s['waitFor']}`);
    else if ('pressKey' in s) verbs.push(`pressKey ${s['pressKey']}`);
    else if ('hover' in s) verbs.push(`hover ${s['hover']}`);
    else if ('extractA11y' in s) verbs.push('extractA11y');
    else if ('screenshot' in s) verbs.push('screenshot');
  }

  const MAX_LEN = 80;
  let summary = verbs.slice(0, 5).join(', ');
  const extra = verbs.length - 5;
  if (extra > 0) summary += ` + ${extra} more`;
  return summary.length > MAX_LEN ? summary.slice(0, MAX_LEN - 3) + '...' : summary;
}

async function handleBrowserWriteApproveReject(input: string): Promise<boolean> {
  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  if (cmd !== '/approve-browser-write' && cmd !== '/deny-browser-write') return false;

  let id = parts[1];
  if (!id && pendingBrowserWriteApprovals.size === 1) {
    id = pendingBrowserWriteApprovals.keys().next().value as string;
  }
  if (!id) {
    injectSystemMessage(pendingBrowserWriteApprovals.size === 0
      ? 'No pending browser write requests.'
      : `Multiple pending — specify ID: ${[...pendingBrowserWriteApprovals.keys()].join(', ')}`);
    return true;
  }

  const pending = pendingBrowserWriteApprovals.get(id);
  if (!pending) {
    if (!IS_TEST_MODE) injectSystemMessage(`No pending browser write request: ${id}`);
    return true;
  }

  pendingBrowserWriteApprovals.delete(id);

  if (cmd === '/deny-browser-write') {
    auditLog({ type: 'browser_ext_user_deny', detail: `${pending.action}`, approved: false });
    injectSystemMessage(`Browser write denied: ${id}`);
    client!.send({ type: 'browser_ext_result', id, ok: false, error: 'User denied browser write action' });
    return true;
  }

  // Approve — relay to extension
  auditLog({ type: 'browser_ext_user_approve', detail: `${pending.action}`, approved: true });
  const alwaysAllow = parts.includes('--always');
  if (alwaysAllow) {
    browserWriteGranted.value = true;
    injectSystemMessage(`Browser write approved and auto-allowed for this session: ${pending.action}`);
  } else {
    injectSystemMessage(`Browser write approved: ${pending.action}`);
  }
  const params: { tabId?: number; steps?: unknown[]; url?: string } = {};
  if (pending.tabId !== undefined) params.tabId = pending.tabId;
  if (pending.steps !== undefined) params.steps = pending.steps;
  if (pending.url !== undefined) params.url = pending.url;

  extensionBridge.request(pending.action, params).then((result) => {
    sendBrowserExtResult(id, result);
  }).catch((err: Error) => {
    client!.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
  });

  return true;
}

/** Relay a browser extension result (used by both approval handler and auto-approval path). */
function sendBrowserExtResult(id: string, result: { ok: boolean; treeText?: string; dataUrl?: string; tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[]; stepsCompleted?: number; totalSteps?: number; finalUrl?: string; finalTitle?: string; newTabId?: number; screenshots?: Array<{ stepIndex: number; dataUrl: string }>; error?: string }): void {
  const msg: Extract<import('./protocol.js').ClientCommand, { type: 'browser_ext_result' }> = {
    type: 'browser_ext_result', id, ok: result.ok,
  };
  if (result.treeText !== undefined) msg.treeText = result.treeText;
  if (result.dataUrl !== undefined) msg.dataUrl = result.dataUrl;
  if (result.tabs !== undefined) msg.tabs = result.tabs;
  if (result.stepsCompleted !== undefined) msg.stepsCompleted = result.stepsCompleted;
  if (result.totalSteps !== undefined) msg.totalSteps = result.totalSteps;
  if (result.finalUrl !== undefined) msg.finalUrl = result.finalUrl;
  if (result.finalTitle !== undefined) msg.finalTitle = result.finalTitle;
  if (result.newTabId !== undefined) msg.newTabId = result.newTabId;
  if (result.screenshots !== undefined) msg.screenshots = result.screenshots;
  if (result.error !== undefined) msg.error = result.error;
  client!.send(msg);
}

function handleBrowserAutonomousGrant(input: string): boolean {
  const cmd = input.trim().split(/\s+/)[0]?.toLowerCase();
  if (cmd === '/grant-browser-autonomous') {
    browserAutonomousGranted.value = true;
    browserWriteGranted.value = true;
    injectSystemMessage('Browser autonomous mode enabled — all browser write actions will be auto-approved for this session.');
    return true;
  }
  if (cmd === '/revoke-browser-autonomous') {
    browserAutonomousGranted.value = false;
    injectSystemMessage('Browser autonomous mode revoked — browser write actions will require approval again (session write grant still active).');
    return true;
  }
  return false;
}

// --- Host Daemon ---

let hostDaemonProcess: ChildProcess | null = null;

async function startHostDaemon(): Promise<void> {
  const { HOST_SOCKET_PATH } = await import('./host/protocol.js');
  const daemonPidFile = join(SOCKET_DIR, 'host-daemon.pid');

  // Kill any orphaned daemon from a previous run of THIS instance (e.g. tsx --watch
  // restarts). Uses a PID file scoped to SOCKET_DIR so test and dev don't collide.
  if (existsSync(daemonPidFile)) {
    try {
      const oldPid = parseInt(readFileSync(daemonPidFile, 'utf-8').trim(), 10);
      process.kill(oldPid, 'SIGTERM');
      await new Promise<void>((r) => setTimeout(r, 200));
    } catch { /* already dead — that's fine */ }
    try { unlinkSync(daemonPidFile); } catch {}
  }

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

  // Write PID file so the next startup of this instance can clean up
  if (hostDaemonProcess.pid !== undefined) {
    writeFileSync(daemonPidFile, String(hostDaemonProcess.pid));
  }

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
// Without this, stray writes (from libraries, Node internals, child process output) corrupt the terminal.
const LOG_PATH = process.env['AIGENT_LOG'] ?? '/tmp/aigent-gatekeeper.log';
const logStream = createWriteStream(LOG_PATH, { flags: 'a' });

console.log = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.error = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
console.warn = (...args: unknown[]) => { logStream.write(args.join(' ') + '\n'); };
process.stderr.write = ((chunk: string | Uint8Array) => {
  logStream.write(chunk);
  return true;
}) as typeof process.stderr.write;

// Ensure socket directory
mkdirSync(SOCKET_DIR, { recursive: true, mode: 0o777 });
cleanupSocket();

// Start host daemon (clipboard, screen capture, etc.)
await startHostDaemon();

// Start LLM proxy (holds API keys, worker connects to this)
await startLLMProxy();
log.info('LLM proxy ready');

// Initialize Tier 3 classifier (uses Anthropic API key if available)
const classifierKey = process.env['ANTHROPIC_API_KEY'];
if (classifierKey && process.env['AIGENT_CLASSIFIER'] !== '0') {
  initClassifier(classifierKey);
  log.info('Tier 3 classifier initialized');
} else {
  log.info('Tier 3 classifier disabled', { reason: classifierKey ? 'AIGENT_CLASSIFIER=0' : 'no ANTHROPIC_API_KEY' });
}

// Set up client early (before server) so the web server can start immediately.
const { AgentClient } = await import('./client.js');
client = new AgentClient();

// Intercept commands BEFORE starting the web server. The web UI sends /approve,
// etc. as commands via WebSocket → web-bridge → client.sendCommand().
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

const originalSendCommand = client.sendCommand.bind(client);
client.sendCommand = (cmd: string) => {
  if (isGatekeeperCommand(cmd)) {
    handleGatekeeperCommand(cmd).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.error('Gatekeeper command error', { error: msg });
      injectSystemMessage(`Error: ${msg}`);
    });
    return;
  }
  originalSendCommand(cmd);
};

// Log effective permissions on startup so it's easy to verify what was loaded.
{
  const execPerms = readExecPermissions();
  const fetchPerms = readFetchPermissions();
  log.info('Loaded exec permissions', {
    alwaysAllow: execPerms.alwaysAllow.length,
    deny: execPerms.deny.length,
    settingsPath: getSettingsPath(),
  });
  if (fetchPerms.alwaysAllow.length > 0 || fetchPerms.deny.length > 0) {
    log.info('Loaded fetch permissions', {
      alwaysAllow: fetchPerms.alwaysAllow.length,
      deny: fetchPerms.deny.length,
    });
  }
}

// Start web UI server before the server process so it's available during startup/restarts.
const extSecret = randomUUID();
const { startWebServer } = await import('./web-bridge.js');
startWebServer(client, undefined, { autoHandledExecIds, getExecPermissions: readExecPermissions, autoHandledFetchIds, getFetchPermissions: readFetchPermissions, autoHandledBrowserWriteIds, destructiveBrowserWriteIds, classifierDecisions, autoHandledFileAccessIds, autoHandledMcpIds, onSettingsChanged: handleSettingsChanged, extSecret }).then(({ port }) => {
  log.info('Web UI ready', { url: `http://localhost:${port}` });
}).catch((err) => {
  log.error('Web UI failed to start', { error: (err as Error).message });
});

// Start server process (skip in test mode — tests inject events via /test/inject)
if (!process.env['AIGENT_TEST_MODE']) {
  try {
    startServerProcess();
    await waitForSocket();
    log.info('Server ready');
    // Optional file watcher for self-modification auto-restart (opt-in)
    if (process.env['AIGENT_AUTO_RELOAD'] === '1') {
      startFileWatcher();
      log.info('Auto-reload enabled (watching src/ for changes)');
    }
  } catch (err) {
    log.error('Server start failed', { error: (err as Error).message });
    cleanupAll();
    process.exit(1);
  }
} else {
  log.info('Test mode — skipping server startup');
}

// Push host state to web UI when client connects to the worker
client.on('connected', () => {
  setTimeout(() => emitHostState(), 100);
});

// Track recent conversation messages for classifier context
client.on('message', (message: { role: string; content: string }) => {
  recentMessages.push({ role: message.role, content: typeof message.content === 'string' ? message.content : '' });
  while (recentMessages.length > RECENT_MSG_LIMIT) recentMessages.shift();
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

// Handle file access approval requests (sensitive paths / out-of-project writes)
client.on('file_access_request', (id: string, path: string, operation: 'read' | 'write', reason: string) => {
  handleAgentFileAccessRequest(id, path, operation, reason);
});

// Handle fetch size approval requests (agent wants more than the default 1 MB)
client.on('fetch_size_request', (id: string, url: string, requestedBytes: number, defaultBytes: number) => {
  handleAgentFetchSizeRequest(id, url, requestedBytes, defaultBytes);
});

// Handle MCP tool approval requests
client.on('mcp_tool_request', (id: string, server: string, tool: string, params: string) => {
  handleAgentMcpToolRequest(id, server, tool, params);
});

// Handle browser extension requests from the host daemon — relay to the Chrome extension
client.on('browser_ext_request', (id: string, action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab', tabId?: number, rootSelector?: string, steps?: unknown[], url?: string) => {
  const isWriteAction = action === 'run_script' || action === 'navigate' || action === 'open_tab' || action === 'close_tab';

  if (isWriteAction) {
    // SSRF check — block navigate/open_tab to private IPs, localhost, metadata endpoints
    const ssrfErr = validateBrowserUrls(action, steps, url);
    if (ssrfErr) {
      auditLog({ type: 'browser_ext_ssrf_block', detail: `${action}${url ? ` ${url}` : ''}`, reason: ssrfErr });
      client.send({ type: 'browser_ext_result', id, ok: false, error: `Blocked: ${ssrfErr}` });
      return;
    }

    // Check session-level browser write grant — auto-approve if granted
    if (browserWriteGranted.value) {
      // Phase 3c: even with write grant, destructive actions require confirmation
      // unless autonomous mode is active
      if (!browserAutonomousGranted.value) {
        const destructiveMatches = detectDestructiveSteps(action, steps, url);
        if (destructiveMatches.length > 0) {
          const detail = destructiveMatches.join(', ');
          auditLog({ type: 'browser_ext_destructive_prompt', detail: `${action}: ${detail}` });
          log.info('Destructive browser action flagged for confirmation', { id, action, matches: destructiveMatches });
          destructiveBrowserWriteIds.set(id, detail);
          const stepSummary = summariseBrowserWriteAction(action, steps, url, tabId);
          pendingBrowserWriteApprovals.set(id, {
            action,
            ...(tabId !== undefined ? { tabId } : {}),
            ...(steps !== undefined ? { steps } : {}),
            ...(url !== undefined ? { url } : {}),
          });
          injectSystemMessage(
            `⚠ Potentially destructive browser action: ${detail}\n` +
            `Agent wants to: ${stepSummary}\n` +
            `  Reply: /approve-browser-write ${id} or /deny-browser-write ${id}`
          );
          return;
        }
      }

      log.info('Browser write auto-approved by session grant', { id, action });
      auditLog({ type: 'browser_ext_write_grant', detail: `${action}${url ? ` ${url}` : ''}` });
      autoHandledBrowserWriteIds.add(id);
      const params: Record<string, unknown> = {};
      if (tabId !== undefined) params.tabId = tabId;
      if (steps !== undefined) params.steps = steps;
      if (url !== undefined) params.url = url;
      void extensionBridge.request(action, params).then((result) => {
        sendBrowserExtResult(id, result);
      }).catch((err: Error) => {
        client.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
      });
      return;
    }

    // Not granted — queue for user approval
    auditLog({ type: 'browser_ext_write_prompt', detail: `${action}${url ? ` ${url}` : ''}` });
    // Detect destructive actions so the UI can show a warning
    const destructiveMatches = detectDestructiveSteps(action, steps, url);
    if (destructiveMatches.length > 0) {
      destructiveBrowserWriteIds.set(id, destructiveMatches.join(', '));
    }
    const stepSummary = summariseBrowserWriteAction(action, steps, url, tabId);
    pendingBrowserWriteApprovals.set(id, {
      action,
      ...(tabId !== undefined ? { tabId } : {}),
      ...(steps !== undefined ? { steps } : {}),
      ...(url !== undefined ? { url } : {}),
    });
    log.info('Browser write approval requested', { id, action });
    const actionDesc = action === 'navigate' ? `navigate to: ${url ?? '?'}`
      : action === 'open_tab' ? `open new tab: ${url ?? '?'}`
      : action === 'close_tab' ? `close tab ${tabId ?? '?'}`
      : `run browser script: ${stepSummary}`;
    injectSystemMessage(
      `Agent wants to ${actionDesc}\n` +
      `  Reply: /approve-browser-write ${id} or /deny-browser-write ${id}\n` +
      `  To auto-approve all browser writes: /approve-browser-write ${id} --always`
    );
    // The web-bridge event handler sends browser_write_request to web UI clients
    // (see browser_ext_request handler in web-bridge.ts)
    return;
  }

  // Read-only actions (extract_a11y, screenshot, list_tabs, activate_tab): relay directly
  auditLog({ type: 'browser_ext_read', detail: action });
  const params: Record<string, unknown> = {};
  if (tabId !== undefined) params.tabId = tabId;
  if (rootSelector !== undefined) params.rootSelector = rootSelector;
  void extensionBridge.request(action, params).then((result) => {
    sendBrowserExtResult(id, result);
  }).catch((err: Error) => {
    client.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
  });
});

// Run UI
if (gatekeeperArgs.headless) {
  // Headless mode: web UI only, no terminal interface
  client.connect();
  log.info('Running in headless mode (web UI only)');
  // Keep process alive until SIGINT
  await new Promise<void>((r) => {
    process.on('SIGINT', r);
    process.on('SIGTERM', r);
    if (serverProcess) serverProcess.on('exit', r);
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
      if (serverProcess) serverProcess.on('exit', r);
      else r();
    });
  }
}

// Shutdown
cleanupAll();
process.exit(0);
