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
import { existsSync, mkdirSync, unlinkSync, readFileSync, writeFileSync, renameSync, createWriteStream, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import 'dotenv/config'; // Load .env from cwd (repo root)
import { fileURLToPath } from 'node:url';
import { SOCKET_DIR, SOCKET_PATH } from './protocol.js';
import { createLogger } from './logger.js';
import { checkExecPermission, checkTier1Deny, DEFAULT_EXEC_PERMISSIONS, type ExecPermissions, checkFetchPermission, DEFAULT_FETCH_PERMISSIONS, type FetchPermissions, parseCommandPipeline } from './safety.js';
import { initClassifier, classifyCommand, isClassifierAvailable } from './classifier.js';
import { extensionBridge } from './ext-bridge.js';
import { buildDisplayDiff } from './diff.js';

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

/** Push current host state (capabilities) to all UI listeners. */
function emitHostState(): void {
  if (!client) return;
  client.emit(
    'host_state',
    [], // No mounts — agent runs on host with direct filesystem access
    readCapabilities(),
  );
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
  // across container restarts. It cleans up its own socket in LLMProxy.start().
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
const GATEKEEPER_COMMANDS = new Set(['/approve', '/reject', '/preview', '/approve-patch', '/reject-patch', '/approve-exec', '/deny-exec', '/approve-fetch', '/deny-fetch', '/approve-browser-write', '/deny-browser-write', '/grant-browser-autonomous', '/revoke-browser-autonomous', '/set-env']);

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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending config write: ${id}`);
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending config write: ${id}`);
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending config write: ${id}`);
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

function handleEditFileRequest(
  id: string,
  containerPath: string,
  edits: Array<{ old_str: string; new_str: string; index?: number }>,
  reason: string,
): void {
  const hostPath = resolveHostPath(containerPath);

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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending edit request: ${id}`);
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending edit request: ${id}`);
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

const pendingExecApprovals = new Map<string, { command: string; classifierReason?: string }>();
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
      alwaysAllow: Array.isArray(p.alwaysAllow)
        ? [...new Set([...DEFAULT_EXEC_PERMISSIONS.alwaysAllow, ...p.alwaysAllow])]
        : DEFAULT_EXEC_PERMISSIONS.alwaysAllow,
      deny: Array.isArray(p.deny)
        ? [...new Set([...DEFAULT_EXEC_PERMISSIONS.deny, ...p.deny])]
        : DEFAULT_EXEC_PERMISSIONS.deny,
    };
  } catch {
    return DEFAULT_EXEC_PERMISSIONS;
  }
}

function broadcastUpdatedPermissions(): void {
  if (!client) return;
  const execPerms = readExecPermissions();
  const fetchPerms = readFetchPermissions();
  client.emit('permissions_updated', {
    exec_perm_alwaysAllow: JSON.stringify(execPerms.alwaysAllow),
    exec_perm_deny: JSON.stringify(execPerms.deny),
    fetch_perm_alwaysAllow: JSON.stringify(fetchPerms.alwaysAllow),
    fetch_perm_deny: JSON.stringify(fetchPerms.deny),
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
    const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf-8') : '{}';
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
    const current = Array.isArray(perms.alwaysAllow) ? perms.alwaysAllow : [...DEFAULT_EXEC_PERMISSIONS.alwaysAllow];
    const patterns = deriveExecPatterns(command);
    for (const pattern of patterns) {
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
    }
    settings['exec_permissions'] = { ...DEFAULT_EXEC_PERMISSIONS, ...perms, alwaysAllow: current };
    const tmp = SETTINGS_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    renameSync(tmp, SETTINGS_PATH);
    log.info('Added command to always-allow', { command, patterns });
    broadcastUpdatedPermissions();
  } catch (err) {
    log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function addCommandToDenyList(command: string): void {
  try {
    const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf-8') : '{}';
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = (settings['exec_permissions'] as Partial<ExecPermissions> | undefined) ?? {};
    const current = Array.isArray(perms.deny) ? perms.deny : [...DEFAULT_EXEC_PERMISSIONS.deny];
    const patterns = deriveExecPatterns(command);
    for (const pattern of patterns) {
      if (!current.includes(pattern)) {
        current.push(pattern);
      }
    }
    settings['exec_permissions'] = { ...DEFAULT_EXEC_PERMISSIONS, ...perms, deny: current };
    const tmp = SETTINGS_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    renameSync(tmp, SETTINGS_PATH);
    log.info('Added command to deny list', { command, patterns });
    broadcastUpdatedPermissions();
  } catch (err) {
    log.error('Failed to update exec permissions', { error: String(err) });
  }
}

function handleAgentExecRequest(id: string, command: string): void {
  // --- Tier 1: Static deny (instant block, no override) ---
  const tier1 = checkTier1Deny(command);
  if (tier1) {
    log.info('Exec blocked by Tier 1 (static deny)', { id, command, reason: tier1 });
    autoHandledExecIds.add(id);
    client!.send({ type: 'exec_response', id, ok: false, message: `Blocked (safety): ${tier1}` });
    injectSystemMessage(`[exec] Blocked by safety engine: ${tier1}\n  Command: ${command}`);
    return;
  }

  // --- Tier 2: Static allow/deny (from settings.json) ---
  const permissions = readExecPermissions();
  const level = checkExecPermission(command, permissions);

  if (level === 'allow') {
    log.info('Exec auto-allowed (Tier 2)', { id, command });
    autoHandledExecIds.add(id);
    client!.send({ type: 'exec_response', id, ok: true, message: 'Allowed by permission policy' });
    return;
  }

  if (level === 'deny') {
    log.info('Exec auto-denied (Tier 2)', { id, command });
    autoHandledExecIds.add(id);
    client!.send({ type: 'exec_response', id, ok: false, message: 'Denied by permission policy' });
    injectSystemMessage(`[exec] Blocked by deny policy: ${command}`);
    return;
  }

  // --- Tier 3: Haiku classifier (async) ---
  if (isClassifierAvailable() && process.env['AIGENT_CLASSIFIER'] !== '0') {
    classifyCommand(command, { cwd: process.cwd() })
      .then(result => {
        if (result.action === 'allow') {
          log.info('Exec auto-allowed (Tier 3 classifier)', { id, command, reason: result.reason });
          autoHandledExecIds.add(id);
          client!.send({ type: 'exec_response', id, ok: true, message: `Allowed by classifier: ${result.reason}` });
          return;
        }

        if (result.action === 'block') {
          log.info('Exec blocked (Tier 3 classifier)', { id, command, reason: result.reason });
          autoHandledExecIds.add(id);
          client!.send({ type: 'exec_response', id, ok: false, message: `Blocked by classifier: ${result.reason}` });
          injectSystemMessage(`[exec] Blocked by classifier: ${result.reason}\n  Command: ${command}`);
          return;
        }

        // 'ask' — prompt the user with the classifier's assessment
        promptUserForExec(id, command, result.reason);
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

function promptUserForExec(id: string, command: string, classifierReason?: string): void {
  pendingExecApprovals.set(id, classifierReason ? { command, classifierReason } : { command });
  log.info('Exec approval requested', { id, command, classifierReason });

  let msg = `Agent wants to run: ${command}\n`;
  if (classifierReason) {
    msg += `  Classifier: ${classifierReason}\n`;
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending exec request: ${id}`);
      return true;
    }

    const alwaysAllow = parts.includes('--always');
    pendingExecApprovals.delete(id);

    if (alwaysAllow) {
      addCommandToAlwaysAllow(pending.command);
      const patterns = deriveExecPatterns(pending.command);
      injectSystemMessage(`Approved and added to always-allow: ${patterns.join(', ')}`);
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
      if (!IS_TEST_MODE) injectSystemMessage(`No pending exec request: ${id}`);
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
      alwaysAllow: Array.isArray(p.alwaysAllow)
        ? [...new Set([...DEFAULT_FETCH_PERMISSIONS.alwaysAllow, ...p.alwaysAllow])]
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
    const raw = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, 'utf-8') : '{}';
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const perms = (settings['fetch_permissions'] as Partial<FetchPermissions> | undefined) ?? {};
    const current = Array.isArray(perms.alwaysAllow) ? perms.alwaysAllow : [...DEFAULT_FETCH_PERMISSIONS.alwaysAllow];
    if (!current.includes(pattern)) {
      current.push(pattern);
    }
    settings['fetch_permissions'] = { ...DEFAULT_FETCH_PERMISSIONS, ...perms, alwaysAllow: current };
    const tmp = SETTINGS_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
    renameSync(tmp, SETTINGS_PATH);
    log.info('Added pattern to fetch always-allow', { pattern });
    broadcastUpdatedPermissions();
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
    injectSystemMessage(`Browser write denied: ${id}`);
    client!.send({ type: 'browser_ext_result', id, ok: false, error: 'User denied browser write action' });
    return true;
  }

  // Approve — relay to extension
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
    if (result.error !== undefined) msg.error = result.error;
    client!.send(msg);
  }).catch((err: Error) => {
    client!.send({ type: 'browser_ext_result', id, ok: false, error: err.message });
  });

  return true;
}

/** Relay a browser extension result (used by both approval handler and auto-approval path). */
function sendBrowserExtResult(id: string, result: { ok: boolean; treeText?: string; dataUrl?: string; tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[]; stepsCompleted?: number; totalSteps?: number; finalUrl?: string; finalTitle?: string; newTabId?: number; error?: string }): void {
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

// Start web UI server before the server process so it's available during startup/restarts.
const { startWebServer } = await import('./web-bridge.js');
startWebServer(client, undefined, { autoHandledExecIds, getExecPermissions: readExecPermissions, autoHandledFetchIds, getFetchPermissions: readFetchPermissions, autoHandledBrowserWriteIds }).then(({ port }) => {
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

// Handle browser extension requests from the host daemon — relay to the Chrome extension
client.on('browser_ext_request', (id: string, action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab', tabId?: number, rootSelector?: string, steps?: unknown[], url?: string) => {
  const isWriteAction = action === 'run_script' || action === 'navigate' || action === 'open_tab' || action === 'close_tab';

  if (isWriteAction) {
    // Check session-level browser write grant — auto-approve if granted
    if (browserWriteGranted.value) {
      log.info('Browser write auto-approved by session grant', { id, action });
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
  // Keep process alive until container exits or SIGINT
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
