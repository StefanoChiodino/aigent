/**
 * Host daemon protocol — shared types between daemon and agent client.
 * NDJSON over Unix socket.
 */

// --- Capabilities ---

export type CapabilityName =
  | 'clipboard.read'
  | 'clipboard.write'
  | 'screen.capture'
  | 'screen.list'
  | 'audio.play'
  | 'audio.record'
  | 'notify'
  | 'open'
  | 'fs.read'
  | 'fs.write';

export type GrantLevel = 'allow' | 'session' | 'prompt' | 'timed' | 'deny';

export interface PermissionEntry {
  grant: GrantLevel;
  /** TTL in seconds for 'timed' grants (default: 300). */
  ttl?: number;
  /** Timestamp when a timed grant was first approved. */
  grantedAt?: number;
}

// --- Request / Response ---

export interface HostRequest {
  id: string;
  capability: CapabilityName;
  params: Record<string, unknown>;
  /** Optional reason shown to user on 'prompt' grants. */
  reason?: string;
}

export interface HostResponseOk {
  id: string;
  ok: true;
  result: unknown;
}

export interface HostResponseError {
  id: string;
  ok: false;
  error: 'denied' | 'unavailable' | 'failed' | 'timeout';
  message: string;
}

export type HostResponse = HostResponseOk | HostResponseError;

// --- Events (daemon → agent, unsolicited) ---

export interface HostEvent {
  event: 'capabilities';
  capabilities: Record<CapabilityName, { available: boolean; grant: GrantLevel }>;
}

// --- Capability provider interface ---

export interface CapabilityResult {
  [key: string]: unknown;
}

export interface CapabilityProvider {
  /** Capability names this provider handles. */
  capabilities: CapabilityName[];

  /** Check if this provider works on the current platform. Returns available capability names. */
  detect(): Promise<CapabilityName[]>;

  /** Execute a capability. */
  execute(capability: CapabilityName, params: Record<string, unknown>): Promise<CapabilityResult>;
}

// Default socket path
export const HOST_SOCKET_PATH = '/tmp/aigent-host.sock';
