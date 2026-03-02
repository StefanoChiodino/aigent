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
import { createConnection } from 'node:net';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getDefaultWorkspace, getEnvFile } from './xdg.js';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';
import { createLogger } from './logger.js';
import { checkFilePermission, type BrowserPermissions, checkBrowserPermission, classifyBrowserAction, browserTierSufficient, DEFAULT_BROWSER_PERMISSIONS, readFilePermissions } from './safety.js';
import { initClassifier } from './classifier.js';
import { extensionBridge } from './ext-bridge.js';
import { auditLog } from './audit.js';
import { rotateIfNeeded } from './log-rotate.js';
import { validateBrowserUrls } from './browser-safety.js';
import { readSettingsSync, writeSettingsSync, getSettingsPath } from './settings-file.js';
import {
  handleConfigWriteRequest as _handleConfigWriteRequest,
  handleConfigApproveReject as _handleConfigApproveReject,
  handleEditFileRequest as _handleEditFileRequest,
  handleEditFileApproveReject as _handleEditFileApproveReject,
  type ConfigWriteContext,
} from './gk-config-writes.js';
import { type PermCtx, type ClassifierDecision } from './gk-perm-utils.js';
import {
  pendingExecApprovals,
  readExecPermissions,
  flushPendingExecApprovals,
  handleAgentExecRequest as _handleAgentExecRequest,
  handleExecApproveReject as _handleExecApproveReject,
} from './gk-exec-perms.js';
import {
  pendingFetchApprovals,
  readFetchPermissions,
  flushPendingFetchApprovals,
  handleAgentFetchRequest as _handleAgentFetchRequest,
  handleFetchApproveReject as _handleFetchApproveReject,
  handleAgentFetchSizeRequest as _handleAgentFetchSizeRequest,
  handleFetchSizeApproveReject as _handleFetchSizeApproveReject,
} from './gk-fetch-perms.js';
import {
  pendingFileAccessApprovals,
  flushPendingFileAccessApprovals,
  handleAgentFileAccessRequest as _handleAgentFileAccessRequest,
  handleFileAccessApproveReject as _handleFileAccessApproveReject,
} from './gk-file-perms.js';
import {
  pendingMcpToolApprovals,
  readMCPPermissions,
  flushPendingMCPApprovals,
  handleAgentMcpToolRequest as _handleAgentMcpToolRequest,
  handleMcpToolApproveReject as _handleMcpToolApproveReject,
} from './gk-mcp-perms.js';

const log = createLogger('gatekeeper');

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(__dirname, '..');

// Detect whether we're running from compiled dist/ (production / global install)
// or from source via tsx (dev mode). In prod mode we skip the file watcher and
// spawn node instead of tsx.
const COMPILED_SERVER = resolve(__dirname, 'server.js');
const IS_DEV_MODE = !existsSync(COMPILED_SERVER);

// Load .env files — XDG location first (global install), then cwd/repo root (dev compat).
// This replaces the former `import 'dotenv/config'` which only loaded from cwd.
{
  const { config: dotenvConfig } = await import('dotenv');
  const xdgEnvFile = getEnvFile();
  const cwdEnvFile = resolve(process.cwd(), '.env');
  const repoEnvFile = resolve(REPO_DIR, '.env');
  // XDG .env takes priority (global install)
  if (existsSync(xdgEnvFile)) dotenvConfig({ path: xdgEnvFile });
  // Cwd / repo root .env for dev workflow — only if different and not already loaded
  for (const envFile of [cwdEnvFile, repoEnvFile]) {
    if (existsSync(envFile) && envFile !== xdgEnvFile) {
      dotenvConfig({ path: envFile, override: false });
      break;
    }
  }
}

// Load settings.json and apply non-secret values to process.env.
// .env (already loaded above) takes lowest priority; CLI flags override all.
// Uses getSettingsPath() which respects AIGENT_SETTINGS_PATH for test isolation.
{
  const settingsPath = getSettingsPath();
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
  watch: boolean;
  provider?: string;
  baseURL?: string;
  apiKey?: string;
}

// --- State ---

let serverProcess: ChildProcess | null = null;
let gatekeeperArgs: GatekeeperArgs;
let client: InstanceType<typeof import('./client.js').AgentClient> | null = null;
let isRestarting = false;
let agentBusy = false;
let pendingRestart = false;
let pendingRestartTimeout: ReturnType<typeof setTimeout> | null = null;

// --- Sleep inhibitor ---
// Prevents the OS from sleeping while the agent is working.
// WSL2: uses PowerShell SetThreadExecutionState (Windows API)
// Native Linux: uses systemd-inhibit
// macOS: uses caffeinate
// Falls back silently if none available.

type WakeLockBackend = 'wsl-powershell' | 'win32-powershell' | 'systemd-inhibit' | 'caffeinate' | 'none';

