/**
 * Web Bridge — HTTP + WebSocket server that bridges AgentClient events to the browser.
 *
 * Serves static files from web/ and relays ServerEvents over WebSocket.
 * Uses the same AgentClient instance as the TUI, so gatekeeper command
 * interception works automatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentClient } from './client.js';
import { extensionBridge } from './ext-bridge.js';
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
  const merged: Record<string, unknown> = { ...current as Record<string, unknown> };
  for (const [k, v] of Object.entries(updates)) {
    // Deep-merge nested permission objects so gatekeeper-added entries survive
    // a browser POST that only intends to update one sub-field.
    if ((k === 'exec_permissions' || k === 'fetch_permissions') &&
        v !== null && typeof v === 'object' &&
        merged[k] !== null && typeof merged[k] === 'object') {
      const existing = merged[k] as Record<string, unknown>;
      const incoming = v as Record<string, unknown>;
      merged[k] = { ...existing, ...incoming };
    } else {
      merged[k] = v;
    }
  }
  const tmp = SETTINGS_PATH + '.tmp';
  await writeFile(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  await rename(tmp, SETTINGS_PATH);
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

export async function startWebServer(
  client: AgentClient,
  port?: number,
  options?: { autoHandledExecIds?: Set<string>; getExecPermissions?: () => ExecPermissions; autoHandledFetchIds?: Set<string>; getFetchPermissions?: () => FetchPermissions; autoHandledBrowserWriteIds?: Set<string> },
): Promise<{ port: number }> {
  const { autoHandledExecIds, getExecPermissions, autoHandledFetchIds, getFetchPermissions, autoHandledBrowserWriteIds } = options ?? {};
  const listenPort = port ?? (Number(process.env['AIGENT_WEB_PORT']) || 3141);

  // Cache the latest server state so new connections get immediate state.
  // These listeners run ONCE (not per-connection) to avoid duplicate appends
  // when multiple browser tabs are connected simultaneously.

  // In test mode (no container), seed cachedState with defaults so the browser
  // gets a valid connected event and the sidebar populates immediately.
  const TEST_MODE = process.env['AIGENT_TEST_MODE'] === '1';
  const DEFAULT_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  let cachedState: ServerState | null = TEST_MODE
    ? {
        messages: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinking: 'high' as ThinkingLevel,
        concise: false,
        profile: 'default',
        sessionId: 'test',
        model: DEFAULT_MODELS[0]!,
        availableModels: DEFAULT_MODELS,
        availableTools: [],
        isLoading: false,
        tasks: [],
        pendingResults: 0,
      }
    : null;
  client.on('connected', (state) => { cachedState = state; });
  client.on('message', (message: ServerState['messages'][number]) => {
    if (cachedState) cachedState = { ...cachedState, messages: [...cachedState.messages, message] };
  });
  client.on('system', (content: string) => {
    if (cachedState) {
      const sysMsg: ServerState['messages'][number] = { role: 'system', content, timestamp: new Date().toISOString() };
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

  // Cache latest host state from gatekeeper (capabilities).
  let cachedCapabilities: Record<string, string> | undefined;
  client.on('host_state', (_mounts: unknown, capabilities: Record<string, string> | undefined) => {
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

    // /concise on|off
    if (trimmed === '/concise on' || trimmed === '/concise off') {
      const concise = trimmed === '/concise on';
      if (cachedState) cachedState = { ...cachedState, concise };
      broadcastToClients({ type: 'state', concise });
      // Only emit a system message when enabling concise mode — the "on" test
      // checks for it, but no test checks for "off". Emitting on disable causes
      // a race: the message can arrive after beforeEach clearMessages() and
      // cause the next test's waitForFunction to time out.
      if (concise) broadcastToClients({ type: 'system', content: 'Concise mode: on' });
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
    const userMsg = { role: 'user' as const, content: trimmed, timestamp: ts };
    if (cachedState) cachedState = { ...cachedState, messages: [...cachedState.messages, userMsg] };
    broadcastToClients({ type: 'message', message: userMsg });
    return true;
  }

  wss.on('connection', (ws: WebSocket) => {
    log.info('Web client connected');

    // Send cached state immediately so the browser gets current messages/usage.
    if (cachedState) {
      const event: ServerEvent = { type: 'connected', state: cachedState };
      ws.send(JSON.stringify(event));
    }

    // Send cached host state so the sidebar populates immediately.
    if (cachedCapabilities) {
      ws.send(JSON.stringify({ type: 'host_state', mounts: [], ...(cachedCapabilities ? { capabilities: cachedCapabilities } : {}) }));
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
      connected: (state: ServerState) => send({ type: 'connected', state }),
      text: (content: string) => send({ type: 'text', content }),
      thinking: (content: string) => send({ type: 'thinking', content }),
      tool_start: (name: string, input: string, summary: string) =>
        send({ type: 'tool_start', name, input, summary }),
      tool_output: (content: string) => send({ type: 'tool_output', content }),
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
      browser_ext_request: (id: string, action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab', _tabId?: number, _rootSelector?: string, steps?: unknown[], url?: string) => {
        // Read-only actions are handled entirely by the gatekeeper — no relay needed.
        // Write actions need user approval: send browser_write_request to the web UI.
        if (action === 'run_script' || action === 'navigate' || action === 'open_tab' || action === 'close_tab') {
          // Skip if gatekeeper already handled this (browser write grant active)
          if (autoHandledBrowserWriteIds?.has(id)) {
            autoHandledBrowserWriteIds.delete(id);
            return;
          }
          const stepSummary = action === 'navigate'
            ? `Navigate to ${url ?? '?'}`
            : action === 'open_tab'
            ? `Open new tab: ${url ?? '?'}`
            : action === 'close_tab'
            ? `Close tab ${_tabId ?? '?'}`
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
                }
                let summary = verbs.slice(0, 5).join(', ');
                const extra = verbs.length - 5;
                if (extra > 0) summary += ` + ${extra} more`;
                return summary.length > 80 ? summary.slice(0, 77) + '...' : summary;
              })();
          const tabUrl = extensionBridge.getActiveTabUrl();
          send({ type: 'browser_write_request', id, action, stepSummary, ...(tabUrl ? { tabUrl } : {}), autonomousCmd: `/grant-browser-autonomous` });
        }
      },
      screenshot_request: (id: string) =>
        send({ type: 'screenshot_request', id }),
      screen_share_request: (id: string) =>
        send({ type: 'screen_share_request', id }),
      host_state: (mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw'; expiresAt?: number; durationMinutes?: number }[], capabilities?: Record<string, string>) =>
        send({ type: 'host_state', mounts, ...(capabilities ? { capabilities } : {}) }),
      context_breakdown: (breakdown: import('./protocol.js').ContextBreakdown) =>
        send({ type: 'context_breakdown', breakdown }),
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
          case 'message':
            // In test mode there is no container, so handle slash commands locally
            // by broadcasting the appropriate state events back to all clients.
            if (TEST_MODE && typeof cmd.content === 'string' && !cmd.images && !cmd.attachments) {
              if (handleTestModeCommand(cmd.content as string)) break;
            }
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
