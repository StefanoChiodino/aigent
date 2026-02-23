/**
 * Web Bridge — HTTP + WebSocket server that bridges AgentClient events to the browser.
 *
 * Serves static files from web/ and relays ServerEvents over WebSocket.
 * Uses the same AgentClient instance as the TUI, so gatekeeper command
 * interception works automatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { glob } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentClient } from './client.js';
import type { ServerEvent, ServerState } from './protocol.js';
import type { ThinkingLevel } from './agent.js';
import type { ExecPermissions, FetchPermissions } from './safety.js';
import { parseCommandPipeline } from './safety.js';
import { createLogger } from './logger.js';

const log = createLogger('web-bridge');

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const WEB_DIR = resolve(__dirname, '..', 'web');
const SETTINGS_PATH = resolve(__dirname, '..', 'settings.json');

type ClientSettings = Record<string, boolean | number | string>;

async function readClientSettings(): Promise<ClientSettings> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    const raw = await readFile(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw) as ClientSettings;
  } catch { return {}; }
}

async function writeClientSettings(updates: ClientSettings): Promise<void> {
  const current = await readClientSettings();
  const merged = { ...current, ...updates };
  await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}
const MARKED_ESM = resolve(__dirname, '..', 'node_modules', 'marked', 'lib', 'marked.esm.js');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Serve a static file with proper MIME type. */
async function serveFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