function detectWakeLockBackend(): WakeLockBackend {
  // Native Windows (Node running on Win32, not in WSL)
  if (process.platform === 'win32') return 'win32-powershell';

  // WSL2: check for Microsoft kernel signature
  const isWSL = existsSync('/proc/version') &&
    readFileSync('/proc/version', 'utf-8').toLowerCase().includes('microsoft');
  if (isWSL) {
    const psPath = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    if (existsSync(psPath)) return 'wsl-powershell';
    // WSL2 with systemd enabled (Windows 11 22H2+) — fall through to systemd check below
  }

  if (process.platform === 'darwin') return 'caffeinate';

  // Linux: prefer systemd-inhibit (works on all systemd desktops and WSL2+systemd)
  try { execSync('which systemd-inhibit', { stdio: 'ignore' }); return 'systemd-inhibit'; } catch {}

  return 'none';
}

// PowerShell script shared between wsl-powershell and win32-powershell backends.
// Sets ES_CONTINUOUS | ES_SYSTEM_REQUIRED via SetThreadExecutionState, then loops
// forever until the process is killed. All stdio is 'ignore' to avoid cross-process
// pipe issues (a WSL2↔Windows pipe on stdin can SIGKILL the Node process on close).
const PS_WAKE_SCRIPT = `
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
[Win32.Power]::SetThreadExecutionState([uint32]::Parse('80000001','HexNumber')) | Out-Null
while ($true) { Start-Sleep -Seconds 60 }
`;

const WAKE_LOCK_BACKEND = detectWakeLockBackend();
let wakeLockProcess: ChildProcess | null = null;

function acquireWakeLock(): void {
  if (wakeLockProcess) return; // already held
  if (WAKE_LOCK_BACKEND === 'none') return;

  try {
    if (WAKE_LOCK_BACKEND === 'wsl-powershell') {
      const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
      wakeLockProcess = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', PS_WAKE_SCRIPT], { stdio: 'ignore' });
    } else if (WAKE_LOCK_BACKEND === 'win32-powershell') {
      // Native Windows: powershell.exe is on PATH
      wakeLockProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_WAKE_SCRIPT], { stdio: 'ignore' });
    } else if (WAKE_LOCK_BACKEND === 'systemd-inhibit') {
      // systemd-inhibit --mode=block holds the inhibitor lock while the child lives.
      // 'sleep infinity' avoids the 24-hour limit of 'sleep 86400'.
      wakeLockProcess = spawn('systemd-inhibit', [
        '--what=idle:sleep', '--who=aigent', '--why=Agent is working', '--mode=block',
        'sleep', 'infinity',
      ], { stdio: 'ignore' });
    } else if (WAKE_LOCK_BACKEND === 'caffeinate') {
      // macOS: -d = display sleep, -i = idle sleep, -s = system sleep
      wakeLockProcess = spawn('caffeinate', ['-dis'], { stdio: 'ignore' });
    }

    wakeLockProcess?.on('error', () => { wakeLockProcess = null; });
    wakeLockProcess?.on('exit', () => { wakeLockProcess = null; });
    log.info('Sleep inhibitor acquired', { backend: WAKE_LOCK_BACKEND });
  } catch (err) {
    log.warn('Failed to acquire sleep inhibitor', { err: String(err) });
  }
}

function releaseWakeLock(): void {
  if (!wakeLockProcess) return;
  try {
    wakeLockProcess.kill();
  } catch {}
  wakeLockProcess = null;
  log.info('Sleep inhibitor released');
}

// In test mode the server is not started, so injected requests are never registered
// in the pending maps. Suppress "no pending X" error messages to keep tests clean.
const IS_TEST_MODE = process.env['AIGENT_TEST_MODE'] === '1';

// --- CLI args ---

