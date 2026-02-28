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
  | { type: 'config_write_response'; id: string; ok: boolean; message: string }
  | { type: 'edit_file_response'; id: string; ok: boolean; message: string }
  | { type: 'exec_response'; id: string; ok: boolean; alwaysAllow?: boolean; message: string }
  | { type: 'fetch_response'; id: string; ok: boolean; alwaysAllow?: boolean; message: string }
  | { type: 'file_access_response'; id: string; ok: boolean; message: string }
  | { type: 'fetch_size_response'; id: string; ok: boolean; approvedBytes: number; message: string }
  | { type: 'mcp_tool_response'; id: string; ok: boolean; message: string }
  | { type: 'screenshot_response'; id: string; ok: boolean; data?: string; mediaType?: string; message: string }
  | { type: 'screen_share_response'; id: string; ok: boolean; message: string }
  | { type: 'host_state' }
  | { type: 'context_breakdown_request' }
  | { type: 'browser_ext_result'; id: string; ok: boolean; treeText?: string; dataUrl?: string; tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[]; stepsCompleted?: number; totalSteps?: number; finalUrl?: string; finalTitle?: string; newTabId?: number; error?: string }
  | { type: 'browser_write_response'; id: string; ok: boolean; message: string }
  | { type: 'browser_error'; level: 'warn' | 'error'; message: string; source?: string }
  | { type: 'user_question_response'; id: string; answer: string; selectedOptions?: string[]; dismissed: boolean }
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
  delivery?: 'agent-review' | 'user-pull' | 'agent-batch';
  /** Raw result text — only set for user-pull tasks so the UI can display it. */
  result?: string;
}

export interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: ThinkingLevel;
  short: boolean;
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
  | { type: 'tool_images'; images: { mediaType: string; data: string }[] }
  | { type: 'tool_end' }
  | { type: 'message'; message: DisplayMessage }
  | { type: 'system'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'state'; thinking?: ThinkingLevel; profile?: string; sessionId?: string; model?: string; short?: boolean; availableModels?: string[] }
  | { type: 'task_update'; task: BackgroundTaskInfo }
  | { type: 'config_write_request'; id: string; file: string; content: string; reason: string }
  | { type: 'edit_file_request'; id: string; path: string; edits: Array<{ old_str: string; new_str: string; index?: number }>; reason: string }
  | { type: 'patch_request'; id: string; diff: string; reason: string }
  | { type: 'exec_request'; id: string; command: string; segments?: import('./safety.js').CommandSegment[] }
  | { type: 'fetch_request'; id: string; url: string; method?: string }
  | { type: 'file_access_request'; id: string; path: string; operation: 'read' | 'write'; reason: string }
  | { type: 'fetch_size_request'; id: string; url: string; requestedBytes: number; defaultBytes: number }
  | { type: 'mcp_tool_request'; id: string; server: string; tool: string; params: string }
  | { type: 'screenshot_request'; id: string }
  | { type: 'screen_share_request'; id: string }
  | { type: 'host_state'; capabilities?: Record<string, { grant: string; available: boolean }>; ttsAvailable?: boolean; sttAvailable?: boolean }
  | { type: 'client_settings'; settings: Record<string, boolean | number | string> }
  | { type: 'context_breakdown'; breakdown: ContextBreakdown }
  | { type: 'browser_ext_request'; id: string; action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab'; tabId?: number; rootSelector?: string; steps?: unknown[]; url?: string }
  | { type: 'browser_write_request'; id: string; action: 'run_script' | 'navigate' | 'open_tab' | 'close_tab'; stepSummary: string; tabUrl?: string; steps?: unknown[]; url?: string; autonomousCmd?: string }
  | { type: 'browser_error'; level: 'warn' | 'error'; message: string; source?: string }
  | { type: 'classifier_decision'; tier: 1 | 2 | 3; action: 'allow' | 'block' | 'ask'; reason: string }
  | { type: 'user_question_request'; id: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowFreeText?: boolean }
  | { type: 'reset' }
  | { type: 'pong' };

// --- Worker → Gatekeeper (capability requests) ---

export type WorkerRequest =
  | { type: 'capability_request'; id: string; capability: string; params: Record<string, unknown>; reason?: string };

// --- Gatekeeper → Worker (responses to requests) ---

export type GatekeeperResponse =
  | { type: 'capability_response'; id: string; ok: boolean; result?: unknown; message: string };

// Socket directory — shared mount between host and container.
// The worker creates its socket here; the gatekeeper connects from the host.
// Override with AIGENT_SOCKET_DIR to run multiple instances (e.g. dev + tests).
export const SOCKET_DIR = process.env['AIGENT_SOCKET_DIR'] ?? '/tmp/aigent';
export const SOCKET_PATH = `${SOCKET_DIR}/worker.sock`;
