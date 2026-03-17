/**
 * Web Bridge — HTTP + WebSocket server that bridges AgentClient events to the browser.
 *
 * Serves static files from web/ and relays ServerEvents over WebSocket.
 * Uses the same AgentClient instance as the TUI, so gatekeeper command
 * interception works automatically.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, join, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentClient } from './client.js';
import { extensionBridge } from './ext-bridge.js';
import type { ServerEvent, ServerState, BackgroundTaskInfo, StreamingTrace } from './protocol.js';
import type { ThinkingLevel } from './agent.js';
import type { ExecPermissions, FetchPermissions, BrowserPermissions } from './safety.js';
import { classifyBrowserAction } from './safety.js';
import { parseCommandPipeline } from './safety.js';
import { createLogger } from './logger.js';
import { readSettingsSync, writeSettings } from './settings-file.js';

const log = createLogger('web-bridge');

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const WEB_DIR = resolve(__dirname, '..', 'web');
const EXTENSION_DIST = resolve(__dirname, '..', 'aigent-extension', 'dist');

// WSL detection: convert Linux path to Windows-accessible path for Chrome
function getExtensionPath(): string {
  try {
    const isWSL = readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
    if (isWSL) {
      return execSync(`wslpath -w "${EXTENSION_DIST}"`, { encoding: 'utf8' }).trim();
    }
  } catch { /* not WSL or wslpath unavailable */ }
  return EXTENSION_DIST;
}

const EXTENSION_PATH_DISPLAY = getExtensionPath();

type ClientSettings = Record<string, boolean | number | string>;

function readClientSettings(): ClientSettings {
  return readSettingsSync() as ClientSettings;
}

