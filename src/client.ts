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
  tool_end: () => void;
  task_update: (task: { id: string; description: string; status: string; startedAt: string; completedAt?: string }) => void;
  message: (message: ServerState['messages'][number]) => void;
  system: (content: string) => void;
  usage: (usage: ServerState['usage']) => void;
  loading: (isLoading: boolean) => void;
  error: (message: string) => void;
  state: (partial: { thinking?: string; profile?: string; sessionId?: string }) => void;
  host_state: (mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[], capabilities?: Record<string, string>) => void;
  exec_request: (id: string, command: string) => void;
  disconnected: () => void;
  reconnecting: (attempt: number) => void;
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
      case 'mount_request':
        this.emit('mount_request', event.id, event.path, event.mode, event.reason, event.durationMinutes);
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
      case 'screenshot_request':
        this.emit('screenshot_request', event.id);
        break;
      case 'screen_share_request':
        this.emit('screen_share_request', event.id);
        break;
      case 'context_breakdown':
        this.emit('context_breakdown', event.breakdown);
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