function parseArgs(): GatekeeperArgs {
  const args = process.argv.slice(2);
  const result: GatekeeperArgs = { headless: false, watch: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--model' && args[i + 1]) {
      result.model = args[++i]!;
    } else if (arg === '--thinking' && args[i + 1]) {
      result.thinking = args[++i]!;
    } else if (arg === '--headless') {
      result.headless = true;
    } else if (arg === '--watch') {
      result.watch = true;
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
  --watch                Watch src/ for changes, auto-restart server (preserves gatekeeper)
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
  log.info('Starting server...', { devMode: IS_DEV_MODE });

  // In prod/global-install mode spawn the compiled server.js directly (no tsx).
  // In dev mode spawn server.ts via tsx (as before).
  const defaultWorkspace = IS_DEV_MODE
    ? resolve(REPO_DIR, 'workspace')
    : getDefaultWorkspace();

  let spawnCmd: string;
  let spawnArgs: string[];

  if (IS_DEV_MODE) {
    const serverEntry = resolve(__dirname, 'server.ts');
    const tsconfig = resolve(REPO_DIR, 'tsconfig.json');
    spawnCmd = 'tsx';
    spawnArgs = ['--tsconfig', tsconfig, serverEntry];
  } else {
    spawnCmd = 'node';
    spawnArgs = [COMPILED_SERVER];
  }

  serverProcess = spawn(spawnCmd, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: IS_DEV_MODE ? REPO_DIR : process.cwd(),
    env: {
      ...process.env,
      AIGENT_WORKSPACE: process.env['AIGENT_WORKSPACE'] ?? defaultWorkspace,
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
      // restartServer() is already managing the restart — don't spawn a second process
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
  // Clear any deferred restart — we're restarting now
  pendingRestart = false;
  if (pendingRestartTimeout) { clearTimeout(pendingRestartTimeout); pendingRestartTimeout = null; }

  if (isRestarting) {
    log.info('restartServer: already restarting — skipping');
    return;
  }
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

// --- File watcher (auto-restart server on src/ changes, rebuild web on web/src/ changes) ---

const SRC_DIR = join(REPO_DIR, 'src');
const WEB_SRC_DIR = join(REPO_DIR, 'web', 'src');

function getFileHashes(dir: string): Map<string, number> {
  const hashes = new Map<string, number>();
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        for (const [k, v] of getFileHashes(full)) hashes.set(k, v);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') || entry.name.endsWith('.css')) {
        try {
          hashes.set(full, statSync(full).mtimeMs);
        } catch {}
      }
    }
  } catch {}
  return hashes;
}

let lastSrcHashes = getFileHashes(SRC_DIR);
let lastWebHashes = getFileHashes(WEB_SRC_DIR);
let fileWatchDebounce: ReturnType<typeof setTimeout> | null = null;

function startFileWatcher(): void {
  setInterval(() => {
    // Check server-side src/ changes
    const currentSrc = getFileHashes(SRC_DIR);
    let srcChanged = false;
    for (const [file, mtime] of currentSrc) {
      if (lastSrcHashes.get(file) !== mtime) { srcChanged = true; break; }
    }
    if (currentSrc.size !== lastSrcHashes.size) srcChanged = true;

    // Check web/src/ changes
    const currentWeb = getFileHashes(WEB_SRC_DIR);
    let webChanged = false;
    for (const [file, mtime] of currentWeb) {
      if (lastWebHashes.get(file) !== mtime) { webChanged = true; break; }
    }
    if (currentWeb.size !== lastWebHashes.size) webChanged = true;

    if (!srcChanged && !webChanged) return;
    if (srcChanged) lastSrcHashes = currentSrc;
    if (webChanged) lastWebHashes = currentWeb;

    if (fileWatchDebounce) clearTimeout(fileWatchDebounce);
    fileWatchDebounce = setTimeout(() => {
      fileWatchDebounce = null;

      if (isRestarting) {
        log.info('File change detected but restart already in progress — skipping');
        return;
      }

      // Typecheck before anything
      log.info('Source files changed — typechecking');
      try {
        execSync('npx tsc --noEmit', {
          cwd: REPO_DIR,
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 30_000,
        });
        log.info('Typecheck passed');
      } catch (err: unknown) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
        const errorLines = stderr.split('\n').filter((l: string) => l.includes('error TS')).slice(0, 5);
        const detail = errorLines.length > 0 ? errorLines.map((l: string) => l.trim()).join('; ') : stderr.slice(0, 500);
        log.warn('Typecheck failed — not reloading', { errors: detail });
        return;
      }

      // Rebuild web UI if web sources changed
      if (webChanged) {
        log.info('Rebuilding web UI');
        try {
          execSync('npx vite build --config web/vite.config.ts', {
            cwd: REPO_DIR,
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 30_000,
          });
          log.info('Web build complete');
        } catch (err: unknown) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
          log.warn('Web build failed', { error: stderr.slice(0, 500) });
        }
      }

      // Restart server — defer if the agent is mid-turn to avoid killing a response
      if (agentBusy) {
        if (!pendingRestart) {
          pendingRestart = true;
          log.info('Agent busy — deferring restart until idle');
          injectSystemMessage('Source changed. Restart deferred until agent finishes current turn.');
          pendingRestartTimeout = setTimeout(() => {
            if (pendingRestart) {
              pendingRestart = false;
              pendingRestartTimeout = null;
              log.warn('Deferred restart timeout — forcing restart');
              injectSystemMessage('Deferred restart timeout (120s). Restarting now.');
              void restartServer();
            }
          }, 120_000);
        }
      } else {
        log.info('Restarting server');
        void restartServer();
      }
    }, 2000);
  }, 1000);
}

async function waitForSocket(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(SOCKET_PATH)) {
      // Verify the socket is actually connectable, not just present on disk
      const ok = await new Promise<boolean>((resolve) => {
        const sock = createConnection(SOCKET_PATH);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('error', () => { resolve(false); });
      });
      if (ok) return;
    }
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
  releaseWakeLock();
  stopHostDaemon();
  if (serverProcess) {
    try { serverProcess.kill('SIGTERM'); } catch {}
  }
  cleanupSocket();
}

