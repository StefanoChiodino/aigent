/**
 * Web Bridge — HTTP + WebSocket server that bridges AgentClient events to the browser.
 *
 * Serves static files from web/ and relays ServerEvents over WebSocket.
 * Uses the same AgentClient instance as the TUI, so gatekeeper command
 * interception works automatically.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentClient } from './client.js';
import type { ServerEvent, ServerState } from './protocol.js';
import type { ThinkingLevel } from './agent.js';
import { createLogger } from './logger.js';

const log = createLogger('web-bridge');

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const WEB_DIR = resolve(__dirname, '..', 'web');
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
): Promise<{ port: number }> {
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

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

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
      mount_request: (id: string, path: string, mode: 'ro' | 'rw', reason?: string) =>
        send({ type: 'mount_request', id, path, mode, ...(reason !== undefined ? { reason } : {}) }),
      config_write_request: (id: string, file: string, content: string, reason: string) =>
        send({ type: 'config_write_request', id, file, content, reason }),
      host_state: (mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[], capabilities?: Record<string, string>) =>
        send({ type: 'host_state', mounts, ...(capabilities ? { capabilities } : {}) }),
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
