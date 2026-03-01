/**
 * Client connector for the agent backend server.
 *
 * Connects to the Unix socket, sends commands, and emits events.
 * Handles reconnection automatically when the server restarts.
 */

import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import type { ClientCommand, ServerEvent, ServerState } from './protocol.js';
import type { ThinkingLevel } from './agent.js';
import { SOCKET_PATH } from './protocol.js';
import { createLogger } from './logger.js';

const log = createLogger('client');

export interface AgentClientEvents {
  connected: (state: ServerState) => void;
  text: (content: string) => void;
  thinking: (content: string) => void;
  tool_start: (name: string, input: string, summary: string) => void;
  tool_output: (content: string) => void;
  tool_images: (images: { mediaType: string; data: string }[]) => void;
  tool_end: () => void;
  task_update: (task: { id: string; description: string; status: string; startedAt: string; completedAt?: string }) => void;
  message: (message: ServerState['messages'][number]) => void;
  system: (content: string) => void;
  usage: (usage: ServerState['usage']) => void;
  loading: (isLoading: boolean) => void;
  error: (message: string) => void;
  state: (partial: { thinking?: string; profile?: string; sessionId?: string }) => void;
  config_write_request: (id: string, file: string, content: string, reason: string) => void;
  edit_file_request: (id: string, path: string, edits: Array<{ old_str: string; new_str: string; index?: number }>, reason: string) => void;
  patch_request: (id: string, diff: string, reason: string) => void;
  exec_request: (id: string, command: string) => void;
  fetch_request: (id: string, url: string, method?: string) => void;
  file_access_request: (id: string, path: string, operation: 'read' | 'write', reason: string) => void;
  fetch_size_request: (id: string, url: string, requestedBytes: number, defaultBytes: number) => void;
  mcp_tool_request: (id: string, server: string, tool: string, params: string) => void;
  screenshot_request: (id: string) => void;
  screen_share_request: (id: string) => void;
  browser_ext_request: (id: string, action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate', tabId?: number, rootSelector?: string, steps?: unknown[], url?: string) => void;
  browser_write_request: (id: string, action: string, stepSummary: string, tabUrl?: string, autonomousCmd?: string) => void;
  browser_error: (level: 'warn' | 'error', message: string, source?: string) => void;
  host_state: (capabilities?: Record<string, string>) => void;
  client_settings: (settings: Record<string, boolean | number | string>) => void;
  context_breakdown: (breakdown: import('./protocol.js').ContextBreakdown) => void;
  queue_update: (queue: import('./protocol.js').QueuedMessageInfo[]) => void;
  reset: () => void;
  disconnected: () => void;
  reconnecting: (attempt: number) => void;
  permissions_updated: (settings: Record<string, string>) => void;
}

export class AgentClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private shouldReconnect = true;
  private _connected = false;
  private pendingCommands: ClientCommand[] = [];

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  private doConnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }

    this.buffer = '';
    this.socket = connect(SOCKET_PATH);

    this.socket.on('connect', () => {
      this._connected = true;
      this.reconnectAttempt = 0;
      log.debug('Connected to server');
    });

    this.socket.on('data', (data) => {
      this.buffer += data.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ServerEvent;
          this.handleEvent(event);
        } catch {
          // Malformed JSON, skip
        }
      }
    });

    this.socket.on('close', () => {
      const wasConnected = this._connected;
      this._connected = false;
      if (wasConnected) {
        this.emit('disconnected');
      }
      this.scheduleReconnect();
    });

    this.socket.on('error', () => {
      // Will trigger 'close'
      this._connected = false;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    this.reconnectAttempt++;
    // Backoff: 200ms, 500ms, 1s, 1s, 1s...
    const delay = this.reconnectAttempt <= 1 ? 200 : this.reconnectAttempt <= 3 ? 500 : 1000;

    log.debug('Reconnecting', { attempt: this.reconnectAttempt, delayMs: delay });
    this.emit('reconnecting', this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'connected':
        this.emit('connected', event.state);
        this.flushPending();
        break;
      case 'text':
        this.emit('text', event.content);
        break;
      case 'thinking':
        this.emit('thinking', event.content);
        break;
      case 'tool_start':
        this.emit('tool_start', event.name, event.input, event.summary);
        break;
      case 'tool_output':
        this.emit('tool_output', event.content);
        break;
      case 'tool_images':
        this.emit('tool_images', event.images);
        break;
      case 'tool_end':
        this.emit('tool_end');
        break;
      case 'task_update':
        this.emit('task_update', event.task);
        break;
      case 'message':
        this.emit('message', event.message);
        break;
      case 'system':
        this.emit('system', event.content);
        break;
      case 'usage':
        this.emit('usage', event.usage);
        break;
      case 'loading':
        this.emit('loading', event.isLoading);
        break;
      case 'error':
        this.emit('error', event.message);
        break;
      case 'state':
        this.emit('state', event);
        break;
      case 'config_write_request':
        this.emit('config_write_request', event.id, event.file, event.content, event.reason);
        break;
      case 'edit_file_request':
        this.emit('edit_file_request', event.id, event.path, event.edits, event.reason);
        break;
      case 'exec_request':
        this.emit('exec_request', event.id, event.command);
        break;
      case 'fetch_request':
        this.emit('fetch_request', event.id, event.url, event.method);
        break;
      case 'browser_ext_request':
        this.emit('browser_ext_request', event.id, event.action, event.tabId, event.rootSelector, event.steps, event.url, event.clear, event.options);
        break;
      case 'patch_request':
        this.emit('patch_request', event.id, event.diff, event.reason);
        break;
      case 'file_access_request':
        this.emit('file_access_request', event.id, event.path, event.operation, event.reason);
        break;
      case 'fetch_size_request':
        this.emit('fetch_size_request', event.id, event.url, event.requestedBytes, event.defaultBytes);
        break;
      case 'mcp_tool_request':
        this.emit('mcp_tool_request', event.id, event.server, event.tool, event.params);
        break;
      case 'screenshot_request':
        this.emit('screenshot_request', event.id);
        break;
      case 'screen_share_request':
        this.emit('screen_share_request', event.id);
        break;
      case 'host_state':
        this.emit('host_state', event.capabilities);
        break;
      case 'client_settings':
        this.emit('client_settings', event.settings);
        break;
      case 'browser_write_request':
        this.emit('browser_write_request', event.id, event.action, event.stepSummary, event.tabUrl, event.domain, event.requiredTier, event.alwaysReadCmd, event.alwaysWriteCmd, event.alwaysScriptCmd);
        break;
      case 'user_question_request':
        this.emit('user_question_request', event.id, event.question, event.options, event.multiSelect, event.allowFreeText);
        break;
      case 'browser_error':
        this.emit('browser_error', event.level, event.message, event.source);
        break;
      case 'context_breakdown':
        this.emit('context_breakdown', event.breakdown);
        break;
      case 'queue_update':
        this.emit('queue_update', event.queue);
        break;
      case 'reset':
        this.emit('reset');
        break;
      case 'pong':
        break;
    }
  }

  send(command: ClientCommand): void {
    if (!this.socket || !this._connected) {
      this.pendingCommands.push(command);
      return;
    }
    try {
      this.socket.write(JSON.stringify(command) + '\n');
    } catch {
      this.pendingCommands.push(command);
    }
  }

  private flushPending(): void {
    while (this.pendingCommands.length > 0 && this._connected && this.socket) {
      const cmd = this.pendingCommands.shift()!;
      try {
        this.socket.write(JSON.stringify(cmd) + '\n');
      } catch {
        this.pendingCommands.unshift(cmd);
        break;
      }
    }
  }

  sendMessage(content: string, thinkingOverride?: ThinkingLevel): void {
    if (thinkingOverride) {
      this.send({ type: 'message', content, thinkingOverride });
    } else {
      this.send({ type: 'message', content });
    }
  }

  cancel(): void {
    this.send({ type: 'cancel' });
  }

  sendCommand(cmd: string): void {
    this.send({ type: 'command', cmd });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
  }
}