// --- Command interception ---

/** Commands the gatekeeper handles locally (not forwarded to worker). */
const GATEKEEPER_COMMANDS = new Set(['/approve', '/reject', '/preview', '/approve-patch', '/reject-patch', '/approve-exec', '/deny-exec', '/approve-fetch', '/deny-fetch', '/approve-file', '/deny-file', '/approve-fetchsize', '/deny-fetchsize', '/approve-mcp', '/deny-mcp', '/approve-browser-write', '/deny-browser-write', '/set-env', '/reload']);

function isGatekeeperCommand(input: string): boolean {
  const cmd = input.trim().split(/\s+/)[0]?.toLowerCase();
  return cmd ? GATEKEEPER_COMMANDS.has(cmd) : false;
}

/**
 * Update or insert env vars in the .env file.
 * Empty-string values remove the key. Boolean false for toggle keys → removes key.
 */
function writeEnvVars(updates: Record<string, boolean | number | string>): void {
  // In prod/global mode write to XDG config .env; in dev mode write to repo root .env.
  const envPath = IS_DEV_MODE ? resolve(REPO_DIR, '.env') : getEnvFile();
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
  const permCtx = getPermCtx();
  if (await _handleExecApproveReject(permCtx, input)) return;
  if (await _handleFetchApproveReject(permCtx, input)) return;
  if (_handleFileAccessApproveReject(permCtx, input)) return;
  if (_handleFetchSizeApproveReject(permCtx, input)) return;
  if (_handleMcpToolApproveReject(permCtx, input)) return;
  if (await handleBrowserWriteApproveReject(input)) return;

  const parts = input.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase();

  switch (cmd) {
    case '/reload': {
      const ttyLog = (msg: string) => process.stdout.write(`[reload] ${msg}\n`);
      injectSystemMessage('Reloading: running typecheck…');
      void (async () => {
        // Step 1: Typecheck
        ttyLog('Running typecheck…');
        log.info('/reload: starting typecheck');
        try {
          execSync('npx tsc --noEmit', {
            cwd: REPO_DIR,
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 30_000,
          });
          ttyLog('Typecheck passed ✓');
          log.info('/reload: typecheck passed');
        } catch (err: unknown) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
          const errorLines = stderr.split('\n').filter((l: string) => l.includes('error TS')).slice(0, 5);
          const detail = errorLines.length > 0 ? errorLines.map((l: string) => l.trim()).join('\n') : stderr.slice(0, 500);
          ttyLog(`Typecheck FAILED ✗\n${detail}`);
          injectSystemMessage(`Reload aborted — typecheck failed:\n${detail}`);
          log.warn('/reload: typecheck failed', { errors: detail });
          return;
        }

        // Step 2: Vite build
        ttyLog('Building web UI…');
        injectSystemMessage('Typecheck passed. Building web UI…');
        log.info('/reload: starting vite build');
        try {
          execSync('npx vite build --config web/vite.config.ts', {
            cwd: REPO_DIR,
            stdio: ['ignore', 'ignore', 'pipe'],
            timeout: 60_000,
          });
          ttyLog('Vite build complete ✓');
          log.info('/reload: vite build complete');
        } catch (err: unknown) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
          ttyLog(`Vite build FAILED ✗\n${stderr.slice(0, 500)}`);
          injectSystemMessage(`Reload aborted — web build failed:\n${stderr.slice(0, 500)}`);
          log.warn('/reload: vite build failed', { error: stderr.slice(0, 500) });
          return;
        }

        // Step 3: Restart server — defer if agent is mid-turn
        if (agentBusy) {
          ttyLog('Agent busy — restart deferred until current turn completes');
          injectSystemMessage('Build ready. Restart deferred until agent finishes current turn.');
          log.info('/reload: agent busy, deferring restart');
          pendingRestart = true;
          pendingRestartTimeout = setTimeout(() => {
            if (pendingRestart) {
              pendingRestart = false;
              pendingRestartTimeout = null;
              log.warn('/reload: deferred restart timeout — forcing restart');
              injectSystemMessage('Deferred restart timeout (120s). Restarting now.');
              void restartServer();
            }
          }, 120_000);
        } else {
          ttyLog('Restarting server…');
          injectSystemMessage('Build complete. Restarting server…');
          log.info('/reload: restarting server');
          try {
            await restartServer();
            ttyLog('Server reloaded ✓');
            injectSystemMessage('Server reloaded.');
            log.info('/reload: restart complete');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            ttyLog(`Server restart FAILED ✗ — ${msg}`);
            injectSystemMessage(`Server reload failed: ${msg}`);
            log.error('/reload: restart failed', { error: msg });
          }
        }
      })();
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
// ClassifierDecision type is imported from gk-perm-utils.ts
export type { ClassifierDecision } from './gk-perm-utils.js';
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

/** Build the PermCtx for permission handler modules. */
function getPermCtx(): PermCtx {
  return {
    client,
    log,
    injectSystemMessage,
    broadcastUpdatedPermissions,
    auditLog,
    classifierDecisions,
    getRecentContext,
  };
}

// --- Exec, fetch, file, MCP permission handlers are delegated to gk-*-perms.ts modules ---
// Browser permissions remain here due to tight coupling with browserRequest().

/** Called by web-bridge when POST /settings completes — re-evaluate all pending approvals. */
function handleSettingsChanged(): void {
  broadcastUpdatedPermissions();
  const ctx = getPermCtx();
  flushPendingExecApprovals(ctx);
  flushPendingFetchApprovals(ctx);
  flushPendingFileAccessApprovals(ctx);
  flushPendingMCPApprovals(ctx);
  flushPendingBrowserApprovals();
}

function broadcastUpdatedPermissions(): void {
  if (!client) return;
  const settings = readSettingsSync();
  const execPerms = readExecPermissions();
  const fetchPerms = readFetchPermissions();
  const filePerms = readFilePermissions();
  const mcpPerms = readMCPPermissions();
  const browserPerms = readBrowserPermissions();
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
    browser_perm_read: JSON.stringify(browserPerms.read),
    browser_perm_write: JSON.stringify(browserPerms.write),
    browser_perm_script: JSON.stringify(browserPerms.script),
    browser_perm_deny: JSON.stringify(browserPerms.deny),
    mcp_perm_servers: JSON.stringify(mcpPerms.servers),
  });
}