export async function startWebServer(
  client: AgentClient,
  port?: number,
  options?: { autoHandledExecIds?: Set<string>; getExecPermissions?: () => ExecPermissions; autoHandledFetchIds?: Set<string>; getFetchPermissions?: () => FetchPermissions },
): Promise<{ port: number }> {
  const { autoHandledExecIds, getExecPermissions, autoHandledFetchIds, getFetchPermissions } = options ?? {};
  const listenPort = port ?? (Number(process.env['AIGENT_WEB_PORT']) || 3141);

  // Cache the latest server state so new connections get immediate state.
  let cachedState: ServerState | null = null;
  client.on('connected', (state) => { cachedState = state; });

  // Cache latest host state from gatekeeper (mounts + capabilities).
  let cachedMounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[] = [];
  let cachedCapabilities: Record<string, string> | undefined;
  client.on('host_state', (mounts, capabilities) => {
    cachedMounts = mounts;
    cachedCapabilities = capabilities;
  });

  // --- HTTP server ---

  const STT_URL = process.env['AIGENT_STT_URL'] ?? 'http://127.0.0.1:8765';
  const TTS_URL = process.env['AIGENT_TTS_URL'] ?? 'http://127.0.0.1:8766';

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

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
    // Allows Playwright tests to inject fake exec_request / mount_request events without an LLM.
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
          const sttRes = await fetch(`${STT_URL}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(body.length) },
            body,
          });
          const text = await sttRes.text();
          res.writeHead(sttRes.ok ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(text);
        } catch {
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
            await writeClientSettings(updates);
            res.writeHead(204); res.end();
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }
    }

    // File search — GET /files?q=<query> returns files from mounted paths matching a fuzzy query.
    if (req.method === 'GET' && url.startsWith('/files')) {
      const qs = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
      const query = (qs.get('q') ?? '').trim().toLowerCase();
      const results: { path: string; mountPath: string }[] = [];

      if (cachedMounts.length > 0) {
        const MAX_RESULTS = 50;
        const parts = query ? query.split(/\s+/) : [];

        for (const mount of cachedMounts) {
          if (results.length >= MAX_RESULTS) break;
          try {
            // Use glob to walk the mount. Skip noisy dirs via exclude.
            const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache', 'target', 'vendor']);
            const entries = glob('**/*', {
              cwd: mount.hostPath,
              exclude: (name: string) => SKIP_DIRS.has(name) || name.startsWith('.'),
            });
            for await (const entry of entries) {
              if (results.length >= MAX_RESULTS) break;
              // Skip paths that are too deep (> 8 levels)
              if (entry.split('/').length > 8) continue;
              // Fuzzy match: all query parts must appear (in order) in the path
              const lower = entry.toLowerCase();
              if (parts.length === 0 || parts.every(p => lower.includes(p))) {
                results.push({ path: entry, mountPath: mount.containerPath });
              }
            }
          } catch { /* inaccessible mount — skip */ }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ files: results }));
      return;
    }

    // Vendor: serve marked ESM from node_modules
    if (url === '/vendor/marked.js') {
      return serveFile(res, MARKED_ESM);
    }

    // Static files from web/
    const safePath = url === '/' ? '/index.html' : url.replace(/\.\./g, '');

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

  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    log.info('Web client connected');

    // Send cached state immediately so the browser gets current messages/usage.
    if (cachedState) {
      const event: ServerEvent = { type: 'connected', state: cachedState };
      ws.send(JSON.stringify(event));
    }

    // Send cached host state so the sidebar populates immediately.
    if (cachedMounts.length > 0 || cachedCapabilities) {
      ws.send(JSON.stringify({ type: 'host_state', mounts: cachedMounts, ...(cachedCapabilities ? { capabilities: cachedCapabilities } : {}) }));
    }

    // Send current client settings so the browser can sync from the JSON file.
    // Also include effective exec permissions (defaults merged with overrides) so the
    // Permissions pane in the settings modal shows accurate data before any edits.
    readClientSettings().then((settings) => {
      if (ws.readyState === WebSocket.OPEN) {
        let merged: Record<string, boolean | number | string> = settings;
        if (getExecPermissions) {
          const perms = getExecPermissions();
          merged = {
            ...merged,
            exec_perm_alwaysAllow: JSON.stringify(perms.alwaysAllow),
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
        // Flatten nested tools config into tools_* keys for the settings panel
        const toolsCfg = (settings as Record<string, unknown>)['tools'] as Record<string, unknown> | undefined;
        if (toolsCfg) {
          merged = {
            ...merged,
            tools_summarizeLargeResults: toolsCfg['summarizeLargeResults'] === true,
            tools_summarizeThresholdTokens: typeof toolsCfg['summarizeThresholdTokens'] === 'number' ? toolsCfg['summarizeThresholdTokens'] : 500,
            tools_summarizeModel: typeof toolsCfg['summarizeModel'] === 'string' ? toolsCfg['summarizeModel'] : 'claude-haiku-4-5-20251001',
            tools_summarizeMode: typeof toolsCfg['summarizeMode'] === 'string' ? toolsCfg['summarizeMode'] : 'allowlist',
            tools_summarizeTools: JSON.stringify(Array.isArray(toolsCfg['summarizeTools']) ? toolsCfg['summarizeTools'] : ['exec', 'fetch']),
          };
        }
        ws.send(JSON.stringify({ type: 'client_settings', settings: merged }));
      }
    }).catch(() => { /* file missing is fine */ });

    // --- Relay AgentClient events → WebSocket ---

    const handlers = {
      connected: (state: ServerState) => {
        cachedState = state;
        send({ type: 'connected', state });
      },
      text: (content: string) => send({ type: 'text', content }),
      thinking: (content: string) => send({ type: 'thinking', content }),
      tool_start: (name: string, input: string, summary: string) =>
        send({ type: 'tool_start', name, input, summary }),
      tool_output: (content: string) => send({ type: 'tool_output', content }),
      tool_end: () => send({ type: 'tool_end' }),
      task_update: (task: ServerEvent extends { type: 'task_update'; task: infer T } ? T : never) =>
        send({ type: 'task_update', task }),
      message: (message: ServerState['messages'][number]) => {
        if (cachedState) cachedState = { ...cachedState, messages: [...cachedState.messages, message] };
        send({ type: 'message', message });
      },
      system: (content: string) => {
        if (cachedState) {
          const sysMsg: ServerState['messages'][number] = { role: 'system', content, timestamp: new Date().toISOString() };
          cachedState = { ...cachedState, messages: [...cachedState.messages, sysMsg] };
        }
        send({ type: 'system', content });
      },
      usage: (usage: ServerState['usage']) => {
        // Update cached state with latest usage
        if (cachedState) cachedState = { ...cachedState, usage };
        send({ type: 'usage', usage });
      },
      loading: (isLoading: boolean) => {
        if (cachedState) cachedState = { ...cachedState, isLoading };
        send({ type: 'loading', isLoading });
      },
      error: (message: string) => send({ type: 'error', message }),
      state: (partial: { thinking?: ThinkingLevel; profile?: string; sessionId?: string; model?: string }) => {
        if (cachedState) cachedState = { ...cachedState, ...partial };
        send({ type: 'state', ...partial });
      },
      mount_request: (id: string, path: string, mode: 'ro' | 'rw', reason?: string, durationMinutes?: number) =>
        send({ type: 'mount_request', id, path, mode, ...(reason !== undefined ? { reason } : {}), ...(durationMinutes !== undefined ? { durationMinutes } : {}) }),
      config_write_request: (id: string, file: string, content: string, reason: string) =>
        send({ type: 'config_write_request', id, file, content, reason }),
      edit_file_request: (id: string, path: string, edits: Array<{ old_str: string; new_str: string; index?: number }>, reason: string) =>
        send({ type: 'edit_file_request', id, path, edits, reason }),
      patch_request: (id: string, diff: string, reason: string) =>
        send({ type: 'patch_request', id, diff, reason }),
      exec_request: (id: string, command: string) => {
        // Skip if gatekeeper already handled this (auto-allow or auto-deny)
        if (autoHandledExecIds?.has(id)) {
          autoHandledExecIds.delete(id);
          return;
        }
        send({ type: 'exec_request', id, command, segments: parseCommandPipeline(command) });
      },
      fetch_request: (id: string, url: string, method?: string) => {
        // Skip if gatekeeper already handled this (auto-allow or auto-deny)
        if (autoHandledFetchIds?.has(id)) {
          autoHandledFetchIds.delete(id);
          return;
        }
        send({ type: 'fetch_request', id, url, ...(method ? { method } : {}) });
      },
      screenshot_request: (id: string) =>
        send({ type: 'screenshot_request', id }),
      screen_share_request: (id: string) =>
        send({ type: 'screen_share_request', id }),
      host_state: (mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw'; expiresAt?: number; durationMinutes?: number }[], capabilities?: Record<string, string>) =>
        send({ type: 'host_state', mounts, ...(capabilities ? { capabilities } : {}) }),
      context_breakdown: (breakdown: import('./protocol.js').ContextBreakdown) =>
        send({ type: 'context_breakdown', breakdown }),
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
          case 'message':
            if ((cmd.images && cmd.images.length > 0) || (cmd.attachments && cmd.attachments.length > 0)) {
              // Attachments present — send full command directly (slash commands never have attachments)
              client.send({
                type: 'message',
                content: cmd.content,
                ...(cmd.images ? { images: cmd.images } : {}),
                ...(cmd.attachments ? { attachments: cmd.attachments } : {}),
                ...(cmd.thinkingOverride ? { thinkingOverride: cmd.thinkingOverride } : {}),
              });
            } else {
              // Text only — use sendMessage so gatekeeper intercepts slash commands
              client.sendMessage(cmd.content, cmd.thinkingOverride);
            }
            break;
          case 'cancel':
            client.cancel();
            break;
          case 'command':
            client.sendCommand(cmd.cmd);
            break;
          case 'mount_response':
            client.send(cmd);
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
          case 'context_breakdown_request':
            client.send({ type: 'context_breakdown_request' });
            break;
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
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

  // --- Start listening ---

  return new Promise((resolvePromise, reject) => {
    server.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        log.warn('Web server port in use', { port: listenPort });
        // Don't crash — web UI is optional. Just log and resolve.
        resolvePromise({ port: listenPort });
      } else {
        reject(err);
      }
    });

    server.listen(listenPort, '0.0.0.0', () => {
      log.info('Web UI available', { url: `http://localhost:${listenPort}` });
      resolvePromise({ port: listenPort });
    });
  });
}
