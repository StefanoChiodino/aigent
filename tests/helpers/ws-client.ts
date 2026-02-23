/**
 * Lightweight WebSocket helper for Playwright tests.
 *
 * Connects to the aigent WebSocket, collects events, and provides
 * a waitForEvent() helper with timeout support.
 */

import { WebSocket } from 'ws';

const PORT = Number(process.env['AIGENT_WEB_PORT'] ?? 3142);
const WS_URL = `ws://localhost:${PORT}/ws`;
const INJECT_URL = `http://localhost:${PORT}/test/inject`;

export type ServerEvent = Record<string, unknown> & { type: string };

export class AigentWsClient {
  private ws: WebSocket;
  private events: ServerEvent[] = [];
  private listeners: Array<(e: ServerEvent) => void> = [];
  private openPromise: Promise<void>;

  constructor() {
    this.ws = new WebSocket(WS_URL);
    this.openPromise = new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
    this.ws.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString()) as ServerEvent;
        this.events.push(event);
        for (const listener of this.listeners) listener(event);
      } catch { /* ignore malformed */ }
    });
  }

  async connect(): Promise<void> {
    await this.openPromise;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }

  /** Collect all events received so far. */
  collected(): ServerEvent[] {
    return [...this.events];
  }

  /** Wait until an event matching the predicate arrives, or throw on timeout. */
  waitForEvent(
    predicate: (e: ServerEvent) => boolean,
    timeoutMs = 8_000,
    description = 'event'
  ): Promise<ServerEvent> {
    // Check already-collected events first
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

/** POST a fake ServerEvent to the /test/inject endpoint. */
export async function injectEvent(event: Record<string, unknown>): Promise<void> {
  const res = await fetch(INJECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`inject failed: ${res.status}`);
}
