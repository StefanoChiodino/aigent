#!/usr/bin/env node
/**
 * aigent-host — Host capability daemon.
 *
 * Runs on the host (outside Docker). Exposes OS capabilities to the
 * sandboxed agent over a Unix socket with a permission model.
 *
 * Usage:
 *   tsx src/host/daemon.ts [options]
 *   aigent-host [options]
 *
 * Options:
 *   --allow <caps>    Comma-separated capabilities to allow
 *   --deny <caps>     Comma-separated capabilities to deny
 *   --socket <path>   Socket path (default: /tmp/aigent-host.sock)
 *   --config <path>   Config path (default: ~/.config/aigent/permissions.json)
 */

import { createServer, type Socket } from 'node:net';
import { unlinkSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PermissionStore } from './permissions.js';
import { ClipboardProvider } from './providers/clipboard.js';
import {
  HOST_SOCKET_PATH,
  type CapabilityName,
  type CapabilityProvider,
  type HostRequest,
  type HostResponse,
  type HostEvent,
} from './protocol.js';

// --- Parse CLI args ---

function parseArgs(argv: string[]): {
  allow: CapabilityName[];
  deny: CapabilityName[];
  socket: string;
  config: string;
} {
  const result = {
    allow: [] as CapabilityName[],
    deny: [] as CapabilityName[],
    socket: HOST_SOCKET_PATH,
    config: join(homedir(), '.config', 'aigent', 'permissions.json'),
  };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--allow':
        result.allow = (argv[++i] ?? '').split(',').filter(Boolean) as CapabilityName[];
        break;
      case '--deny':
        result.deny = (argv[++i] ?? '').split(',').filter(Boolean) as CapabilityName[];
        break;
      case '--socket':
        result.socket = argv[++i] ?? result.socket;
        break;
      case '--config':
        result.config = argv[++i] ?? result.config;
        break;
      case '--help':
      case '-h':
        console.log(`aigent-host — Host capability daemon

Usage: aigent-host [options]

Options:
  --allow <caps>    Comma-separated capabilities to pre-allow
  --deny <caps>     Comma-separated capabilities to deny
  --socket <path>   Socket path (default: /tmp/aigent-host.sock)
  --config <path>   Permissions config path

Capabilities:
  clipboard.read, clipboard.write, screen.capture, screen.list,
  audio.play, audio.record, notify, open, fs.read, fs.write

Examples:
  aigent-host
  aigent-host --allow clipboard.read,notify --deny fs.read,fs.write
`);
        process.exit(0);
    }
  }

  return result;
}

// --- Daemon ---

class HostDaemon {
  private permissions: PermissionStore;
  private providers: Map<CapabilityName, CapabilityProvider> = new Map();
  private availableCapabilities: Set<CapabilityName> = new Set();
  private socketPath: string;

  constructor(socketPath: string, configPath: string) {
    this.socketPath = socketPath;
    this.permissions = new PermissionStore(configPath);
  }

  async init(allow: CapabilityName[], deny: CapabilityName[]): Promise<void> {
    // Apply CLI overrides
    this.permissions.applyOverrides(allow, deny);

    // Discover providers
    const allProviders: CapabilityProvider[] = [
      new ClipboardProvider(),
      // Future: ScreenProvider, AudioProvider, etc.
    ];

    for (const provider of allProviders) {
      const available = await provider.detect();
      for (const cap of available) {
        this.providers.set(cap, provider);
        this.availableCapabilities.add(cap);
      }
    }

    const avail = [...this.availableCapabilities];
    if (avail.length === 0) {
      log('No capabilities detected on this platform');
    } else {
      log(`Available capabilities: ${avail.join(', ')}`);
    }
  }

  /** Build the capabilities event to send on connection. */
  private capabilitiesEvent(): HostEvent {
    const caps: Record<string, { available: boolean; grant: string }> = {};
    const allGrants = this.permissions.getAll();
    for (const [cap, grant] of Object.entries(allGrants)) {
      caps[cap] = {
        available: this.availableCapabilities.has(cap as CapabilityName),
        grant,
      };
    }
    return { event: 'capabilities', capabilities: caps } as HostEvent;
  }

  /** Handle a single request from the agent. */
  async handleRequest(req: HostRequest): Promise<HostResponse> {
    const { id, capability, params, reason } = req;

    // Check if capability exists
    if (!this.availableCapabilities.has(capability)) {
      return { id, ok: false, error: 'unavailable', message: `${capability} is not available on this platform` };
    }

    // Check permission
    const allowed = this.permissions.check(capability);
    if (allowed === false) {
      log(`Denied: ${capability}`);
      return { id, ok: false, error: 'denied', message: `${capability} permission denied` };
    }

    if (allowed === null) {
      // Need to prompt
      const decision = await this.permissions.prompt(capability, reason);
      if (decision === 'deny') {
        log(`User denied: ${capability}`);
        return { id, ok: false, error: 'denied', message: `${capability} denied by user` };
      }
      if (decision === 'session') {
        this.permissions.grantSession(capability);
        log(`Session grant: ${capability}`);
      }
      // 'allow' (one-time) — just proceed
    }

    // Execute
    const provider = this.providers.get(capability)!;
    try {
      const result = await provider.execute(capability, params);
      log(`Executed: ${capability}`);
      return { id, ok: true, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Failed: ${capability} — ${message}`);
      return { id, ok: false, error: 'failed', message };
    }
  }

  /** Start listening on the socket. */
  start(): void {
    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch {}
    }

    const server = createServer((socket: Socket) => {
      log('Agent connected');

      // Send capabilities on connect
      writeLine(socket, this.capabilitiesEvent());

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line) as HostRequest;
            this.handleRequest(req).then((res) => {
              writeLine(socket, res);
            });
          } catch (err) {
            log(`Invalid request: ${line}`);
          }
        }
      });

      socket.on('close', () => {
        log('Agent disconnected');
      });

      socket.on('error', (err) => {
        log(`Socket error: ${err.message}`);
      });
    });

    server.listen(this.socketPath, () => {
      // Restrict socket to owner only
      // 0o666 so the container (uid 1000) can connect to the host daemon
      try { chmodSync(this.socketPath, 0o666); } catch {}
      log(`Listening on ${this.socketPath}`);
      log('Waiting for agent connection...');
    });

    server.on('error', (err) => {
      console.error(`[aigent-host] Fatal: ${err.message}`);
      process.exit(1);
    });

    // Graceful shutdown
    const cleanup = () => {
      log('Shutting down...');
      server.close();
      try { unlinkSync(this.socketPath); } catch {}
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }
}

// --- Helpers ---

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  process.stderr.write(`[aigent-host ${ts}] ${msg}\n`);
}

function writeLine(socket: Socket, data: unknown): void {
  socket.write(JSON.stringify(data) + '\n');
}

// --- Entry ---

// Refuse to run as root
if (process.getuid?.() === 0) {
  console.error('[aigent-host] Refusing to run as root');
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const daemon = new HostDaemon(args.socket, args.config);
await daemon.init(args.allow, args.deny);
daemon.start();