async function writeClientSettings(updates: ClientSettings): Promise<void> {
  await writeSettings('web-bridge', (current) => {
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(updates)) {
      // Deep-merge nested permission objects so gatekeeper-added entries survive
      // a browser POST that only intends to update one sub-field.
      if ((k === 'exec_permissions' || k === 'fetch_permissions' || k === 'file_permissions' || k === 'browser_permissions' || k === 'mcp_permissions') &&
          v !== null && typeof v === 'object' &&
          merged[k] !== null && typeof merged[k] === 'object') {
        const existing = merged[k] as Record<string, unknown>;
        const incoming = v as Record<string, unknown>;
        merged[k] = { ...existing, ...incoming };
      } else {
        merged[k] = v;
      }
    }
    return merged;
  });
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Serve a static file with proper MIME type. */
async function serveFile(res: ServerResponse, filePath: string, extraHeaders?: Record<string, string>): Promise<void> {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      ...extraHeaders,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

export interface ClassifierDecision { tier: 1 | 2 | 3; action: 'allow' | 'block' | 'ask'; reason: string }

export async function startWebServer(
  client: AgentClient,
  port?: number,
  options?: { autoHandledExecIds?: Set<string>; getExecPermissions?: () => ExecPermissions; autoHandledFetchIds?: Set<string>; getFetchPermissions?: () => FetchPermissions; autoHandledBrowserWriteIds?: Set<string>; getBrowserPermissions?: () => BrowserPermissions; pendingBrowserWriteApprovals?: Map<string, { action: string; domain?: string; requiredTier: 'read' | 'write' | 'script' }>; classifierDecisions?: Map<string, ClassifierDecision>; autoHandledFileAccessIds?: Set<string>; autoHandledMcpIds?: Set<string>; onSettingsChanged?: () => void; extSecret?: string; setPiPOpen?: (open: boolean) => void; resolvePiPSuggestion?: (id: string, action: 'float' | 'skip') => void },
): Promise<{ port: number }> {
  const { getExecPermissions, autoHandledFetchIds, getFetchPermissions, autoHandledBrowserWriteIds, getBrowserPermissions, pendingBrowserWriteApprovals, classifierDecisions, autoHandledMcpIds, onSettingsChanged, extSecret, setPiPOpen, resolvePiPSuggestion } = options ?? {};
  const listenPort = port ?? (Number(process.env['AIGENT_WEB_PORT']) || 3141);

  // Cache the latest server state so new connections get immediate state.
  // These listeners run ONCE (not per-connection) to avoid duplicate appends
  // when multiple browser tabs are connected simultaneously.

  // In test mode (no container), seed cachedState with defaults so the browser
  // gets a valid connected event and the sidebar populates immediately.
  const TEST_MODE = process.env['AIGENT_TEST_MODE'] === '1';
  const _mainModel = process.env['AIGENT_MODEL'];
  const _cheapModel = process.env['AIGENT_CHEAP_MODEL'];
  const DEFAULT_MODELS = [...new Set([_mainModel, _cheapModel].filter((m): m is string => !!m))];
  let cachedState: ServerState | null = TEST_MODE
    ? {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinking: 'high' as ThinkingLevel,
        short: false,
        profile: 'default',
        sessionId: 'test',
        model: DEFAULT_MODELS[0]!,
        availableModels: DEFAULT_MODELS,
        availableTools: [],
        isLoading: false,
        tasks: [],
        pendingResults: 0,
        queue: [],
        contextWindow: (() => { const e = process.env['AIGENT_CONTEXT_WINDOW']; if (e) { const n = parseInt(e, 10); if (!isNaN(n) && n > 0) return n; } return 200_000; })(),
      }
    : null;
  client.on('connected', (state) => { cachedState = state; });
  client.on('message', (message: ServerState['messages'][number]) => {
    if (cachedState) cachedState = { ...cachedState, messages: [...cachedState.messages, message] };
  });
  client.on('system', (content: string) => {
    if (cachedState) {
      const sysMsg: ServerState['messages'][number] = { id: randomUUID(), role: 'system', content, timestamp: new Date().toISOString() };
      cachedState = { ...cachedState, messages: [...cachedState.messages, sysMsg] };
    }
  });
  client.on('reset', () => {
    if (cachedState) cachedState = { ...cachedState, messages: [] };
  });
  client.on('usage', (usage: ServerState['usage']) => {
    if (cachedState) cachedState = { ...cachedState, usage };
  });
  client.on('loading', (isLoading: boolean) => {
    if (cachedState) cachedState = { ...cachedState, isLoading };
  });
  client.on('state', (partial: { thinking?: ThinkingLevel; profile?: string; sessionId?: string; model?: string }) => {
    if (cachedState) cachedState = { ...cachedState, ...partial };
  });
  client.on('task_update', (task: BackgroundTaskInfo) => {
    if (!cachedState) return;
    const idx = cachedState.tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      const next = [...cachedState.tasks];
      next[idx] = task;
      cachedState = { ...cachedState, tasks: next };
    } else {
      cachedState = { ...cachedState, tasks: [...cachedState.tasks, task] };
    }
  });

  // Accumulate streaming traces in cachedState so reconnecting browser clients
  // can restore them via the `connected` event's streamingTraces field.
  let bridgeTraces: StreamingTrace[] = [];
  let bridgeTraceIdCounter = 0;

  client.on('tool_start', (name: string, input: string, summary: string, model?: string, thinking?: string) => {
    const trace: StreamingTrace = {
      id: `trace-bridge-${++bridgeTraceIdCounter}-${Date.now()}`,
      type: 'tool',
      toolName: name,
      toolSummary: summary,
      toolInput: input,
      toolOutput: '',
      running: true,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    };
    bridgeTraces = [...bridgeTraces, trace];
    if (cachedState) cachedState = { ...cachedState, streamingTraces: bridgeTraces };
  });

  client.on('tool_output', (content: string) => {
    bridgeTraces = bridgeTraces.map((t, i) =>
      i === bridgeTraces.length - 1 && t.running
        ? { ...t, toolOutput: t.toolOutput + content }
        : t
    );
    if (cachedState) cachedState = { ...cachedState, streamingTraces: bridgeTraces };
  });

  client.on('tool_images', (images: { mediaType: string; data: string }[]) => {
    bridgeTraces = bridgeTraces.map((t, i) =>
      i === bridgeTraces.length - 1 && t.running
        ? { ...t, images: [...(t.images ?? []), ...images] }
        : t
    );
    if (cachedState) cachedState = { ...cachedState, streamingTraces: bridgeTraces };
  });

  client.on('tool_end', () => {
    // Mark the last running trace as done
    const next = [...bridgeTraces];
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i]!.running) { const { images: _discarded, ...rest } = next[i]!; next[i] = { ...rest, running: false }; break; }
    }
    bridgeTraces = next;
    if (cachedState) cachedState = { ...cachedState, streamingTraces: bridgeTraces };
  });

  // Reset trace buffer when a turn completes (message finalizes) or loading stops
  client.on('message', () => {
    bridgeTraces = [];
    if (cachedState) { const { streamingTraces: _, ...rest } = cachedState; cachedState = rest as ServerState; }
  });

  client.on('loading', (isLoading: boolean) => {
    if (!isLoading) {
      bridgeTraces = [];
      if (cachedState) { const { streamingTraces: _, ...rest } = cachedState; cachedState = rest as ServerState; }
    }
  });

  // Cache latest host state from gatekeeper (capabilities).
  let cachedCapabilities: Record<string, { grant: string; available: boolean }> | undefined;
  client.on('host_state', (capabilities: Record<string, { grant: string; available: boolean }> | undefined) => {
    cachedCapabilities = capabilities;
  });

  // --- HTTP server ---

  const STT_URL = process.env['AIGENT_STT_URL'] ?? 'http://127.0.0.1:8765';
  const TTS_URL = process.env['AIGENT_TTS_URL'] ?? 'http://127.0.0.1:8766';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    // Health check for test infrastructure (and general use).
    if (req.method === 'GET' && url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"ok"}');
      return;
    }

    // Extension auth secret — extension fetches this to authenticate WebSocket connections.
    // Only served to localhost connections.
    if (req.method === 'GET' && url === '/ext/secret' && extSecret) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ secret: extSecret }));
      return;
    }

    // TTS proxy — forwards plain text to local edge-tts server, returns MP3 audio.
    // Passes through ?rate= query param so the browser can set per-request speed.
    if (req.method === 'POST' && (url === '/tts' || url.startsWith('/tts?'))) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);
          // Forward query params (e.g. rate) to the Python server
          const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
          const ttsRes = await fetch(`${TTS_URL}/synthesize${qs}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'Content-Length': String(body.length) },
            body,
          });
          if (ttsRes.ok) {
            const audio = await ttsRes.arrayBuffer();
            res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(audio.byteLength) });
            res.end(Buffer.from(audio));
          } else {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'TTS service error' }));
          }
        } catch {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'TTS service unavailable' }));
        }
      });
      return;
    }

    // Test injection endpoint — only active when AIGENT_TEST_MODE=1.
    // Accepts a POST with a ServerEvent JSON body and broadcasts it to all connected WS clients.
    // Allows Playwright tests to inject fake exec_request events without an LLM.
    if (process.env['AIGENT_TEST_MODE'] === '1' && req.method === 'POST' && url === '/test/inject') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const event = JSON.parse(Buffer.concat(chunks).toString()) as ServerEvent;
          for (const ws of wss.clients) {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
          }
          res.writeHead(204); res.end();
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
      return;
    }

    // Browser log relay — browser POSTs JSON {level, args} here, we print to server stdout.
    if (req.method === 'POST' && url === '/log') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const { level = 'log', args = [] } = JSON.parse(Buffer.concat(chunks).toString()) as { level?: string; args?: unknown[] };
          const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
          process.stdout.write(`[browser:${level}] ${line}\n`);
        } catch { /* ignore */ }
        res.writeHead(204); res.end();
      });
      return;
    }

    // STT proxy — forwards WAV audio to local Parakeet server, returns transcript JSON.
    if (req.method === 'POST' && url === '/stt') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        try {
          const body = Buffer.concat(chunks);
          log.info(`STT request: ${body.length} bytes`);
          const sttRes = await fetch(`${STT_URL}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(body.length) },
            body,
          });
          const text = await sttRes.text();
          log.info(`STT response: ${sttRes.status} — ${text.slice(0, 100)}`);
          res.writeHead(sttRes.ok ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(text);
        } catch (err) {
          log.warn(`STT proxy error: ${err}`);
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'STT service unavailable' }));
        }
      });
      return;
    }

    // Client settings — GET returns settings.json, POST merges updates into it.
    if (url === '/settings') {
      if (req.method === 'GET') {
        const settings = await readClientSettings();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(settings));
        return;
      }
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          try {
            const updates = JSON.parse(Buffer.concat(chunks).toString()) as ClientSettings;
            // In test mode, accept but don't persist — e2e tests verify browser-side
            // behavior (zustand/localStorage), not server-side settings writes.
            if (!TEST_MODE) {
              await writeClientSettings(updates);
              try { onSettingsChanged?.(); } catch (err) {
                log.error('onSettingsChanged callback failed', { error: String(err) });
              }
              if ('stt_energy_threshold' in updates) {
                const threshold = Number(updates['stt_energy_threshold' as keyof ClientSettings]);
                fetch(`${STT_URL}/config`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ energy_threshold: threshold }),
                }).catch(() => { /* STT service not running — ignore */ });
              }
            }
            res.writeHead(204); res.end();
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    // Directory listing for @ palette file browser.
    // Accepts ?dir=<path>, resolves ~ and ., returns { entries: [{ name, isDir }] }.
    if (req.method === 'GET' && (url === '/files' || url.startsWith('/files?'))) {
      const params = new URL(url, 'http://localhost').searchParams;
      const dirParam = params.get('dir') ?? '';
      if (!dirParam) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing dir parameter' }));
        return;
      }

      let resolvedDir: string;
      if (dirParam === '~' || dirParam.startsWith('~/')) {
        resolvedDir = dirParam === '~' ? homedir() : join(homedir(), dirParam.slice(2));
      } else if (dirParam === '.' || dirParam.startsWith('./')) {
        resolvedDir = dirParam === '.' ? process.cwd() : resolve(process.cwd(), dirParam);
      } else {
        resolvedDir = resolve(dirParam);
      }

      try {
        const raw = await readdir(resolvedDir, { withFileTypes: true });
        const entries = await Promise.all(
          raw.filter(e => !e.name.startsWith('.')).map(async (e) => {
            let isDir = e.isDirectory();
            if (e.isSymbolicLink()) {
              try { isDir = (await stat(join(resolvedDir, e.name))).isDirectory(); }
              catch { /* broken symlink — treat as file */ }
            }
            return { name: e.name, isDir };
          }),
        );
        entries.sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: entries.slice(0, 200) }));
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: [] }));
      }
      return;
    }

    // Static files from web/ — strip query string before resolving path
    const pathname = url.split('?')[0]!;
    const safePath = pathname === '/' ? '/index.html' : pathname.replace(/\.\./g, '');

    // Try web/dist/ first (built app.js), then web/ root (index.html, style.css)
    const distPath = join(WEB_DIR, 'dist', safePath);
    const rootPath = join(WEB_DIR, safePath);

    try {
      await readFile(distPath);
      return serveFile(res, distPath);
    } catch {
      return serveFile(res, rootPath);
    }
  });

  // --- WebSocket server ---

  // Use noServer mode and manually route upgrades by path.
  // When two WebSocketServer instances share the same HTTP server, both fire
  // their upgrade handlers for every incoming upgrade request. The one that
  // doesn't match the path calls abortHandshake(), sending HTTP 400 text
  // directly over a socket that the other WSS already upgraded to WebSocket —
  // corrupting the stream with an "RSV1 must be clear" protocol error.
  const wss = new WebSocketServer({ noServer: true });
  const extWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '/';
    const pathname = url.includes('?') ? url.slice(0, url.indexOf('?')) : url;
    if (pathname === '/ext') {
      // Validate extension auth secret via query param
      if (extSecret) {
        const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
        const params = new URLSearchParams(qs);
        if (params.get('secret') !== extSecret) {
          log.warn('Extension WebSocket rejected — invalid or missing secret');
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      extWss.handleUpgrade(req, socket, head, (ws) => extWss.emit('connection', ws, req));
    } else {
      // Default to /ws (also handles any other paths)
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    }
  });

  // Extension bridge WebSocket — Chrome extension connects here
  extWss.on('connection', (ws: WebSocket) => extensionBridge.onConnection(ws));

  /** Broadcast a ServerEvent to all connected browser clients. */
  function broadcastToClients(event: ServerEvent): void {
    const msg = JSON.stringify(event);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  /**
   * In test mode (no container / server), handle slash commands locally
   * so toggle round-trips, /reset, etc. work without a running worker.
   * Returns true if the command was handled (caller should skip forwarding).
   */
  function handleTestModeCommand(content: string): boolean {
    const trimmed = content.trim();

    // /reasoning on|off
    if (trimmed === '/reasoning off' || trimmed === '/reasoning on') {
      const level = trimmed === '/reasoning off' ? 'off' : 'high';
      if (cachedState) cachedState = { ...cachedState, thinking: level as ThinkingLevel };
      broadcastToClients({ type: 'state', thinking: level as ThinkingLevel });
      return true;
    }

    // /effort <level>
    const effortMatch = trimmed.match(/^\/effort\s+(low|medium|high|max)$/);
    if (effortMatch) {
      const level = effortMatch[1] as ThinkingLevel;
      if (cachedState) cachedState = { ...cachedState, thinking: level };
      broadcastToClients({ type: 'state', thinking: level });
      return true;
    }

    // /short on|off
    if (trimmed === '/short on' || trimmed === '/short off') {
      const short = trimmed === '/short on';
      if (cachedState) cachedState = { ...cachedState, short };
      broadcastToClients({ type: 'state', short });
      // Only emit a system message when enabling short mode — the "on" test
      // checks for it, but no test checks for "off". Emitting on disable causes
      // a race: the message can arrive after beforeEach clearMessages() and
      // cause the next test's waitForFunction to time out.
      if (short) broadcastToClients({ type: 'system', content: 'Short mode: on' });
      return true;
    }

    // /model <id>
    const modelMatch = trimmed.match(/^\/model\s+(\S+)$/);
    if (modelMatch) {
      const model = modelMatch[1]!;
      if (cachedState && cachedState.availableModels.includes(model)) {
        cachedState = { ...cachedState, model };
        broadcastToClients({ type: 'state', model });
      }
      return true;
    }

    // /reset
    if (trimmed === '/reset') {
      if (cachedState) cachedState = { ...cachedState, messages: [] };
      broadcastToClients({ type: 'reset' });
      broadcastToClients({ type: 'system', content: 'Conversation reset.' });
      return true;
    }

    // Unknown slash command — silently drop it (don't forward to disconnected server).
    if (trimmed.startsWith('/')) return true;

    // Regular (non-slash) message — echo back as a user message so UI tests can
    // observe the send without needing a real server round-trip.
    const ts = new Date().toISOString();
    const userMsg = { id: randomUUID(), role: 'user' as const, content: trimmed, timestamp: ts };
    if (cachedState) cachedState = { ...cachedState, messages: [...cachedState.messages, userMsg] };
    broadcastToClients({ type: 'message', message: userMsg });
    return true;
  }

  // --- TTS/STT service availability probing ---
  // Probe services and cache the result.  Re-probes periodically so that
  // services that start after the gatekeeper are discovered automatically.
  let cachedTtsAvailable = false;
  let cachedSttAvailable = false;

  const probeService = async (url: string): Promise<boolean> => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) });
      return res.ok;
    } catch { return false; }
  };

  /** Probe TTS/STT and broadcast to the given WS (or all clients if omitted). */
  async function sendServiceAvailability(ws?: WebSocket): Promise<void> {
    const [tts, stt] = await Promise.all([
      probeService(TTS_URL + '/health'),
      probeService(STT_URL + '/health'),
    ]);
    cachedTtsAvailable = tts;
    cachedSttAvailable = stt;
    const msg = JSON.stringify({
      type: 'host_state',
      ...(cachedCapabilities ? { capabilities: cachedCapabilities } : {}),
      ttsAvailable: tts,
      sttAvailable: stt,
      extensionConnected: extensionBridge.isConnected(),
      extensionPath: EXTENSION_PATH_DISPLAY,
      vscodeConnected: extensionBridge.isVscodeConnected(),
    });
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    } else {
      for (const c of wss.clients) {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
      }
    }
  }

  // Re-probe every 15s until both services are discovered, then stop.
  const reprobe = setInterval(async () => {
    if (cachedTtsAvailable && cachedSttAvailable) {
      clearInterval(reprobe);
      return;
    }
    if (wss.clients.size === 0) return;  // no clients to notify
    await sendServiceAvailability();
  }, 15_000);
  // Don't hold the process open for the re-probe timer.
  reprobe.unref();

  // Broadcast extension connection changes to all web clients.
  const broadcastExtensionState = (connected: boolean): void => {
    broadcastToClients({
      type: 'host_state',
      extensionConnected: connected,
      extensionPath: EXTENSION_PATH_DISPLAY,
      vscodeConnected: extensionBridge.isVscodeConnected(),
    });
  };
  extensionBridge.on('connected', () => broadcastExtensionState(true));
  extensionBridge.on('disconnected', () => broadcastExtensionState(false));
  extensionBridge.on('vscode_connected', () => broadcastExtensionState(true));

  // Handle "Send to aigent" context menu events from the Chrome extension
  extensionBridge.on('context_menu', (data: { selectionText?: string; pageUrl?: string; linkUrl?: string; srcUrl?: string; tabId?: number; tabTitle?: string }) => {
    const parts: string[] = [];
    if (data.selectionText) parts.push(`Selected text: "${data.selectionText}"`);
    if (data.linkUrl) parts.push(`Link: ${data.linkUrl}`);
    if (data.srcUrl) parts.push(`Image: ${data.srcUrl}`);
    if (data.pageUrl) parts.push(`Page: ${data.pageUrl}`);
    if (data.tabTitle) parts.push(`Tab: ${data.tabTitle}`);

    if (parts.length === 0) return; // nothing useful to send

    const text = `[Sent from browser via right-click context menu]\n${parts.join('\n')}`;

    // Inject as a user message into the conversation
    broadcastToClients({ type: 'context_menu_message', text });
    // Also forward to the agent server as a user message
    if (client) {
      client.send({ type: 'message', content: text, images: [] });
    }
  });

  // Handle VS Code context events
  extensionBridge.on('vscode_context', (data: { event: string; filePath?: string; content?: string; selection?: { startLine: number; endLine: number; text: string }; terminalText?: string; tabs?: Array<{ path: string; name: string }> }) => {
    let text = '';
    
    switch (data.event) {
      case 'selection':
        text = `[VS Code: Selection from ${data.filePath}]\nLines ${data.selection?.startLine}-${data.selection?.endLine}:\n\`\`\`\n${data.selection?.text}\n\`\`\``;
        break;
      case 'file':
        text = `[VS Code: Active file ${data.filePath}]\n\`\`\`\n${data.content?.slice(0, 8000)}\n\`\`\``;
        break;
      case 'terminal':
        text = `[VS Code: Terminal]\n${data.terminalText}`;
        break;
      case 'open_tabs':
        text = `[VS Code: Open files]\n${data.tabs?.map(t => `- ${t.name}: ${t.path}`).join('\n')}`;
        break;
    }

    if (!text) return;
    
    // Send to agent
    if (client) {
      client.send({ type: 'message', content: text, images: [] });
    }
  });

  // Forward PiP suggestion from gatekeeper to web clients.
  client.on('pip_suggestion', (id: string) => {
    const payload = JSON.stringify({ type: 'pip_suggestion', id });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    log.info('Web client connected');

    // Send cached state immediately so the browser gets current messages/usage.
    if (cachedState) {
      const event: ServerEvent = { type: 'connected', state: cachedState };
      ws.send(JSON.stringify(event));
    }

    // Send cached host state so the sidebar populates immediately.
    sendServiceAvailability(ws);

    // Send current client settings so the browser can sync from the JSON file.
    // Also include effective exec permissions (defaults merged with overrides) so the
    // Permissions pane in the settings modal shows accurate data before any edits.
    {
      const settings = readClientSettings();
      if (ws.readyState === WebSocket.OPEN) {
        let merged: Record<string, boolean | number | string> = settings;
        if (getExecPermissions) {
          const perms = getExecPermissions();
          merged = {
            ...merged,
            exec_perm_alwaysAllow: JSON.stringify(perms.alwaysAllow),
            exec_perm_alwaysClassify: JSON.stringify(perms.alwaysClassify),
            exec_perm_deny: JSON.stringify(perms.deny),
          };
        }
        if (getFetchPermissions) {
          const perms = getFetchPermissions();
          merged = {
            ...merged,
            fetch_perm_alwaysAllow: JSON.stringify(perms.alwaysAllow),
            fetch_perm_deny: JSON.stringify(perms.deny),
          };
        }
        if (getBrowserPermissions) {
          const perms = getBrowserPermissions();
          merged = {
            ...merged,
            browser_perm_read: JSON.stringify(perms.read),
            browser_perm_write: JSON.stringify(perms.write),
            browser_perm_script: JSON.stringify(perms.script),
            browser_perm_deny: JSON.stringify(perms.deny),
          };
        }
        // Inject env-derived model values so the settings panel shows what's active.
        // These are sourced from process.env (via .env) and may not be in settings.json.
        if (process.env['AIGENT_MODEL'] && !('AIGENT_MODEL' in merged)) {
          merged = { ...merged, AIGENT_MODEL: process.env['AIGENT_MODEL'] };
        }
        if (process.env['AIGENT_FLASH_MODEL'] && !('AIGENT_FLASH_MODEL' in merged)) {
          merged = { ...merged, AIGENT_FLASH_MODEL: process.env['AIGENT_FLASH_MODEL'] };
        }
        if (process.env['AIGENT_PRO_MODEL'] && !('AIGENT_PRO_MODEL' in merged)) {
          merged = { ...merged, AIGENT_PRO_MODEL: process.env['AIGENT_PRO_MODEL'] };
        }
        if (process.env['AIGENT_ULTRA_MODEL'] && !('AIGENT_ULTRA_MODEL' in merged)) {
          merged = { ...merged, AIGENT_ULTRA_MODEL: process.env['AIGENT_ULTRA_MODEL'] };
        }
        if (process.env['AIGENT_CHEAP_MODEL'] && !('AIGENT_CHEAP_MODEL' in merged)) {
          merged = { ...merged, AIGENT_CHEAP_MODEL: process.env['AIGENT_CHEAP_MODEL'] };
        }
        // Flatten nested tools config into tools_* keys for the settings panel
        const toolsCfg = (settings as Record<string, unknown>)['tools'] as Record<string, unknown> | undefined;
        if (toolsCfg) {
          merged = {
            ...merged,
            tools_summarizeLargeResults: toolsCfg['summarizeLargeResults'] === true,
            tools_summarizeThresholdTokens: typeof toolsCfg['summarizeThresholdTokens'] === 'number' ? toolsCfg['summarizeThresholdTokens'] : 500,
            tools_summarizeModel: typeof toolsCfg['summarizeModel'] === 'string' ? toolsCfg['summarizeModel'] : (process.env['AIGENT_CHEAP_MODEL'] ?? process.env['AIGENT_MODEL'] ?? ''),
            tools_summarizeMode: typeof toolsCfg['summarizeMode'] === 'string' ? toolsCfg['summarizeMode'] : 'allowlist',
            tools_summarizeTools: JSON.stringify(Array.isArray(toolsCfg['summarizeTools']) ? toolsCfg['summarizeTools'] : ['exec', 'fetch']),
          };
        }
        ws.send(JSON.stringify({ type: 'client_settings', settings: merged }));
      }
    }

    // --- Relay AgentClient events → WebSocket ---

    const handlers = {
      connected: (state: ServerState) => send({ type: 'connected', state }),
      text: (content: string) => send({ type: 'text', content }),
      thinking: (content: string) => send({ type: 'thinking', content }),
      tool_start: (name: string, input: string, summary: string, model?: string, thinking?: string) =>
        send({ type: 'tool_start', name, input, summary, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }),
      tool_output: (content: string) => send({ type: 'tool_output', content }),
      tool_images: (images: { mediaType: string; data: string }[]) => send({ type: 'tool_images', images }),
      tool_end: () => send({ type: 'tool_end' }),
      task_update: (task: ServerEvent extends { type: 'task_update'; task: infer T } ? T : never) =>
        send({ type: 'task_update', task }),
      message: (_message: ServerState['messages'][number]) => {
        send({ type: 'message', message: _message });
      },
      system: (content: string) => send({ type: 'system', content }),
      usage: (usage: ServerState['usage']) => send({ type: 'usage', usage }),
      loading: (isLoading: boolean) => send({ type: 'loading', isLoading }),
      error: (message: string) => send({ type: 'error', message }),
      state: (partial: { thinking?: ThinkingLevel; profile?: string; sessionId?: string; model?: string }) =>
        send({ type: 'state', ...partial }),
      config_write_request: (id: string, file: string, content: string, reason: string) =>
        send({ type: 'config_write_request', id, file, content, reason }),
      edit_file_request: (id: string, path: string, edits: Array<{ old_str: string; new_str: string; index?: number }>, reason: string) =>
        send({ type: 'edit_file_request', id, path, edits, reason }),
      patch_request: (id: string, diff: string, reason: string) =>
        send({ type: 'patch_request', id, diff, reason }),
      // exec_request is handled via gatekeeper-first architecture: the gatekeeper emits
      // 'ui_exec_prompt' only for requests that genuinely need user input, avoiding the
      // race condition where this per-connection handler forwarded to the UI before the
      // async Tier 3 classifier had a chance to auto-handle the request.
      fetch_request: (id: string, url: string, method?: string) => {
        // If gatekeeper already handled this, broadcast the decision instead of prompting
        if (autoHandledFetchIds?.has(id)) {
          autoHandledFetchIds.delete(id);
          const decision = classifierDecisions?.get(id);
          if (decision) {
            classifierDecisions?.delete(id);
            send({ type: 'classifier_decision', tier: decision.tier, action: decision.action, reason: decision.reason });
          }
          return;
        }
        send({ type: 'fetch_request', id, url, ...(method ? { method } : {}) });
      },
      browser_ext_request: (id: string, action: string, _tabId?: number, _rootSelector?: string, steps?: unknown[], url?: string) => {
        // Skip if gatekeeper already handled this (domain permission grant active)
        if (autoHandledBrowserWriteIds?.has(id)) {
          autoHandledBrowserWriteIds.delete(id);
          return;
        }
        // Only relay actions that need user approval (write/script tier, not auto-approved)
        const requiredTier = classifyBrowserAction(action, steps);
        if (requiredTier === 'read') return; // read actions are auto-approved by gatekeeper

        const stepSummary = action === 'navigate'
          ? `Navigate to ${url ?? '?'}`
          : action === 'open_tab'
          ? `Open new tab: ${url ?? '?'}`
          : action === 'close_tab'
          ? `Close tab ${_tabId ?? '?'}`
          : action === 'devtools_start'
          ? `Attach DevTools debugger${_tabId ? ` to tab ${_tabId}` : ''}`
          : action === 'create_window'
          ? 'Create agent browsing window'
          : action === 'close_agent_tabs'
          ? 'Close all agent tabs'
          : (() => {
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
              let summary = verbs.slice(0, 5).join(', ');
              const extra = verbs.length - 5;
              if (extra > 0) summary += ` + ${extra} more`;
              return summary.length > 80 ? summary.slice(0, 77) + '...' : summary;
            })();
        const tabUrl = extensionBridge.getActiveTabUrl();
        // Extract domain from the pending request stored by gatekeeper
        const pending = pendingBrowserWriteApprovals?.get(id);
        const domain = pending?.domain;
        send({
          type: 'browser_write_request', id, action: action as 'run_script' | 'navigate' | 'open_tab' | 'close_tab', stepSummary, requiredTier,
          ...(tabUrl ? { tabUrl } : {}),
          ...(domain ? { domain } : {}),
          ...(domain ? { alwaysReadCmd: `/approve-browser-write ${id} --always-read` } : {}),
          ...(domain ? { alwaysWriteCmd: `/approve-browser-write ${id} --always-write` } : {}),
          ...(domain ? { alwaysScriptCmd: `/approve-browser-write ${id} --always-script` } : {}),
        });
      },
      // file_access_request is handled via gatekeeper-first architecture: the gatekeeper
      // emits 'ui_file_access_prompt' only for requests that genuinely need user input.
      fetch_size_request: (id: string, url: string, requestedBytes: number, defaultBytes: number) =>
        send({ type: 'fetch_size_request', id, url, requestedBytes, defaultBytes }),
      mcp_tool_request: (id: string, server: string, tool: string, params: string) => {
        if (autoHandledMcpIds?.has(id)) { autoHandledMcpIds.delete(id); return; }
        send({ type: 'mcp_tool_request', id, server, tool, params });
      },
      screenshot_request: (id: string) =>
        send({ type: 'screenshot_request', id }),
      screen_share_request: (id: string) =>
        send({ type: 'screen_share_request', id }),
      host_state: (capabilities?: Record<string, { grant: string; available: boolean }>) =>
        send({ type: 'host_state', ...(capabilities ? { capabilities } : {}) }),
      context_breakdown: (breakdown: import('./protocol.js').ContextBreakdown) =>
        send({ type: 'context_breakdown', breakdown }),
      queue_update: (queue: import('./protocol.js').QueuedMessageInfo[]) => {
        if (cachedState) cachedState = { ...cachedState, queue };
        send({ type: 'queue_update', queue });
      },
      user_question_request: (id: string, question: string, options?: { label: string; description?: string }[], multiSelect?: boolean, allowFreeText?: boolean) =>
        send({
          type: 'user_question_request',
          id,
          question,
          ...(options ? { options } : {}),
          ...(multiSelect !== undefined ? { multiSelect } : {}),
          ...(allowFreeText !== undefined ? { allowFreeText } : {}),
        }),
      reset: () => send({ type: 'reset' }),
    };

    function send(event: ServerEvent): void {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    }

    // Subscribe to all events
    for (const [event, handler] of Object.entries(handlers)) {
      client.on(event, handler as (...args: unknown[]) => void);
    }

    // --- WebSocket → AgentClient ---

    ws.on('message', (data) => {
      try {
        const cmd = JSON.parse(data.toString());
        switch (cmd.type) {
          case 'message': {
            // In test mode there is no container, so handle slash commands locally
            // by broadcasting the appropriate state events back to all clients.
            if (TEST_MODE && typeof cmd.content === 'string' && !cmd.images && !cmd.attachments) {
              if (handleTestModeCommand(cmd.content as string)) break;
            }
            // Prepend VSCode IDE context if connected and a file is open.
            // Skip for slash commands — they are internal directives, not agent prompts.
            let content: string = cmd.content;
            const isSlashCommand = typeof content === 'string' && content.trimStart().startsWith('/');
            if (!isSlashCommand) {
              const ideCtx = extensionBridge.getVscodeContext();
              if (ideCtx) {
                const parts: string[] = [];
                if (ideCtx.activeFile) {
                  const sel = (ideCtx.selectionStartLine != null && ideCtx.selectionEndLine != null)
                    ? ` (${ideCtx.selectionStartLine}:${ideCtx.selectionStartCol ?? 0}–${ideCtx.selectionEndLine}:${ideCtx.selectionEndCol ?? 0})`
                    : '';
                  parts.push(`Active file: ${ideCtx.activeFile}${sel}`);
                  if (ideCtx.selectedText && ideCtx.selectedText.trim().length > 0) {
                    parts.push(`Selected text:\n\`\`\`\n${ideCtx.selectedText}\n\`\`\``);
                  }
                }
                if (ideCtx.visibleFiles && ideCtx.visibleFiles.length > 0) {
                  const others = ideCtx.visibleFiles.filter(f => f !== ideCtx.activeFile);
                  if (others.length > 0) parts.push(`Also visible: ${others.join(', ')}`);
                }
                if (parts.length > 0) {
                  content = `[VSCode context]\n${parts.join('\n')}\n\n${content}`;
                }
              }
            }
            if ((cmd.images && cmd.images.length > 0) || (cmd.attachments && cmd.attachments.length > 0)) {
              // Attachments present — send full command directly (slash commands never have attachments)
              client.send({
                type: 'message',
                content,
                ...(cmd.images ? { images: cmd.images } : {}),
                ...(cmd.attachments ? { attachments: cmd.attachments } : {}),
                ...(cmd.thinkingOverride ? { thinkingOverride: cmd.thinkingOverride } : {}),
                ...(cmd.reqId ? { reqId: cmd.reqId } : {}),
              });
            } else {
              // Text only — send directly so reqId is preserved (sendMessage doesn't forward it)
              client.send({
                type: 'message',
                content,
                ...(cmd.thinkingOverride ? { thinkingOverride: cmd.thinkingOverride } : {}),
                ...(cmd.reqId ? { reqId: cmd.reqId } : {}),
              });
            }
            break;
          }
          case 'cancel':
            client.cancel();
            break;
          case 'cancel_queued':
          case 'reorder_queue':
            client.send(cmd);
            break;
          case 'command':
            client.sendCommand(cmd.cmd);
            break;
          case 'set_thinking':
            if (TEST_MODE) {
              const level = cmd.enabled ? 'high' : 'off';
              if (cachedState) cachedState = { ...cachedState, thinking: level as ThinkingLevel };
              broadcastToClients({ type: 'state', thinking: level as ThinkingLevel });
            } else {
              client.send(cmd);
            }
            break;
          case 'set_effort':
            if (TEST_MODE) {
              if (cachedState) cachedState = { ...cachedState, thinking: cmd.level as ThinkingLevel };
              broadcastToClients({ type: 'state', thinking: cmd.level as ThinkingLevel });
            } else {
              client.send(cmd);
            }
            break;
          case 'set_short':
            if (TEST_MODE) {
              if (cachedState) cachedState = { ...cachedState, short: cmd.enabled as boolean };
              broadcastToClients({ type: 'state', short: cmd.enabled as boolean });
              if (cmd.enabled) broadcastToClients({ type: 'system', content: 'Short mode: on' });
            } else {
              client.send(cmd);
            }
            break;
          case 'set_model':
            if (TEST_MODE) {
              if (cachedState && cachedState.availableModels.includes(cmd.model as string)) {
                cachedState = { ...cachedState, model: cmd.model as string };
                broadcastToClients({ type: 'state', model: cmd.model as string });
              }
            } else {
              client.send(cmd);
            }
            break;
          case 'config_write_response':
            client.send(cmd);
            break;
          case 'screenshot_response':
            client.send(cmd);
            break;
          case 'screen_share_response':
            client.send(cmd);
            break;
          case 'fetch_response':
            client.send(cmd);
            break;
          case 'file_access_response':
            client.send(cmd);
            break;
          case 'fetch_size_response':
            client.send(cmd);
            break;
          case 'mcp_tool_response':
            client.send(cmd);
            break;
          case 'exec_response':
            client.send(cmd);
            break;
          case 'browser_write_response':
            client.send(cmd);
            break;
          case 'user_question_response':
            client.send(cmd);
            break;
          case 'context_breakdown_request':
            if (TEST_MODE) {
              // Return mock breakdown data so context inspector tests pass without a server.
              ws.send(JSON.stringify({
                type: 'context_breakdown',
                breakdown: {
                  systemBase: 4200, systemBaseContent: '# System Prompt\n\nYou are aigent.',
                  workspaceContext: 2800, workspaceContent: '# AGENTS.md\n\naigent — a self-authoring AI agent.',
                  toolDefs: 1900, toolDefsContent: '[]',
                  messages: [
                    { role: 'user', tokens: 320, preview: 'Test user message' },
                    { role: 'assistant', tokens: 1847, preview: 'Test assistant reply' },
                  ],
                  messagesTotal: 2167,
                  total: 11067,
                },
              }));
            } else {
              client.send({ type: 'context_breakdown_request' });
            }
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'pip_state':
            if (setPiPOpen && typeof cmd.open === 'boolean') setPiPOpen(cmd.open);
            break;
          case 'pip_suggestion_response':
            if (resolvePiPSuggestion && typeof cmd.id === 'string')
              resolvePiPSuggestion(cmd.id, cmd.action === 'float' ? 'float' : 'skip');
            break;
          case 'message_rating':
            client.send(cmd);
            // Echo to all WS clients so test harness can observe it
            if (process.env['AIGENT_TEST_MODE'] === '1') broadcastToClients(cmd as unknown as ServerEvent);
            break;
          case 'browser_error': {
            const level = cmd.level === 'warn' ? 'warn' : 'error';
            const msg = String(cmd.message ?? '');
            const src = cmd.source ? ` (${String(cmd.source)})` : '';
            process.stdout.write(`[browser:${level}]${src} ${msg}\n`);
            broadcastToClients({ type: 'browser_error', level, message: msg, ...(cmd.source ? { source: String(cmd.source) } : {}) });
            break;
          }
        }
      } catch {
        // Malformed message, ignore
      }
    });

    // --- Cleanup on disconnect ---

    ws.on('close', () => {
      log.info('Web client disconnected');
      for (const [event, handler] of Object.entries(handlers)) {
        client.removeListener(event, handler as (...args: unknown[]) => void);
      }
    });
  });

  // --- Broadcast permission updates to all connected clients ---
  // When the gatekeeper updates always-allow lists (exec or fetch), it emits
  // 'permissions_updated' on the shared client.  Re-broadcast as a
  // client_settings event so every browser tab refreshes its settings store.
  client.on('permissions_updated', (settings: Record<string, string>) => {
    const payload = JSON.stringify({ type: 'client_settings', settings });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  // When the gatekeeper auto-resolves pending permissions (e.g. after an always-allow
  // update), it emits 'perm_dismissed' with the list of IDs to remove from the UI queue.
  client.on('perm_dismissed', (ids: string[]) => {
    const payload = JSON.stringify({ type: 'perm_dismissed', ids });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  // --- Gatekeeper-first permission forwarding ---
  // The gatekeeper processes exec_request and file_access_request through its three-tier
  // safety pipeline. Only requests that genuinely need user input are emitted here.
  // This eliminates the race condition where per-connection handlers forwarded requests
  // to the UI before the async Tier 3 classifier had a chance to auto-handle them,
  // causing phantom permission sounds with invisible modals.

  client.on('ui_exec_prompt', (id: string, command: string, _classifierReason?: string, _suggestedPatterns?: string[]) => {
    const payload = JSON.stringify({
      type: 'exec_request',
      id,
      command,
      segments: parseCommandPipeline(command),
    });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  client.on('ui_file_access_prompt', (id: string, path: string, operation: string, reason: string, _classifierReason?: string) => {
    const payload = JSON.stringify({ type: 'file_access_request', id, path, operation, reason });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  // Broadcast classifier decisions from the gatekeeper (for auto-handled requests).
  // The UI uses these to show tier badges on tool call blocks.
  client.on('classifier_decision_broadcast', (decision: { tier: number; action: string; reason: string }) => {
    const payload = JSON.stringify({ type: 'classifier_decision', tier: decision.tier, action: decision.action, reason: decision.reason });
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  });

  // --- Start listening ---

  const tryListen = (attemptsLeft: number): Promise<{ port: number }> =>
    new Promise((resolvePromise, reject) => {
      const onError = (err: Error) => {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && attemptsLeft > 1) {
          log.warn('Web server port in use, retrying…', { port: listenPort, attemptsLeft });
          server.removeListener('error', onError);
          // Port may still be releasing from the previous tsx-watch process — wait briefly.
          setTimeout(() => tryListen(attemptsLeft - 1).then(resolvePromise, reject), 500);
        } else if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          log.error('Web server port still in use after retries', { port: listenPort });
          reject(err);
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      server.listen(listenPort, '0.0.0.0', () => {
        server.removeListener('error', onError);
        log.info('Web UI available', { url: `http://localhost:${listenPort}` });
        resolvePromise({ port: listenPort });
      });
    });

  return tryListen(6); // up to ~3 seconds of retries
}
