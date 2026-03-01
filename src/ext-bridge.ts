/**
 * Extension Bridge — gatekeeper-side WebSocket handler for the Chrome extension.
 *
 * Manages the single extension WebSocket connection and provides a request/response
 * API for the agent to call browser tools through.
 *
 * Usage:
 *   extensionBridge.onConnection(ws)          — called by web-bridge when /ext connects
 *   extensionBridge.isConnected()             — check if extension is live
 *   extensionBridge.request(action, params)   — send a command, await result
 */

import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { createLogger } from './logger.js';

const log = createLogger('ext-bridge');

interface ExtHello {
  type: 'ext_hello';
  version: string;
  browser: string;
}

interface ExtResponse {
  type: 'ext_response';
  id: string;
  ok: boolean;
  treeText?: string;
  dataUrl?: string;
  tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[];
  stepsCompleted?: number;
  totalSteps?: number;
  finalUrl?: string;
  finalTitle?: string;
  newTabId?: number;
  screenshots?: Array<{ stepIndex: number; dataUrl: string }>;
  devtools?: {
    network: Array<{ id: string; url: string; method: string; status?: number; mimeType?: string; size?: number; error?: string; timestamp: number }>;
    console: Array<{ type: string; text: string; url?: string; line?: number; timestamp: number }>;
    exceptions: Array<{ text: string; url?: string; line?: number; stack?: string; timestamp: number }>;
    performance?: { metrics: Record<string, number> };
  };
  error?: string;
}

interface ExtTabChanged {
  type: 'ext_tab_changed';
  tabId: number;
  url: string;
  title: string;
}

interface ExtContextMenu {
  type: 'ext_context_menu';
  selectionText?: string;
  pageUrl?: string;
  linkUrl?: string;
  srcUrl?: string;
  tabId?: number;
  tabTitle?: string;
}

type ExtMessage = ExtHello | ExtResponse | ExtTabChanged | ExtContextMenu;

interface PendingRequest {
  resolve: (r: ExtResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let requestCounter = 0;

class ExtensionBridge extends EventEmitter {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private lastTabUrl = '';

  onConnection(ws: WebSocket): void {
    if (this.ws) {
      log.warn('Extension reconnected — dropping previous connection');
      this.ws.close();
    }

    this.ws = ws;
    log.info('Extension connected');
    this.emit('connected');

    ws.on('message', (data: Buffer) => {
      let msg: ExtMessage;
      try {
        msg = JSON.parse(data.toString()) as ExtMessage;
      } catch {
        log.warn('Extension sent invalid JSON');
        return;
      }

      if (msg.type === 'ext_hello') {
        log.info('Extension hello', { version: msg.version, browser: msg.browser });
        return;
      }

      if (msg.type === 'ext_tab_changed') {
        this.lastTabUrl = msg.url;
        return;
      }

      if (msg.type === 'ext_context_menu') {
        this.emit('context_menu', msg);
        return;
      }

      if (msg.type === 'ext_response') {
        const pending = this.pending.get(msg.id);
        if (!pending) {
          log.warn('Extension response for unknown request', { id: msg.id });
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(msg.id);
        pending.resolve(msg);
      }
    });

    ws.on('close', () => {
      log.info('Extension disconnected');
      this.ws = null;
      // Reject any pending requests
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Extension disconnected'));
        this.pending.delete(id);
      }
      this.emit('disconnected');
    });

    ws.on('error', (err: Error) => {
      log.error('Extension WebSocket error', { err: err.message });
    });
  }

  isConnected(): boolean {
    return this.ws !== null;
  }

  /** Returns the last known active tab URL (from ext_tab_changed events), or empty string. */
  getActiveTabUrl(): string {
    return this.lastTabUrl;
  }

  async request(
    action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab' | 'devtools_start' | 'devtools_snapshot' | 'devtools_stop',
    params: { tabId?: number; rootSelector?: string; steps?: unknown[]; url?: string; clear?: boolean; options?: { network?: boolean; console?: boolean; performance?: boolean } } = {},
    timeoutMs = 30_000,
  ): Promise<ExtResponse> {
    if (!this.ws || !this.isConnected()) {
      throw new Error('Browser extension is not connected. Install the aigent extension in Chrome and make sure the gatekeeper is running.');
    }

    const id = `ext_${++requestCounter}`;

    return new Promise<ExtResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser extension request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const msg = { type: 'ext_request', id, action, ...params };
      (this.ws as WebSocket).send(JSON.stringify(msg));
    });
  }
}

export const extensionBridge = new ExtensionBridge();
