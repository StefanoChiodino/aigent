/**
 * Extension Bridge — gatekeeper-side WebSocket handler for the /ext WebSocket endpoint.
 *
 * Both the Chrome extension and the VSCode extension connect here. The connection
 * type is determined by the first hello message:
 *   - Chrome:  sends `ext_hello`   → emits 'connected',       isConnected() = true
 *   - VSCode:  sends `vscode_hello` → emits 'vscode_connected', isVscodeConnected() = true
 *
 * IMPORTANT: Do NOT emit 'connected' or set isConnected on the raw WebSocket connection
 * event — the type is unknown until the hello arrives. isConnected() must return false
 * for VSCode connections. This distinction breaks every time VSCode features are added
 * without keeping these invariants.
 *
 * Usage:
 *   extensionBridge.onConnection(ws)          — called by web-bridge when /ext connects
 *   extensionBridge.isConnected()             — true only for Chrome extension
 *   extensionBridge.isVscodeConnected()       — true only for VSCode extension
 *   extensionBridge.request(action, params)   — send a command, await result (Chrome only)
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

interface VSCodeHello {
  type: 'vscode_hello';
  version: string;
}

export interface VSCodeContext {
  /** Absolute path of the active file, if any. */
  activeFile?: string;
  /** 1-based start line of the selection. */
  selectionStartLine?: number;
  selectionStartCol?: number;
  selectionEndLine?: number;
  selectionEndCol?: number;
  /** Selected text (may be empty if cursor only). */
  selectedText?: string;
  /** All currently visible file paths across split panes. */
  visibleFiles?: string[];
}

interface VSCodeContextMsg {
  type: 'vscode_context';
  context: VSCodeContext;
}

type ExtMessage = ExtHello | ExtResponse | ExtTabChanged | ExtContextMenu | VSCodeHello | VSCodeContextMsg;

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
  private isVscode = false;
  private vscodeContext: VSCodeContext | null = null;

  onConnection(ws: WebSocket): void {
    if (this.ws) {
      log.warn('Extension reconnected — dropping previous connection');
      this.ws.close();
      this.isVscode = false;
    }

    this.ws = ws;
    log.info('Extension connected');

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
        // Acknowledge the hello message so the extension knows the connection is ready
        ws.send(JSON.stringify({ type: 'ext_hello_ack', version: msg.version }));
        this.emit('connected');
        return;
      }

      if (msg.type === 'vscode_hello') {
        log.info('VSCode hello', { version: msg.version });
        this.isVscode = true;
        this.emit('vscode_connected');
        return;
      }

      if (msg.type === 'vscode_context') {
        this.vscodeContext = msg.context;
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
      this.isVscode = false;
      this.vscodeContext = null;
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
    return this.ws !== null && !this.isVscode;
  }

  isVscodeConnected(): boolean {
    return this.isVscode;
  }

  /** Returns the last known VSCode editor context, or null if not connected / no file open. */
  getVscodeContext(): VSCodeContext | null {
    return this.vscodeContext;
  }

  /** Returns the last known active tab URL (from ext_tab_changed events), or empty string. */
  getActiveTabUrl(): string {
    return this.lastTabUrl;
  }

  async request(
    action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab' | 'devtools_start' | 'devtools_snapshot' | 'devtools_stop',
    params: { tabId?: number; rootSelector?: string; steps?: unknown[]; url?: string; clear?: boolean; options?: { network?: boolean; console?: boolean; performance?: boolean } } = {},
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<ExtResponse> {
    if (!this.ws || !this.isConnected()) {
      throw new Error('Browser extension is not connected. Install the aigent extension in Chrome and make sure the gatekeeper is running.');
    }

    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    const id = `ext_${++requestCounter}`;

    return new Promise<ExtResponse>((resolve, reject) => {
      const finish = (result: 'resolve' | 'reject', value: ExtResponse | Error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
        if (result === 'resolve') resolve(value as ExtResponse);
        else reject(value as Error);
      };

      const timer = setTimeout(() => {
        finish('reject', new Error(`Browser extension request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onAbort = () => finish('reject', new Error('Aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve: (r) => finish('resolve', r),
        reject: (e) => finish('reject', e),
        timer,
      });

      const msg = { type: 'ext_request', id, action, ...params };
      (this.ws as WebSocket).send(JSON.stringify(msg));
    });
  }
}

export const extensionBridge = new ExtensionBridge();
