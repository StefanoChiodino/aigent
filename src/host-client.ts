/**
 * Host daemon client — used by the agent (inside Docker) to call host capabilities.
 *
 * Connects to the host daemon's Unix socket. Handles request/response matching,
 * reconnection, and capability discovery.
 */

import { createConnection, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import type {
  CapabilityName,
  GrantLevel,
  HostRequest,
  HostResponse,
  HostEvent,
} from './host/protocol.js';
import { HOST_SOCKET_PATH } from './host/protocol.js';

// --- Singleton ---

let hostClientInstance: HostClient | null = null;

/** Get the singleton HostClient (creates on first call, connects if socket exists). */
export function getHostClient(): HostClient | null {
  if (!hostClientInstance) {
    hostClientInstance = new HostClient();
    if (!hostClientInstance.connect()) {
      hostClientInstance = null;
      return null;
    }
  }
  return hostClientInstance;
}

/** Initialize the host client (called at server startup). */
export function initHostClient(socketPath?: string): HostClient | null {
  hostClientInstance = new HostClient(socketPath);
  if (!hostClientInstance.connect()) {
    hostClientInstance = null;
    return null;
  }
  return hostClientInstance;
}

interface PendingRequest {
  resolve: (res: HostResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CapabilityInfo {
  available: boolean;
  grant: GrantLevel;
}

export class HostClient {
  private socket: Socket | null = null;
  private connected = false;
  private pending: Map<string, PendingRequest> = new Map();
  private capabilities: Map<CapabilityName, CapabilityInfo> = new Map();
  private reqCounter = 0;
  private socketPath: string;
  private buffer = '';

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? HOST_SOCKET_PATH;
  }

  /** Try to connect to the host daemon. Returns true if connected. */
  connect(): boolean {
    if (this.connected) return true;
    if (!existsSync(this.socketPath)) return false;

    try {
      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this.handleMessage(msg);
          } catch {}
        }
      });

      this.socket.on('close', () => {
        this.connected = false;
        this.socket = null;
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer);
          req.resolve({ id, ok: false, error: 'failed', message: 'Host daemon disconnected' });
        }
        this.pending.clear();
      });

      this.socket.on('error', () => {
        this.connected = false;
        this.socket = null;
      });

      return true;
    } catch {
      return false;
    }
  }

  private handleMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;

    // Event (capabilities announcement)
    if ('event' in msg && (msg as HostEvent).event === 'capabilities') {
      const evt = msg as HostEvent;
      this.capabilities.clear();
      for (const [cap, info] of Object.entries(evt.capabilities)) {
        this.capabilities.set(cap as CapabilityName, info);
      }
      return;
    }

    // Response to a request
    if ('id' in msg) {
      const res = msg as HostResponse;
      const pending = this.pending.get(res.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(res.id);
        pending.resolve(res);
      }
    }
  }

  /** Send a capability request to the host daemon. */
  async request(
    capability: CapabilityName,
    params: Record<string, unknown> = {},
    reason?: string,
  ): Promise<HostResponse> {
    if (!this.connected || !this.socket) {
      return {
        id: 'none',
        ok: false,
        error: 'unavailable',
        message: 'Host daemon not connected. Start it with: aigent-host',
      };
    }

    const id = `req_${++this.reqCounter}`;
    const req: HostRequest = { id, capability, params, ...(reason ? { reason } : {}) };

    return new Promise<HostResponse>((resolve) => {
      // 60s timeout — prompt grants can take time
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, ok: false, error: 'timeout', message: `Request timed out after 60s` });
      }, 60_000);

      this.pending.set(id, { resolve, timer });
      this.socket!.write(JSON.stringify(req) + '\n');
    });
  }

  /** Check if the daemon is connected. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Get available capabilities (after connection). */
  getCapabilities(): Map<CapabilityName, CapabilityInfo> {
    return this.capabilities;
  }

  /** Get capabilities that are available and not denied — for system prompt. */
  getAvailableCapabilities(): CapabilityName[] {
    const result: CapabilityName[] = [];
    for (const [cap, info] of this.capabilities) {
      if (info.available && info.grant !== 'deny') result.push(cap);
    }
    return result;
  }

  /** Get capabilities that are explicitly denied — for system prompt. */
  getDeniedCapabilities(): CapabilityName[] {
    const result: CapabilityName[] = [];
    for (const [cap, info] of this.capabilities) {
      if (info.grant === 'deny') result.push(cap);
    }
    return result;
  }

  /** Disconnect from the daemon. */
  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }
}
