/**
 * Web server — HTTP + WebSocket bridge to the Unix socket worker.
 *
 * Each WebSocket client gets its own Unix socket connection to the worker,
 * so multiple browser tabs work independently.
 *
 * Usage:
 *   import { startWebServer } from './web/server.js';
 *   const server = await startWebServer(3000);
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SOCKET_PATH } from '../protocol.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');

// Resolve public directory — works from both src/ and dist/
async function findPublicDir(): Promise<string> {
  const candidates = [
    resolve(__dirname, 'public'),                         // src/web/public (dev with tsx)
    resolve(__dirname, '..', '..', 'src', 'web', 'public'), // dist/web/ → src/web/public
    resolve(__dirname, '..', 'web', 'public'),            // dist/ → src/web/public
  ];
  for (const dir of candidates) {
    try {
      await readFile(join(dir, 'index.html'));
      return dir;
    } catch { /* try next */ }
  }
  return candidates[0]!; // fallback
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

export interface WebServerHandle {
  port: number;
  close: () => void;
}

export async function startWebServer(port?: number): Promise<WebServerHandle> {
  const listenPort = port ?? (Number(process.env['AIGENT_PORT']) || 3000);
  const publicDir = await findPublicDir();

  // --- HTTP server: serve static files ---
  const server = createServer(async (_req: IncomingMessage, res: ServerResponse) => {
    const url = (_req.url ?? '/').split('?')[0]!;
    const safePath = url === '/' ? '/index.html' : url.replace(/\.\./g, '');
    await serveFile(res, join(publicDir, safePath));
  });

  // --- WebSocket server at /ws ---
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket) => {
    // Each WS client gets its own Unix socket connection to the worker
    let workerSocket: Socket | null = null;
    let workerBuffer = '';
    let workerConnected = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let shouldReconnect = true;

    function connectWorker(): void {
      if (workerSocket) {
        workerSocket.removeAllListeners();
        workerSocket.destroy();
      }
      workerBuffer = '';
      workerSocket = connect(SOCKET_PATH);

      workerSocket.on('connect', () => {
        workerConnected = true;
      });

      workerSocket.on('data', (data: Buffer) => {
        workerBuffer += data.toString();
        const lines = workerBuffer.split('\n');
        workerBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          // Forward NDJSON line to WebSocket client as-is
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(line);
          }
        }
      });

      workerSocket.on('close', () => {
        workerConnected = false;
        if (shouldReconnect && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'error', message: 'Worker disconnected, reconnecting...' }));
          scheduleWorkerReconnect();
        }
      });

      workerSocket.on('error', () => {
        workerConnected = false;
        if (shouldReconnect) {
          scheduleWorkerReconnect();
        }
      });
    }

    function scheduleWorkerReconnect(): void {
      if (!shouldReconnect) return;
      if (reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (shouldReconnect && ws.readyState === WebSocket.OPEN) {
          connectWorker();
        }
      }, 1000);
    }

    function sendToWorker(json: string): void {
      if (workerSocket && workerConnected) {
        workerSocket.write(json + '\n');
      }
    }

    // Start worker connection
    connectWorker();

    // --- WebSocket messages → Worker ---
    ws.on('message', (data: Buffer | string) => {
      const msg = data.toString();
      try {
        const parsed = JSON.parse(msg);
        // Handle ping locally
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        sendToWorker(msg);
      } catch {
        // Malformed JSON, ignore
      }
    });

    // --- Cleanup on WS disconnect ---
    ws.on('close', () => {
      shouldReconnect = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (workerSocket) {
        workerSocket.removeAllListeners();
        workerSocket.destroy();
        workerSocket = null;
      }
    });

    ws.on('error', () => {
      // close will fire next
    });
  });

  // --- Start listening ---
  return new Promise((resolvePromise, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(listenPort, '0.0.0.0', () => {
      console.log(`[web] aigent web UI at http://localhost:${listenPort}`);
      resolvePromise({
        port: listenPort,
        close: () => {
          wss.close();
          server.close();
        },
      });
    });
  });
}
