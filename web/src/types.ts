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

export interface ClassifierMeta {
  tier: 1 | 2 | 3;
  action: 'allow' | 'block' | 'ask';
  reason: string;
}

export interface ToolTrace {
  id: string;
  type: 'tool';
  toolName: string;
  toolSummary: string;
  toolInput: string;
  toolOutput: string;
  running: boolean;
  model?: string;
  thinking?: string;
  classifierMeta?: ClassifierMeta;
  images?: { mediaType: string; data: string }[];
}

export interface DisplayAttachment {
  name: string;
  mediaType: string;
  thumbnail?: string; // data:image/jpeg;base64,... (small ~200px JPEG for chat display)
}

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  elapsed?: number;
  traces?: TraceEntry[];
  attachments?: DisplayAttachment[];
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
  result?: string;
}

export interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: string;
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
  | { type: 'tool_start'; name: string; input: string; summary: string; model?: string; thinking?: string }
  | { type: 'tool_output'; content: string }
  | { type: 'tool_images'; images: { mediaType: string; data: string }[] }
  | { type: 'tool_end' }
  | { type: 'message'; message: DisplayMessage }
  | { type: 'system'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'state'; thinking?: string; profile?: string; sessionId?: string; model?: string; short?: boolean; availableModels?: string[] }
  | { type: 'task_update'; task: BackgroundTaskInfo }
  | { type: 'config_write_request'; id: string; file: string; content: string; reason: string }
  | { type: 'patch_request'; id: string; diff: string; reason: string }
  | { type: 'exec_request'; id: string; command: string; segments?: CommandSegment[] }
  | { type: 'fetch_request'; id: string; url: string; method?: string }
  | { type: 'file_access_request'; id: string; path: string; operation: 'read' | 'write'; reason: string }
  | { type: 'fetch_size_request'; id: string; url: string; requestedBytes: number; defaultBytes: number }
  | { type: 'mcp_tool_request'; id: string; server: string; tool: string; params: string }
  | { type: 'screenshot_request'; id: string }
  | { type: 'screen_share_request'; id: string }
  | { type: 'host_state'; capabilities?: Record<string, { grant: string; available: boolean }>; ttsAvailable?: boolean; sttAvailable?: boolean }
  | { type: 'client_settings'; settings: Record<string, boolean | number | string> }
  | { type: 'context_breakdown'; breakdown: ContextBreakdown }
  | { type: 'browser_write_request'; id: string; action: 'run_script' | 'navigate' | 'open_tab' | 'close_tab'; stepSummary: string; tabUrl?: string; autonomousCmd?: string }
  | { type: 'browser_error'; level: 'warn' | 'error'; message: string; source?: string }
  | { type: 'classifier_decision'; tier: 1 | 2 | 3; action: 'allow' | 'block' | 'ask'; reason: string }
  | { type: 'user_question_request'; id: string; question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowFreeText?: boolean }
  | { type: 'perm_dismissed'; ids: string[] }
  | { type: 'reset' }
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
  type: 'config_write' | 'patch' | 'exec' | 'fetch' | 'file_access' | 'fetch_size' | 'mcp_tool' | 'browser_write' | 'user_question';
  id: string;
  title: string;
  detail: string;
  body?: string;
  segments?: CommandSegment[];
  approveCmd: string;
  denyCmd: string;
  alwaysAllowCmd?: string;
  alwaysAllowDomainCmd?: string;
  autonomousCmd?: string;
  durationMinutes?: number;
  fallbackHint?: string;
  diff?: string;
  diffFiles?: DiffFile[];
  questionOptions?: { label: string; description?: string }[];
  questionMultiSelect?: boolean;
  questionAllowFreeText?: boolean;
}

export interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  data: string;
  dataUrl?: string;
  thumbnail?: string; // small data URL for persisting in chat history
  size: number;
}

export interface AtItem {
  icon: string;
  label: string;
  desc: string;
  insert: string;
  isFile?: boolean;
  isDir?: boolean;
}

