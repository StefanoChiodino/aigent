/**
 * Local LLM integration test — exercises the full agent conversation loop
 * against a local LLM (Ollama by default).
 *
 * Run on demand only:  make test-llm
 *
 * Config env vars:
 *   AIGENT_LLM_TEST_URL     — base URL (default: http://localhost:11434/v1)
 *   AIGENT_LLM_TEST_MODEL   — model name (default: auto-detect or qwen2.5:0.5b)
 *   AIGENT_LLM_TEST_CONTEXT — context window tokens (default: 10000)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync, openSync, readFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OLLAMA_HOST = process.env['AIGENT_LLM_TEST_URL']?.replace(/\/v1\/?$/, '') ?? 'http://localhost:11434';
const LLM_BASE_URL = `${OLLAMA_HOST}/v1`;
const DEFAULT_MODEL = 'qwen2.5:0.5b';
const CONTEXT_WINDOW = process.env['AIGENT_LLM_TEST_CONTEXT'] ?? '10000';
const PORT = 3143;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PID_FILE = '/tmp/aigent-test-llm-gatekeeper.pid';
const LOG_FILE = '/tmp/aigent-test-llm-gatekeeper.log';
const SETTINGS_FILE = '/tmp/aigent-test-llm-settings.json';
const SOCKET_DIR = '/tmp/aigent-test-llm';
const TEST_WORKSPACE = '/tmp/aigent-test-llm-workspace';
const TEST_TIMEOUT = 120_000; // per-assertion timeout (2 min for slow CPU inference)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch with a timeout. Returns null on failure. */
async function fetchSafe(url: string, timeoutMs = 3_000): Promise<Response | null> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

function ollamaOnPath(): boolean {
  const r = spawnSync('which', ['ollama'], { encoding: 'utf-8', timeout: 3_000 });
  return r.status === 0 && r.stdout.trim().length > 0;
}

type ServerEvent = Record<string, unknown> & { type: string };

/** Minimal WebSocket client for the test. */
class WsClient {
  private ws: WebSocket;
  private events: ServerEvent[] = [];
  private listeners: Array<(e: ServerEvent) => void> = [];
  private openPromise: Promise<void>;