// --- Browser per-domain permissions ---

interface PendingBrowserWrite {
  action: string;
  tabId?: number;
  steps?: unknown[];
  url?: string;
  domain?: string;
  requiredTier: 'read' | 'write' | 'script';
  clear?: boolean;
  options?: { network?: boolean; console?: boolean; performance?: boolean };
}

const pendingBrowserWriteApprovals = new Map<string, PendingBrowserWrite>();
// IDs auto-handled (grant active) before web-bridge listener fires — web-bridge skips these
const autoHandledBrowserWriteIds = new Set<string>();
// AbortControllers for in-flight gatekeeper-side browser requests, keyed by bext request ID.
// Populated when a browser request starts; deleted when it resolves or is cancelled.
const browserRequestControllers = new Map<string, AbortController>();

// --- PiP state tracking ---
let pipOpen = false;
const pendingPiPSuggestions = new Map<string, () => void>();

function setPiPOpen(open: boolean): void { pipOpen = open; }

function resolvePiPSuggestion(id: string, action: 'float' | 'skip'): void {
  if (action === 'float') pipOpen = true;
  const resolve = pendingPiPSuggestions.get(id);
  if (resolve) { pendingPiPSuggestions.delete(id); resolve(); }
}

function readBrowserPermissions(): BrowserPermissions {
  try {
    const settings = readSettingsSync();
    const perms = settings['browser_permissions'];
    if (!perms || typeof perms !== 'object') return DEFAULT_BROWSER_PERMISSIONS;
    const p = perms as Partial<BrowserPermissions>;
    return {
      read: Array.isArray(p.read) ? p.read : DEFAULT_BROWSER_PERMISSIONS.read,
      write: Array.isArray(p.write) ? p.write : DEFAULT_BROWSER_PERMISSIONS.write,
      script: Array.isArray(p.script) ? p.script : DEFAULT_BROWSER_PERMISSIONS.script,
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_BROWSER_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_BROWSER_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_BROWSER_PERMISSIONS;
  }
}

function addToBrowserPermissionList(tier: 'read' | 'write' | 'script' | 'deny', pattern: string): void {
  try {
    writeSettingsSync('gatekeeper:addToBrowserPermission', (settings) => {
      const perms = (settings['browser_permissions'] as Partial<BrowserPermissions> | undefined) ?? {};
      const current = Array.isArray(perms[tier]) ? [...perms[tier]!] : [];
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
      return { ...settings, browser_permissions: { ...DEFAULT_BROWSER_PERMISSIONS, ...perms, [tier]: current } };
    });
    log.info('Added pattern to browser permissions', { tier, pattern });
    broadcastUpdatedPermissions();
    flushPendingBrowserApprovals();
  } catch (err) {
    log.error('Failed to update browser permissions', { error: String(err) });
  }
}

/** Re-check pending browser approvals against updated permissions and auto-resolve matches. */
function flushPendingBrowserApprovals(): void {
  if (pendingBrowserWriteApprovals.size === 0) return;
  const perms = readBrowserPermissions();
  const toResolve: Array<[string, PendingBrowserWrite]> = [];
  for (const [id, pending] of pendingBrowserWriteApprovals) {
    if (!pending.domain) continue;
    const granted = checkBrowserPermission(pending.domain.includes('://') ? pending.domain : `https://${pending.domain}`, perms);
    if (browserTierSufficient(granted, pending.requiredTier)) {
      toResolve.push([id, pending]);
    }
  }
  for (const [id, pending] of toResolve) {
    pendingBrowserWriteApprovals.delete(id);
    auditLog({ type: 'browser_ext_domain_grant', detail: `${pending.action} on ${pending.domain}` });
    autoHandledBrowserWriteIds.add(id);
    const params: Record<string, unknown> = {};
    if (pending.tabId !== undefined) params.tabId = pending.tabId;
    if (pending.steps !== undefined) params.steps = pending.steps;
    if (pending.url !== undefined) params.url = pending.url;
    if (pending.clear !== undefined) params.clear = pending.clear;
    if (pending.options !== undefined) params.options = pending.options;
    const ac1 = new AbortController();
    browserRequestControllers.set(id, ac1);
    void browserRequest(pending.action, params, ac1.signal).then((result) => {
      browserRequestControllers.delete(id);
      sendBrowserExtResult(id, result);
    }).catch((err: Error) => {
      browserRequestControllers.delete(id);
      client!.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
    });
    // Dismiss from UI
    client!.emit('perm_dismissed', [id]);
  }
}

function summariseBrowserWriteAction(action: string, steps?: unknown[], url?: string, tabId?: number): string {
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

/** Extract hostname from a URL, returning undefined on failure. */
function extractDomain(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname.toLowerCase(); } catch { return undefined; }
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
    // Already resolved — silently ignore.
    return true;
  }

  pendingBrowserWriteApprovals.delete(id);

  if (cmd === '/deny-browser-write') {
    auditLog({ type: 'browser_ext_user_deny', detail: `${pending.action}`, approved: false });
    injectSystemMessage(`Browser action denied: ${id}`);
    client!.send({ type: 'browser_ext_result', id, ok: false, error: 'User denied browser action' });
    client!.emit('perm_dismissed', [id]);
    return true;
  }

  // Approve — check for --always-read / --always-write / --always-script flags
  auditLog({ type: 'browser_ext_user_approve', detail: `${pending.action}`, approved: true });

  const alwaysRead = parts.includes('--always-read');
  const alwaysWrite = parts.includes('--always-write');
  const alwaysScript = parts.includes('--always-script');
  const domain = pending.domain;

  if (domain && (alwaysRead || alwaysWrite || alwaysScript)) {
    const tier = alwaysScript ? 'script' : alwaysWrite ? 'write' : 'read';
    addToBrowserPermissionList(tier, domain);
    injectSystemMessage(`Browser ${tier} approved and always-allowed for ${domain}`);
  } else {
    injectSystemMessage(`Browser action approved (once): ${pending.action}`);
  }

  const params: Record<string, unknown> = {};
  if (pending.tabId !== undefined) params.tabId = pending.tabId;
  if (pending.steps !== undefined) params.steps = pending.steps;
  if (pending.url !== undefined) params.url = pending.url;
  if (pending.clear !== undefined) params.clear = pending.clear;
  if (pending.options !== undefined) params.options = pending.options;

  client!.emit('perm_dismissed', [id]);
  const ac2 = new AbortController();
  browserRequestControllers.set(id, ac2);
  browserRequest(pending.action, params, ac2.signal).then((result) => {
    browserRequestControllers.delete(id);
    sendBrowserExtResult(id, result);
  }).catch((err: Error) => {
    browserRequestControllers.delete(id);
    client!.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
  });

  return true;
}

