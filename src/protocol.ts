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
  | { type: 'message'; content: string; images?: { mediaType: string; data: string }[]; attachments?: { name: string; mediaType: string; data: string; thumbnail?: string }[]; thinkingOverride?: ThinkingLevel }
  | { type: 'cancel' }
  | { type: 'command'; cmd: string }
  | { type: 'mount_response'; id: string; ok: boolean; containerPath?: string; message: string }
  | { type: 'config_write_response'; id: string; ok: boolean; message: string }
  | { type: 'edit_file_response'; id: string; ok: boolean; message: string }
  | { type: 'exec_response'; id: string; ok: boolean; alwaysAllow?: boolean; message: string }
  | { type: 'fetch_response'; id: string; ok: boolean; alwaysAllow?: boolean; message: string }
  | { type: 'screenshot_response'; id: string; ok: boolean; data?: string; mediaType?: string; message: string }
  | { type: 'screen_share_response'; id: string; ok: boolean; message: string }
  | { type: 'host_state'; mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[] }
  | { type: 'context_breakdown_request' }
  | { type: 'browser_ext_request'; id: string; action: 'extract_a11y' | 'screenshot'; tabId?: number; rootSelector?: string }
  | { type: 'ping' };

// --- Server → Client ---

export interface DisplayAttachment {
  name: string;
  mediaType: string;
  thumbnail?: string; // data:image/jpeg;base64,... (small ~200px JPEG for chat display)
}

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  elapsed?: number | undefined;
  attachments?: DisplayAttachment[];
}

/** Record of a tool result that was summarized to save context tokens. */
export interface ToolSummaryRecord {
  toolCallId: string;
  toolName: string;
  originalTokens: number;
  summarizedTokens: number;
  savedTokens: number;
  fullOutputPath: string; // e.g. /tmp/aigent/tool-results/<id>.txt
  summary: string;
}

export interface ContextBreakdown {
  systemBase: number;
  systemBaseContent?: string;      // First ~500 chars of base system prompt
  workspaceContext: number;
  workspaceContent?: string;       // First ~500 chars of workspace context section
  toolDefs: number;
  toolDefsContent?: string;        // JSON snippet of tool names
  messages: { role: string; tokens: number; preview?: string; summaryRecord?: ToolSummaryRecord }[];
  messagesTotal: number;
  total: number;
  totalSummarySavedTokens?: number;
  toolSummariesCount?: number;
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
  delivery?: 'agent-review' | 'user-pull';
  /** Raw result text — only set for user-pull tasks so the UI can display it. */
  result?: string;
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
  availableTools: string[];
  isLoading: boolean;
  tasks: BackgroundTaskInfo[];
  pendingResults: number;
}

export type ServerEvent =
  | { type: 'connected'; state: ServerState }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string; input: string; summary: string; model?: string; thinking?: string }
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
  | { type: 'edit_file_request'; id: string; path: string; edits: Array<{ old_str: string; new_str: string; index?: number }>; reason: string }
  | { type: 'patch_request'; id: string; diff: string; reason: string }
  | { type: 'exec_request'; id: string; command: string; segments?: import('./safety.js').CommandSegment[] }
  | { type: 'fetch_request'; id: string; url: string; method?: string }
  | { type: 'screenshot_request'; id: string }
  | { type: 'screen_share_request'; id: string }
  | { type: 'host_state'; mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw'; expiresAt?: number; durationMinutes?: number }[]; capabilities?: Record<string, string> }
  | { type: 'client_settings'; settings: Record<string, boolean | number | string> }
  | { type: 'context_breakdown'; breakdown: ContextBreakdown }
  | { type: 'browser_ext_result'; id: string; ok: boolean; treeText?: string; dataUrl?: string; error?: string }
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
// Override with AIGENT_SOCKET_DIR to run multiple instances (e.g. dev + tests).
export const SOCKET_DIR = process.env['AIGENT_SOCKET_DIR'] ?? '/tmp/aigent';
export const SOCKET_PATH = `${SOCKET_DIR}/worker.sock`;
