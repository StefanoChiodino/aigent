/**
 * Protocol types for client ↔ server communication over Unix socket.
 * Newline-delimited JSON (NDJSON).
 */

import type { ThinkingLevel } from './agent.js';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number; // Estimated cost in USD (informational, even for subscription users)
  contextTokens?: number; // Latest API call's input tokens = actual context window fill
}

// --- Client → Server ---

export type ClientCommand =
  | { type: 'message'; content: string; images?: { mediaType: string; data: string }[]; attachments?: { name: string; mediaType: string; data: string }[]; thinkingOverride?: ThinkingLevel }
  | { type: 'cancel' }
  | { type: 'command'; cmd: string }
  | { type: 'mount_response'; id: string; ok: boolean; containerPath?: string; message: string }
  | { type: 'config_write_response'; id: string; ok: boolean; message: string }
  | { type: 'patch_response'; id: string; ok: boolean; message: string }
  | { type: 'screenshot_response'; id: string; ok: boolean; data?: string; mediaType?: string; message: string }
  | { type: 'screen_share_response'; id: string; ok: boolean; message: string }
  | { type: 'ping' };

// --- Server → Client ---

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  elapsed?: number | undefined;
}

export interface BackgroundTaskInfo {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
}

export interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: ThinkingLevel;
  concise: boolean;
  profile: string;
  sessionId: string;
  model: string;
  availableModels: string[];
  isLoading: boolean;
  tasks: BackgroundTaskInfo[];
  pendingResults: number;
}

export type ServerEvent =
  | { type: 'connected'; state: ServerState }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string; input: string; summary: string }
  | { type: 'tool_output'; content: string }
  | { type: 'tool_end' }
  | { type: 'message'; message: DisplayMessage }
  | { type: 'system'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'state'; thinking?: ThinkingLevel; profile?: string; sessionId?: string; model?: string; concise?: boolean; availableModels?: string[] }
  | { type: 'task_update'; task: BackgroundTaskInfo }
  | { type: 'mount_request'; id: string; path: string; mode: 'ro' | 'rw'; reason?: string; durationMinutes?: number }
  | { type: 'config_write_request'; id: string; file: string; content: string; reason: string }
  | { type: 'patch_request'; id: string; diff: string; reason: string }
  | { type: 'screenshot_request'; id: string }
  | { type: 'screen_share_request'; id: string }
  | { type: 'host_state'; mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw'; expiresAt?: number; durationMinutes?: number }[]; capabilities?: Record<string, string> }
  | { type: 'client_settings'; settings: Record<string, boolean | number | string> }
  | { type: 'pong' };

// --- Worker → Gatekeeper (capability/mount requests) ---

export type WorkerRequest =
  | { type: 'mount_request'; id: string; path: string; mode: 'ro' | 'rw'; reason?: string; durationMinutes?: number }
  | { type: 'capability_request'; id: string; capability: string; params: Record<string, unknown>; reason?: string };

// --- Gatekeeper → Worker (responses to requests) ---

export type GatekeeperResponse =
  | { type: 'mount_response'; id: string; ok: boolean; containerPath?: string; message: string }
  | { type: 'capability_response'; id: string; ok: boolean; result?: unknown; message: string };

// Socket directory — shared mount between host and container.
// The worker creates its socket here; the gatekeeper connects from the host.
export const SOCKET_DIR = '/tmp/aigent';
export const SOCKET_PATH = `${SOCKET_DIR}/worker.sock`;
