// Types mirrored from the server protocol

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  contextTokens?: number;
}

export type TraceEntry = ThinkingTrace | ToolTrace;

export interface ThinkingTrace {
  id: string;
  type: 'thinking';
  text: string;
  running: boolean;
}

export interface ToolTrace {
  id: string;
  type: 'tool';
  toolName: string;
  toolSummary: string;
  toolInput: string;
  toolOutput: string;
  running: boolean;
}

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  elapsed?: number;
  traces?: TraceEntry[];
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
  result?: string;
}

export interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: string;
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

export interface ToolSummaryRecord {
  toolCallId: string;
  toolName: string;
  originalTokens: number;
  summarizedTokens: number;
  savedTokens: number;
  fullOutputPath: string;
  summary: string;
}

export interface ContextBreakdown {
  systemBase: number;
  systemBaseContent?: string;
  workspaceContext: number;
  workspaceContent?: string;
  toolDefs: number;
  toolDefsContent?: string;
  messages: { role: string; tokens: number; preview?: string; summaryRecord?: ToolSummaryRecord }[];
  messagesTotal: number;
  total: number;
  totalSummarySavedTokens?: number;
  toolSummariesCount?: number;
}

export interface CommandSegment {
  raw: string;
  operator: '|' | '||' | '&&' | ';' | null;
  executable: string | null;
  isSubshell: boolean;
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
  | { type: 'state'; thinking?: string; profile?: string; sessionId?: string; model?: string; concise?: boolean; availableModels?: string[] }
  | { type: 'task_update'; task: BackgroundTaskInfo }
  | { type: 'mount_request'; id: string; path: string; mode: string; reason?: string; durationMinutes?: number }
  | { type: 'config_write_request'; id: string; file: string; content: string; reason: string }
  | { type: 'patch_request'; id: string; diff: string; reason: string }
  | { type: 'exec_request'; id: string; command: string; segments?: CommandSegment[] }
  | { type: 'fetch_request'; id: string; url: string; method?: string }
  | { type: 'screenshot_request'; id: string }
  | { type: 'screen_share_request'; id: string }
  | { type: 'host_state'; mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[]; capabilities?: Record<string, string> }
  | { type: 'client_settings'; settings: Record<string, boolean | number | string> }
  | { type: 'context_breakdown'; breakdown: ContextBreakdown }
  | { type: 'pong' };

export interface CommandDef {
  name: string;
  desc: string;
  argHint?: string;
}

export interface DiffFile {
  name: string;
  path: string;
  content: string;
}

export interface PermRequest {
  type: 'mount' | 'config_write' | 'patch' | 'exec' | 'fetch';
  id: string;
  title: string;
  detail: string;
  body?: string;
  segments?: CommandSegment[];
  approveCmd: string;
  denyCmd: string;
  alwaysAllowCmd?: string;
  alwaysAllowDomainCmd?: string;
  durationMinutes?: number;
  diff?: string;
  diffFiles?: DiffFile[];
}

export interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  data: string;
  dataUrl?: string;
  size: number;
}

export interface AtItem {
  icon: string;
  label: string;
  desc: string;
  insert: string;
  isFile?: boolean;
}

export interface MountInfo {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
  expiresAt?: number;
  durationMinutes?: number;
}