/**
 * Route a browser action through the extension or Playwright fallback.
 * Returns a promise that resolves with the response.
 */
async function browserRequest(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{ ok: boolean; treeText?: string; dataUrl?: string; tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[]; stepsCompleted?: number; totalSteps?: number; finalUrl?: string; finalTitle?: string; newTabId?: number; screenshots?: Array<{ stepIndex: number; dataUrl: string }>; devtools?: unknown; error?: string }> {
  if (extensionBridge.isConnected()) {
    return extensionBridge.request(action as Parameters<typeof extensionBridge.request>[0], params, 30_000, signal);
  }

  // Fallback to Playwright headless browser
  try {
    const { playwrightBridge } = await import('./playwright-bridge.js');
    return await playwrightBridge.request(action, params, signal);
  } catch (err) {
    throw new Error(
      'No browser available. Either:\n' +
      '  1. Install the aigent Chrome extension and connect it, or\n' +
      '  2. Install playwright-core: npm install playwright-core && npx playwright install chromium\n' +
      `Original error: ${String(err)}`,
    );
  }
}

/** Relay a browser extension result (used by both approval handler and auto-approval path). */
function sendBrowserExtResult(id: string, result: { ok: boolean; treeText?: string; dataUrl?: string; tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[]; stepsCompleted?: number; totalSteps?: number; finalUrl?: string; finalTitle?: string; newTabId?: number; screenshots?: Array<{ stepIndex: number; dataUrl: string }>; devtools?: unknown; error?: string }): void {
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
  if (result.devtools !== undefined) msg.devtools = result.devtools;
  if (result.error !== undefined) msg.error = result.error;
  client!.send(msg);
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
rotateIfNeeded(LOG_PATH);
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

// Initialize Tier 3 classifier — uses the active provider's credentials
if (process.env['AIGENT_CLASSIFIER'] !== '0') {
  const { detectProvider: _detectProvider } = await import('./provider.js');
  const _providerType = _detectProvider();
  const classifierApiKey = _providerType === 'anthropic'
    ? process.env['ANTHROPIC_API_KEY']
    : (process.env['OPENAI_API_KEY'] ?? process.env['AIGENT_API_KEY'] ?? '');
  const classifierBaseURL = _providerType === 'openai' ? (process.env['AIGENT_BASE_URL'] ?? undefined) : undefined;
  if (classifierApiKey) {
    initClassifier(classifierApiKey, classifierBaseURL);
    log.info('Tier 3 classifier initialized', { provider: _providerType });
  } else {
    log.info('Tier 3 classifier disabled', { reason: 'no API key configured' });
  }
} else {
  log.info('Tier 3 classifier disabled', { reason: 'AIGENT_CLASSIFIER=0' });
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
startWebServer(client, undefined, { autoHandledExecIds: pendingExecApprovals.autoHandledIds, getExecPermissions: readExecPermissions, autoHandledFetchIds: pendingFetchApprovals.autoHandledIds, getFetchPermissions: readFetchPermissions, autoHandledBrowserWriteIds, getBrowserPermissions: readBrowserPermissions, pendingBrowserWriteApprovals, classifierDecisions, autoHandledFileAccessIds: pendingFileAccessApprovals.autoHandledIds, autoHandledMcpIds: pendingMcpToolApprovals.autoHandledIds, onSettingsChanged: handleSettingsChanged, extSecret, setPiPOpen, resolvePiPSuggestion }).then(({ port }) => {
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
    if (gatekeeperArgs.watch || process.env['AIGENT_AUTO_RELOAD'] === '1') {
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

// Track agent busy state + inhibit sleep while the agent is working
client.on('loading', (isLoading: boolean) => {
  agentBusy = isLoading;
  if (isLoading) {
    acquireWakeLock();
  } else {
    releaseWakeLock();
    // If a file-watcher restart was deferred while the agent was busy, execute it now
    if (pendingRestart) {
      pendingRestart = false;
      if (pendingRestartTimeout) { clearTimeout(pendingRestartTimeout); pendingRestartTimeout = null; }
      log.info('Agent idle — executing deferred restart');
      injectSystemMessage('Agent idle. Applying deferred code reload...');
      void restartServer();
    }
  }
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
  _handleAgentExecRequest(getPermCtx(), id, command);
});

// Handle fetch approval requests from the worker
client.on('fetch_request', (id: string, url: string, method?: string) => {
  _handleAgentFetchRequest(getPermCtx(), id, url, method);
});

// Handle file access approval requests (sensitive paths / out-of-project writes)
client.on('file_access_request', (id: string, path: string, operation: 'read' | 'write', reason: string) => {
  _handleAgentFileAccessRequest(getPermCtx(), id, path, operation, reason);
});

// Handle fetch size approval requests (agent wants more than the default 1 MB)
client.on('fetch_size_request', (id: string, url: string, requestedBytes: number, defaultBytes: number) => {
  _handleAgentFetchSizeRequest(getPermCtx(), id, url, requestedBytes, defaultBytes);
});

// Handle MCP tool approval requests
client.on('mcp_tool_request', (id: string, server: string, tool: string, params: string) => {
  _handleAgentMcpToolRequest(getPermCtx(), id, server, tool, params);
});

// Cancel an in-flight browser request when the agent aborts.
client.on('browser_ext_cancel', (id: string) => {
  const ac = browserRequestControllers.get(id);
  if (ac) {
    log.info('Cancelling in-flight browser request', { id });
    ac.abort();
    browserRequestControllers.delete(id);
  }
});

// Handle browser extension requests — per-domain three-tier permission check
client.on('browser_ext_request', (id: string, action: string, tabId?: number, rootSelector?: string, steps?: unknown[], url?: string, clear?: boolean, options?: { network?: boolean; console?: boolean; performance?: boolean }) => {
  // Classify what tier this action requires
  const requiredTier = classifyBrowserAction(action, steps);

  // SSRF check for any action involving URLs
  const ssrfErr = validateBrowserUrls(action, steps, url);
  if (ssrfErr) {
    auditLog({ type: 'browser_ext_ssrf_block', detail: `${action}${url ? ` ${url}` : ''}`, reason: ssrfErr });
    client.send({ type: 'browser_ext_result', id, ok: false, error: `Blocked: ${ssrfErr}` });
    return;
  }

  // Determine the target domain (from explicit url, or fall back to the active tab)
  const effectiveUrl = url || extensionBridge.getActiveTabUrl() || undefined;
  const domain = extractDomain(effectiveUrl);

  // Check per-domain permissions
  if (domain) {
    const perms = readBrowserPermissions();
    const granted = checkBrowserPermission(effectiveUrl!, perms);

    if (granted === 'deny') {
      auditLog({ type: 'browser_ext_domain_deny', detail: `${action} on ${domain}` });
      client.send({ type: 'browser_ext_result', id, ok: false, error: `Domain ${domain} is in browser deny list` });
      return;
    }

    if (browserTierSufficient(granted, requiredTier)) {
      log.info('Browser action auto-approved by domain permission', { id, action, domain, granted, requiredTier });
      auditLog({ type: 'browser_ext_domain_grant', detail: `${action} on ${domain} (${granted} >= ${requiredTier})` });
      autoHandledBrowserWriteIds.add(id);
      const params: Record<string, unknown> = {};
      if (tabId !== undefined) params.tabId = tabId;
      if (rootSelector !== undefined) params.rootSelector = rootSelector;
      if (steps !== undefined) params.steps = steps;
      if (url !== undefined) params.url = url;
      if (clear !== undefined) params.clear = clear;
      if (options !== undefined) params.options = options;
      const ac3 = new AbortController();
      browserRequestControllers.set(id, ac3);
      void browserRequest(action, params, ac3.signal).then((result) => {
        browserRequestControllers.delete(id);
        sendBrowserExtResult(id, result);
      }).catch((err: Error) => {
        browserRequestControllers.delete(id);
        client.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
      });
      return;
    }
  }

  // Read actions with no domain info: auto-approve (they're passive)
  if (requiredTier === 'read') {
    auditLog({ type: 'browser_ext_read', detail: action });
    const params: Record<string, unknown> = {};
    if (tabId !== undefined) params.tabId = tabId;
    if (rootSelector !== undefined) params.rootSelector = rootSelector;
    if (clear !== undefined) params.clear = clear;
    if (options !== undefined) params.options = options;

    // For activate_tab: prompt user to float chat via PiP before the tab switch
    if (action === 'activate_tab' && !pipOpen && readSettingsSync()['auto_pip'] !== false) {
      const pipId = `pip_${id}`;
      const pipPromise = new Promise<void>((resolve) => {
        pendingPiPSuggestions.set(pipId, resolve);
        setTimeout(() => {
          if (pendingPiPSuggestions.has(pipId)) {
            pendingPiPSuggestions.delete(pipId);
            resolve();
          }
        }, 30_000);
      });
      client.emit('pip_suggestion', pipId);
      pipPromise.then(() => {
        const ac4 = new AbortController();
        browserRequestControllers.set(id, ac4);
        void extensionBridge.request(action as Parameters<typeof extensionBridge.request>[0], params, 30_000, ac4.signal).then((result) => {
          browserRequestControllers.delete(id);
          sendBrowserExtResult(id, result);
        }).catch((err: Error) => {
          browserRequestControllers.delete(id);
          client.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
        });
      });
      return;
    }

    const ac5 = new AbortController();
    browserRequestControllers.set(id, ac5);
    void extensionBridge.request(action as Parameters<typeof extensionBridge.request>[0], params, 30_000, ac5.signal).then((result) => {
      browserRequestControllers.delete(id);
      sendBrowserExtResult(id, result);
    }).catch((err: Error) => {
      browserRequestControllers.delete(id);
      client.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
    });
    return;
  }

  // Not granted — queue for user approval
  auditLog({ type: 'browser_ext_prompt', detail: `${action}${domain ? ` on ${domain}` : ''}` });
  const stepSummary = summariseBrowserWriteAction(action, steps, url, tabId);
  pendingBrowserWriteApprovals.set(id, {
    action,
    ...(tabId !== undefined ? { tabId } : {}),
    ...(steps !== undefined ? { steps } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(domain !== undefined ? { domain } : {}),
    ...(clear !== undefined ? { clear } : {}),
    ...(options !== undefined ? { options } : {}),
    requiredTier,
  });
  log.info('Browser action approval requested', { id, action, domain, requiredTier });
  const actionDesc = action === 'navigate' ? `navigate to: ${url ?? '?'}`
    : action === 'open_tab' ? `open new tab: ${url ?? '?'}`
    : action === 'close_tab' ? `close tab ${tabId ?? '?'}`
    : `run browser ${requiredTier === 'script' ? 'script' : 'action'}: ${stepSummary}`;
  const tierHint = domain ? `\n  To always allow ${requiredTier} on ${domain}: /approve-browser-write ${id} --always-${requiredTier}` : '';
  injectSystemMessage(
    `Agent wants to ${actionDesc}\n` +
    `  Reply: /approve-browser-write ${id} or /deny-browser-write ${id}` +
    tierHint
  );
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