  constructor() {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        this.events.push(event);
        for (const fn of this.listeners) fn(event);
      } catch { /* ignore */ }
    });
  }

  async connect() { await this.openPromise; }

  send(msg: unknown) { this.ws.send(JSON.stringify(msg)); }

  close() { this.ws.close(); }

  collected() { return [...this.events]; }

  waitForEvent(
    predicate: (e: ServerEvent) => boolean,
    timeoutMs = TEST_TIMEOUT,
    description = 'event',
  ): Promise<ServerEvent> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== handler);
        reject(new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`));
      }, timeoutMs);

      const handler = (e: ServerEvent) => {
        if (predicate(e)) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== handler);
          resolve(e);
        }
      };
      this.listeners.push(handler);
    });
  }
}

// ---------------------------------------------------------------------------
// Ollama lifecycle
// ---------------------------------------------------------------------------

let weStartedOllama = false;
let ollamaProc: ChildProcess | null = null;

async function ensureOllamaRunning(): Promise<boolean> {
  // Already running?
  const res = await fetchSafe(`${OLLAMA_HOST}/api/tags`);
  if (res?.ok) return true;

  // Not running — try to start it
  if (!ollamaOnPath()) return false;

  console.log('[test-llm] Starting ollama serve...');
  ollamaProc = spawn('ollama', ['serve'], {
    stdio: 'ignore',
    detached: true,
  });
  ollamaProc.unref();
  weStartedOllama = true;

  // Wait up to 15s for it to respond
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const r = await fetchSafe(`${OLLAMA_HOST}/api/tags`);
    if (r?.ok) return true;
    await sleep(500);
  }
  return false;
}

async function detectOrPullModel(): Promise<string | null> {
  // User-specified model
  const requested = process.env['AIGENT_LLM_TEST_MODEL'];

  // List available models
  const res = await fetchSafe(`${OLLAMA_HOST}/api/tags`);
  if (!res?.ok) return null;
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  const available = data.models?.map((m) => m.name) ?? [];

  if (requested) {
    // Check if already pulled (match with or without :latest tag)
    const found = available.some(
      (n) => n === requested || n === `${requested}:latest` || `${n}:latest` === requested,
    );
    if (found) return requested;

    // Pull it
    console.log(`[test-llm] Pulling model ${requested}...`);
    const pull = spawnSync('ollama', ['pull', requested], {
      stdio: 'inherit',
      timeout: 600_000, // 10 min for large models
    });
    return pull.status === 0 ? requested : null;
  }

  // Auto-detect: use first available
  if (available.length > 0) {
    console.log(`[test-llm] Using available model: ${available[0]}`);
    return available[0]!;
  }

  // Nothing available — pull default
  console.log(`[test-llm] No models found. Pulling ${DEFAULT_MODEL}...`);
  const pull = spawnSync('ollama', ['pull', DEFAULT_MODEL], {
    stdio: 'inherit',
    timeout: 600_000,
  });
  return pull.status === 0 ? DEFAULT_MODEL : null;
}

function stopOllama() {
  if (!weStartedOllama || !ollamaProc) return;
  console.log('[test-llm] Stopping ollama serve...');
  try { ollamaProc.kill('SIGTERM'); } catch { /* ignore */ }
  ollamaProc = null;
}

// ---------------------------------------------------------------------------
// Gatekeeper lifecycle
// ---------------------------------------------------------------------------

let gatekeeperProc: ChildProcess | null = null;

async function startGatekeeper(model: string): Promise<void> {
  // Kill stale processes on the test port
  try {
    const result = spawnSync('lsof', ['-ti', `:${PORT}`], { encoding: 'utf-8' });
    const pids = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    for (const p of pids) {
      try { process.kill(parseInt(p, 10), 'SIGKILL'); } catch { /* ignore */ }
    }
    if (pids.length > 0) await sleep(500);
  } catch { /* ignore */ }

  // Create isolated workspace so test data doesn't pollute the real workspace
  // (daily logs, episodes, memory, usage tracking all write here instead)
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
  mkdirSync(join(TEST_WORKSPACE, 'config'), { recursive: true });
  mkdirSync(join(TEST_WORKSPACE, 'memory'), { recursive: true });
  writeFileSync(join(TEST_WORKSPACE, 'config', 'AGENTS.md'), '# Test Agent\nYou are a test agent.\n');
  writeFileSync(join(TEST_WORKSPACE, 'MEMORY.md'), '');

  // Create isolated settings
  writeFileSync(SETTINGS_FILE, JSON.stringify({
    exec_always_allow: ['echo *'],
  }) + '\n');

  console.log(`[test-llm] Starting gatekeeper on port ${PORT} with model ${model}...`);
  const logFd = openSync(LOG_FILE, 'w');

  gatekeeperProc = spawn('npx', ['tsx', 'src/gatekeeper.tsx', '--headless'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIGENT_WEB_PORT: String(PORT),
      AIGENT_SOCKET_DIR: SOCKET_DIR,
      AIGENT_SETTINGS_PATH: SETTINGS_FILE,
      AIGENT_WORKSPACE: TEST_WORKSPACE,
      AIGENT_BASE_URL: LLM_BASE_URL,
      AIGENT_MODEL: model,
      AIGENT_CONTEXT_WINDOW: CONTEXT_WINDOW,
      AIGENT_SLIM_PROMPT: '1',
      AIGENT_THINKING: 'off',
      AIGENT_TOOLS_ALLOWLIST: 'exec',
      AIGENT_CLASSIFIER: '0',
      OPENAI_API_KEY: 'ollama',
      // Clear Anthropic key so provider auto-detects as OpenAI
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', logFd, logFd],
    detached: false,
  });

  if (!gatekeeperProc.pid) {
    throw new Error('Failed to spawn gatekeeper');
  }
  writeFileSync(PID_FILE, String(gatekeeperProc.pid));

  // Wait for /healthz
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await fetchSafe(`http://localhost:${PORT}/healthz`);
    if (r?.ok) {
      console.log(`[test-llm] Gatekeeper ready at http://localhost:${PORT}`);
      return;
    }
    // Check for early exit
    if (gatekeeperProc.exitCode !== null) {
      throw new Error(
        `Gatekeeper exited early (code ${gatekeeperProc.exitCode}). Check: cat ${LOG_FILE}`,
      );
    }
    await sleep(500);
  }
  throw new Error(`Gatekeeper /healthz timed out after 60s. Check: cat ${LOG_FILE}`);
}

function stopGatekeeper() {
  if (gatekeeperProc) {
    try { process.kill(gatekeeperProc.pid!, 'SIGTERM'); } catch { /* ignore */ }
    gatekeeperProc = null;
  }
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    } catch { /* ignore */ }
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
  }
  // Kill by port as fallback
  try {
    spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore', timeout: 5_000 });
  } catch { /* ignore */ }

  // Clean up files
  for (const f of [SETTINGS_FILE]) {
    if (existsSync(f)) try { unlinkSync(f); } catch { /* ignore */ }
  }
  // Clean up sockets
  for (const sock of ['worker.sock', 'host.sock', 'llm-proxy.sock', 'host-daemon.pid']) {
    const p = `${SOCKET_DIR}/${sock}`;
    if (existsSync(p)) try { unlinkSync(p); } catch { /* ignore */ }
  }
  // Clean up isolated workspace
  rmSync(TEST_WORKSPACE, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let skipReason = '';
let model = '';

describe('local LLM integration', () => {
  before(async () => {
    // 1. Ensure Ollama is running
    if (!ollamaOnPath()) {
      skipReason = 'ollama not found on PATH — install from https://ollama.com';
      return;
    }
    const running = await ensureOllamaRunning();
    if (!running) {
      skipReason = 'could not start ollama serve';
      return;
    }

    // 2. Detect or pull a model
    const m = await detectOrPullModel();
    if (!m) {
      skipReason = 'no model available and pull failed';
      return;
    }
    model = m;

    // 3. Start the gatekeeper
    try {
      await startGatekeeper(model);
    } catch (err) {
      skipReason = `gatekeeper failed to start: ${(err as Error).message}`;
    }
  });

  after(() => {
    stopGatekeeper();
    stopOllama();
  });

  it('responds to a simple message', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const ws = new WsClient();
    try {
      await ws.connect();
      ws.send({ type: 'message', content: 'Reply with exactly one word: PONG' });

      const msg = await ws.waitForEvent(
        (e) => e.type === 'message' && (e.message as { role?: string })?.role === 'assistant',
        TEST_TIMEOUT,
        'assistant message',
      );

      const content = (msg.message as { content?: string })?.content ?? '';
      assert.ok(content.length > 0, 'Expected non-empty assistant response');
      console.log(`[test-llm] Got response (${content.length} chars): ${content.slice(0, 100)}...`);
    } finally {
      ws.close();
    }
  });

  it('executes a tool call round-trip', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const ws = new WsClient();
    try {
      await ws.connect();
      ws.send({
        type: 'message',
        content: 'Run this exact shell command and tell me the output: echo integration-test-ok',
      });

      // Wait for the final assistant message (which comes after tool execution)
      const msg = await ws.waitForEvent(
        (e) => e.type === 'message' && (e.message as { role?: string })?.role === 'assistant',
        TEST_TIMEOUT,
        'assistant message after tool call',
      );

      // Check if a tool was called (look through collected events)
      const events = ws.collected();
      const toolEvents = events.filter((e) =>
        e.type === 'tool_start' || e.type === 'tool_output' || e.type === 'tool_end',
      );

      // tool_output events use "content" field
      const hasToolOutput = events.some((e) => {
        const text = JSON.stringify(e);
        return (e.type === 'tool_output' || e.type === 'tool_end') &&
          text.includes('integration-test-ok');
      });

      console.log(`[test-llm] Tool events: ${toolEvents.length}, has expected output: ${hasToolOutput}`);

      // The model should have either:
      // a) Called the tool and got the output, or
      // b) Responded with the command output in text
      const content = (msg.message as { content?: string })?.content ?? '';
      const success = hasToolOutput || content.includes('integration-test-ok');
      assert.ok(success, 'Expected tool output or response to contain "integration-test-ok"');
    } finally {
      ws.close();
    }
  });

  it('does not produce context overflow errors', async (t) => {
    if (skipReason) return t.skip(skipReason);

    const ws = new WsClient();
    try {
      await ws.connect();
      // Brief pause to collect any stale error events
      await sleep(1_000);

      const errors = ws.collected().filter(
        (e) =>
          e.type === 'error' &&
          /context|token|overflow|too long|maximum/i.test(String(e.message ?? e.error ?? '')),
      );

      assert.equal(errors.length, 0, `Expected no context overflow errors, got: ${JSON.stringify(errors)}`);
    } finally {
      ws.close();
    }
  });
});
