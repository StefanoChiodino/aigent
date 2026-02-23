/**
 * Agent backend server.
 *
 * Runs the agent, processes commands, streams events to connected TUI clients
 * over a Unix socket using newline-delimited JSON.
 *
 * On restart (code change), auto-saves conversation state and reloads it,
 * so the TUI can reconnect seamlessly.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { Agent, type ThinkingLevel } from './agent.js';
import { listProfiles, getProfilePath, listSessions, saveSession, loadSession, generateSessionId, autoSaveSession, autoLoadSession, clearAutoSave } from './profiles.js';
import type { ProviderMessage, UserContent, TextContent, ImageContent, DocumentContent, ImageMediaType, ToolResult } from './provider.js';
import type { ClientCommand, ServerEvent, DisplayMessage, ServerState, TokenUsage } from './protocol.js';
import { SOCKET_PATH } from './protocol.js';
import { computeCost } from './pricing.js';
import { distillToMemory } from './compact.js';
import { loadMCP, type MCPManager } from './mcp.js';
import { createLogger } from './logger.js';
import { execReadonlyTool, fetchReadonlyTool, getToolDefinitions } from './tools.js';
import type { ProviderToolDef } from './provider.js';

const log = createLogger('server');

const VALID_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

// Default model list — used until the provider reports its own list.
// Ordered most capable → fastest/cheapest.
let AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

// --- Image support ---

const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_PATH_REGEX = /(?:^|\s)(\/\S+\.(?:png|jpg|jpeg|gif|webp))\b/gi;

function getImageMediaType(path: string): ImageMediaType | null {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

function readImageBase64(filePath: string): { data: string; mediaType: ImageMediaType } | null {
  const resolved = resolve(filePath);
  const mediaType = getImageMediaType(resolved);
  if (!mediaType) return null;
  try {
    const buffer = readFileSync(resolved);
    return { data: buffer.toString('base64'), mediaType };
  } catch {
    return null;
  }
}

// --- Attachment support ---

const IMAGE_TYPES_SET = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/javascript', 'application/typescript',
  'application/xml', 'application/yaml', 'application/x-yaml',
  'application/toml', 'application/x-sh',
]);

function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || TEXT_MIME_TYPES.has(mime);
}

const MAX_TEXT_FILE_SIZE = 500_000; // ~500KB decoded text limit

/**
 * Parse a user message for image file paths.
 * Returns UserContent — either a plain string (no images) or a mixed content array.
 */
function parseImagesInMessage(text: string): UserContent {
  const matches: { path: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  IMAGE_PATH_REGEX.lastIndex = 0;
  while ((match = IMAGE_PATH_REGEX.exec(text)) !== null) {
    const path = match[1]!;
    // Verify file exists and is a valid image
    if (existsSync(path)) {
      const fullMatchStart = match.index + match[0].indexOf(path);
      matches.push({ path, start: fullMatchStart, end: fullMatchStart + path.length });
    }
  }

  if (matches.length === 0) return text;

  const parts: (TextContent | ImageContent)[] = [];
  let lastEnd = 0;

  for (const m of matches) {
    // Add text before this image
    if (m.start > lastEnd) {
      const textBefore = text.slice(lastEnd, m.start).trim();
      if (textBefore) parts.push({ type: 'text', text: textBefore });
    }

    const img = readImageBase64(m.path);
    if (img) {
      parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
    } else {
      // Failed to read — keep as text
      parts.push({ type: 'text', text: m.path });
    }
    lastEnd = m.end;
  }

  // Add remaining text
  if (lastEnd < text.length) {
    const remaining = text.slice(lastEnd).trim();
    if (remaining) parts.push({ type: 'text', text: remaining });
  }

  // If no images were actually loaded, return plain string
  if (parts.every((p) => p.type === 'text')) {
    return text;
  }

  // Ensure there's at least one text block (API requirement)
  if (!parts.some((p) => p.type === 'text')) {
    parts.push({ type: 'text', text: 'Describe this image.' });
  }

  return parts;
}

// --- State ---

let agent: Agent;
let agentProvider: import('./provider.js').Provider | undefined;
let messages: DisplayMessage[] = [];
let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let currentThinking: ThinkingLevel;
let savedEffortLevel: ThinkingLevel = 'high';
let currentConcise = false;
let currentProfile = 'default';
let currentSessionId = generateSessionId();
let model: string;
let workspacePath: string;
let isLoading = false;
let isProcessingTaskResult = false;
let abortController: AbortController | null = null;
const clients = new Set<Socket>();

// --- Mount request handling ---

// Cache of currently active mounts to avoid duplicate requests
let activeMounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[] = [];

const pendingMountRequests = new Map<string, {
  path: string;
  mode: 'ro' | 'rw';
  reason?: string;
  durationMinutes?: number;
  resolve: (response: { ok: boolean; containerPath?: string; message: string }) => void;
}>();
let mountRequestCounter = 0;

/**
 * Send a mount request to the gatekeeper (via the socket) and wait for approval.
 * Called by the request_mount tool.
 */
export function requestMount(
  path: string,
  mode: 'ro' | 'rw',
  reason?: string,
  durationMinutes?: number,
): Promise<{ ok: boolean; containerPath?: string; message: string }> {
  const id = `mount_${++mountRequestCounter}`;
  
  // Check if this mount already exists
  // Note: rw mode satisfies ro requests, but not vice versa
  const existingMount = activeMounts.find(mount => 
    mount.hostPath === path && 
    (mount.mode === mode || (mount.mode === 'rw' && mode === 'ro'))
  );
  
  if (existingMount) {
    // Return success immediately without triggering UI
    const contextNote = `Mount already active: ${path} (${existingMount.mode})`;
    log.info(contextNote);
    return Promise.resolve({ ok: true, containerPath: existingMount.containerPath, message: contextNote });
  }

  return new Promise((resolve) => {
    // Timeout after 60s
    const timer = setTimeout(() => {
      pendingMountRequests.delete(id);
      resolve({ ok: false, message: 'Mount request timed out (60s)' });
    }, 60_000);

    pendingMountRequests.set(id, {
      path,
      mode,
      ...(reason !== undefined ? { reason } : {}),
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    // Send to gatekeeper via the socket
    broadcast({
      type: 'mount_request', id, path, mode,
      ...(reason !== undefined ? { reason } : {}),
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
    });
  });
}

function resolveMountRequest(id: string, response: { ok: boolean; containerPath?: string; message: string }): void {
  const pending = pendingMountRequests.get(id);
  if (pending) {
    pendingMountRequests.delete(id);
    pending.resolve(response);
  }
}

// --- Exec command approval handling ---

const pendingExecRequests = new Map<string, {
  command: string;
  resolve: (response: { ok: boolean; alwaysAllow: boolean; message: string }) => void;
}>();
let execApprovalCounter = 0;

/**
 * Request user approval before running a shell command.
 * Called by the exec tool when a command requires prompt-level permission.
 * If signal is already aborted, or fires before the user responds, resolves
 * immediately with ok:false so the agent can unblock and handle the abort.
 */
export function requestExecApproval(command: string, signal?: AbortSignal): Promise<{ ok: boolean; alwaysAllow: boolean; message: string }> {
  const id = `exec_${++execApprovalCounter}`;

  // Already aborted — skip the UI prompt entirely
  if (signal?.aborted) {
    return Promise.resolve({ ok: false, alwaysAllow: false, message: 'Aborted by user' });
  }

  return new Promise((resolve) => {
    const finish = (response: { ok: boolean; alwaysAllow: boolean; message: string }) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pendingExecRequests.delete(id);
      resolve(response);
    };

    const onAbort = () => finish({ ok: false, alwaysAllow: false, message: 'Aborted by user' });

    const timer = setTimeout(() => {
      finish({ ok: false, alwaysAllow: false, message: 'Exec approval request timed out (60s)' });
    }, 60_000);

    pendingExecRequests.set(id, { command, resolve: finish });

    signal?.addEventListener('abort', onAbort, { once: true });

    broadcast({ type: 'exec_request', id, command });
  });
}

function resolveExecRequest(id: string, response: { ok: boolean; alwaysAllow: boolean; message: string }): void {
  const pending = pendingExecRequests.get(id);
  if (pending) {
    pendingExecRequests.delete(id);
    pending.resolve(response);
  }
}

// --- Fetch URL approval handling ---

const pendingFetchRequests = new Map<string, {
  url: string;
  method?: string;
  resolve: (response: { ok: boolean; alwaysAllow: boolean; message: string }) => void;
}>();
let fetchApprovalCounter = 0;

/**
 * Request user approval before fetching a URL.
 * Called by the fetch tool when a URL requires prompt-level permission.
 */
export function requestFetchApproval(url: string, method?: string, signal?: AbortSignal): Promise<{ ok: boolean; alwaysAllow: boolean; message: string }> {
  const id = `fetch_${++fetchApprovalCounter}`;

  if (signal?.aborted) {
    return Promise.resolve({ ok: false, alwaysAllow: false, message: 'Aborted by user' });
  }

  return new Promise((resolve) => {
    const finish = (response: { ok: boolean; alwaysAllow: boolean; message: string }) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pendingFetchRequests.delete(id);
      resolve(response);
    };

    const onAbort = () => finish({ ok: false, alwaysAllow: false, message: 'Aborted by user' });

    const timer = setTimeout(() => {
      finish({ ok: false, alwaysAllow: false, message: 'Fetch approval request timed out (60s)' });
    }, 60_000);

    pendingFetchRequests.set(id, { url, ...(method !== undefined ? { method } : {}), resolve: finish });

    signal?.addEventListener('abort', onAbort, { once: true });

    broadcast({ type: 'fetch_request', id, url, ...(method ? { method } : {}) });
  });
}

function resolveFetchRequest(id: string, response: { ok: boolean; alwaysAllow: boolean; message: string }): void {
  const pending = pendingFetchRequests.get(id);
  if (pending) {
    pendingFetchRequests.delete(id);
    pending.resolve(response);
  }
}

// --- Browser screen share + screenshot request handling ---

const pendingScreenShareRequests = new Map<string, {
  resolve: (response: { ok: boolean; message: string }) => void;
}>();
const pendingScreenshotRequests = new Map<string, {
  resolve: (response: { ok: boolean; data?: string; mediaType?: string; message: string }) => void;
}>();
let screenshotRequestCounter = 0;

/**
 * Ask the browser to start screen sharing (opens the OS picker).
 * Resolves once the user picks a source (or cancels).
 */
export function requestBrowserScreenShare(): Promise<{ ok: boolean; message: string }> {
  const id = `ss_${++screenshotRequestCounter}`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingScreenShareRequests.delete(id);
      resolve({ ok: false, message: 'Screen share request timed out (60s)' });
    }, 60_000);

    pendingScreenShareRequests.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    broadcast({ type: 'screen_share_request', id });
  });
}

function resolveScreenShareRequest(id: string, response: { ok: boolean; message: string }): void {
  const pending = pendingScreenShareRequests.get(id);
  if (pending) {
    pendingScreenShareRequests.delete(id);
    pending.resolve(response);
  }
}

/**
 * Ask the browser to capture a frame from its active screen share.
 * If screen sharing isn't active, automatically requests the user start sharing first.
 * Called by the request_screenshot tool.
 */
export async function requestBrowserScreenshot(): Promise<{ ok: boolean; data?: string; mediaType?: string; message: string }> {
  const id = `sc_${++screenshotRequestCounter}`;

  // Try screenshot directly — if screen share isn't active, the browser will reply with ok:false
  const result = await new Promise<{ ok: boolean; data?: string; mediaType?: string; message: string }>((resolve) => {
    const timer = setTimeout(() => {
      pendingScreenshotRequests.delete(id);
      resolve({ ok: false, message: 'Screenshot request timed out (30s)' });
    }, 30_000);

    pendingScreenshotRequests.set(id, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    broadcast({ type: 'screenshot_request', id });
  });

  if (result.ok) return result;

  // Screen share wasn't active — ask the browser to start it now
  const shareResult = await requestBrowserScreenShare();
  if (!shareResult.ok) {
    return { ok: false, message: shareResult.message };
  }

  // Retry screenshot now that sharing is active
  const retryId = `sc_${++screenshotRequestCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingScreenshotRequests.delete(retryId);
      resolve({ ok: false, message: 'Screenshot request timed out after starting screen share (30s)' });
    }, 30_000);

    pendingScreenshotRequests.set(retryId, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    broadcast({ type: 'screenshot_request', id: retryId });
  });
}

function resolveScreenshotRequest(id: string, response: { ok: boolean; data?: string; mediaType?: string; message: string }): void {
  const pending = pendingScreenshotRequests.get(id);
  if (pending) {
    pendingScreenshotRequests.delete(id);
    pending.resolve(response);
  }
}

// --- Config write request handling ---

const pendingConfigWriteRequests = new Map<string, {
  file: string;
  content: string;
  reason: string;
  resolve: (response: { ok: boolean; message: string }) => void;
}>();
let configWriteCounter = 0;

/**
 * Send a config write request to the gatekeeper and wait for approval.
 * The gatekeeper shows a diff to the user, who approves or denies.
 */
export function requestConfigWrite(
  file: string,
  content: string,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  const id = `config_${++configWriteCounter}`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingConfigWriteRequests.delete(id);
      resolve({ ok: false, message: 'Config write request timed out (60s)' });
    }, 60_000);

    pendingConfigWriteRequests.set(id, {
      file,
      content,
      reason,
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    broadcast({ type: 'config_write_request', id, file, content, reason });
  });
}

function resolveConfigWriteRequest(id: string, response: { ok: boolean; message: string }): void {
  const pending = pendingConfigWriteRequests.get(id);
  if (pending) {
    pendingConfigWriteRequests.delete(id);
    pending.resolve(response);
  }
}

// --- Host edit-file request handling ---

const pendingEditFileRequests = new Map<string, {
  path: string;
  edits: Array<{ old_str: string; new_str: string; index?: number }>;
  reason: string;
  resolve: (response: { ok: boolean; message: string }) => void;
}>();
let editFileCounter = 0;

/**
 * Send a host_edit_file request to the gatekeeper and wait for approval.
 * The gatekeeper matches eagerly, builds a diff, shows it to the user, who approves or denies.
 */
export function requestHostEditFile(
  path: string,
  edits: Array<{ old_str: string; new_str: string; index?: number }>,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  const id = `edit_${++editFileCounter}`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingEditFileRequests.delete(id);
      resolve({ ok: false, message: 'Edit request timed out (120s)' });
    }, 120_000);

    pendingEditFileRequests.set(id, {
      path,
      edits,
      reason,
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
    });

    broadcast({ type: 'edit_file_request', id, path, edits, reason });
  });
}

function resolveEditFileRequest(id: string, response: { ok: boolean; message: string }): void {
  const pending = pendingEditFileRequests.get(id);
  if (pending) {
    pendingEditFileRequests.delete(id);
    pending.resolve(response);
  }
}

// --- Background task queue ---

import { TaskQueue } from './tasks.js';

const taskQueue = new TaskQueue({
  onTaskUpdate: (task) => {
    broadcast({ type: 'task_update', task });
  },
  onResultReady: () => {
    // If the main agent is idle, kick off result processing
    if (!isLoading && !processingQueue) {
      void processTaskResults();
    }
  },
});

/**
 * Process completed task results one at a time.
 * Each result triggers a full agent turn so the main agent can reason about
 * the findings and present them to the user.
 *
 * Results appear as system messages (not user messages), then the agent
 * is asked to review and summarize.
 */
async function processTaskResults(): Promise<void> {
  while (taskQueue.hasPendingResults()) {
    const result = taskQueue.drainNext();
    if (!result) break;

    // Yield to user messages — they take priority
    if (isLoading || messageQueue.length > 0) break;

    // user-pull tasks are surfaced via the sidebar — the agent is not involved
    if (result.delivery === 'user-pull') {
      taskQueue.prune();
      continue;
    }

    const statusLabel = result.status === 'completed' ? 'completed' : 'FAILED';
    const secs = ((new Date(result.completedAt).getTime() - new Date(result.startedAt).getTime()) / 1000).toFixed(1);
    // Now trigger an agent turn to process the result.
    // The agent sees it as a user message asking for review.
    const reviewPrompt = [
      `A background task just completed. Here are the results:`,
      '',
      `Task: ${result.description}`,
      `Status: ${statusLabel}`,
      `Duration: ${secs}s`,
      '',
      result.result,
      '',
      'Summarize the key findings and let me know if anything needs my attention.',
    ].join('\n');

    await processAgentTurn(reviewPrompt, { isTaskResult: true });

    // Prune old tasks periodically
    taskQueue.prune();
  }
}

/**
 * Run a single agent turn. Used by user messages, image commands, and task result processing.
 *
 * @param content - Text content or pre-built UserContent (for images)
 * @param opts.isTaskResult - Don't display as a user message (task result injection)
 * @param opts.displayText - Custom display text for the user message (e.g., "[image: path]")
 */
async function processAgentTurn(
  content: string | UserContent,
  opts: { isTaskResult?: boolean; displayText?: string } = {},
): Promise<void> {
  const { isTaskResult = false, displayText } = opts;

  if (!isTaskResult) {
    const text = displayText ?? (typeof content === 'string' ? content : '[message with attachments]');
    const userMsg: DisplayMessage = { role: 'user', content: text, timestamp: new Date().toISOString() };
    messages.push(userMsg);
    broadcast({ type: 'message', message: userMsg });
  }

  isLoading = true;
  isProcessingTaskResult = isTaskResult;
  broadcast({ type: 'loading', isLoading: true });
  log.info('Agent turn start', { isTaskResult });

  const controller = new AbortController();
  abortController = controller;
  const startTime = Date.now();

  // Parse for images only if it's a plain text user message
  const userContent = typeof content === 'string' && !isTaskResult
    ? parseImagesInMessage(content)
    : content;

  try {
    const response = await agent.chat(userContent, {
      signal: controller.signal,
      onText: (text) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'text', content: text });
      },
      onThinking: (text) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'thinking', content: text });
      },
      onToolStart: (name, toolInput, summary) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_start', name, input: toolInput, summary });
      },
      onToolOutput: (toolContent) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_output', content: toolContent });
      },
      onToolEnd: () => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_end' });
      },
      onUsage: (u) => {
        usage = { ...u, cost: computeCost(model, u) };
        broadcast({ type: 'usage', usage });
      },
      onCompact: (summary) => {
        addSystemMessage(`Context compacted: ${summary.slice(0, 200)}...`);
      },
      onDispatchTask: (input) => dispatchBackgroundTask(input as { task: string; context?: string; model?: string; thinking?: ThinkingLevel; max_iterations?: number; capabilities?: string[]; delivery?: 'agent-review' | 'user-pull' }),
      onModelSwitch: (newModel, reason) => {
        model = newModel;
        agent.currentModel = newModel;
        addSystemMessage(reason ? `Model switched to ${newModel}: ${reason}` : `Model switched to ${newModel}`);
        broadcast({ type: 'state', model: newModel });
        doAutoSave();
      },
    });

    if (!controller.signal.aborted) {
      const elapsed = (Date.now() - startTime) / 1000;
      log.info('Agent turn complete', { elapsed, messages: messages.length });
      broadcast({ type: 'text', content: '' });
      const assistantMsg: DisplayMessage = {
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
        elapsed,
      };
      messages.push(assistantMsg);
      broadcast({ type: 'message', message: assistantMsg });
      doAutoSave();
    }
  } catch (err: unknown) {
    if (!controller.signal.aborted) {
      const e = err as { status?: number; message?: string };
      let errorMsg = e.message ?? 'Unknown error';
      if (e.status === 401) errorMsg = 'Authentication failed. Check ANTHROPIC_API_KEY.';
      if (e.status === 429) errorMsg = 'Rate limited. Wait a moment.';
      broadcast({ type: 'error', message: errorMsg });
    }
  } finally {
    abortController = null;
    isLoading = false;
    isProcessingTaskResult = false;
    broadcast({ type: 'loading', isLoading: false });
  }
}

/**
 * Build the tool set for a background agent based on granted capabilities.
 *
 * Default (no capabilities): read-only filesystem, no network.
 * Capabilities:
 *   net_ro   — fetch URLs (GET/HEAD only)
 *   net_rw   — fetch URLs (all HTTP methods)
 *   fs_write — write/edit files + full shell exec
 */
function buildBackgroundToolSet(allTools: ProviderToolDef[], capabilities: Set<string>): ProviderToolDef[] {
  // Always blocked — no recursion, no host interaction
  const blocked = new Set([
    'spawn_agent', 'dispatch_task',
    'request_mount', 'request_config_write',
    'host', 'screenshot', 'request_screenshot',
  ]);

  // Without fs_write: block write tools, swap exec → exec_readonly
  if (!capabilities.has('fs_write')) {
    blocked.add('write_file');
    blocked.add('edit_file');
    blocked.add('patch');
    blocked.add('exec');
  }

  // Without any net capability: block fetch entirely
  if (!capabilities.has('net_ro') && !capabilities.has('net_rw')) {
    blocked.add('fetch');
  }

  const tools = allTools.filter((t) => !blocked.has(t.name));

  // Inject restricted variants
  if (!capabilities.has('fs_write')) {
    tools.push(execReadonlyTool);
  }
  if (capabilities.has('net_ro') && !capabilities.has('net_rw')) {
    // Replace full fetch with read-only fetch
    const idx = tools.findIndex((t) => t.name === 'fetch');
    if (idx >= 0) tools.splice(idx, 1, fetchReadonlyTool);
  }

  return tools;
}

/**
 * Dispatch a task to a background agent. Runs independently of the main
 * conversation. When complete, the result is queued for the main agent
 * to review and present to the user.
 *
 * Background agents are capability-restricted by default (read-only, no network).
 * The caller can grant additional capabilities via the `capabilities` field.
 */
function thinkingForModel(m: string): ThinkingLevel {
  if (m.includes('haiku')) return 'off';
  if (m.includes('sonnet')) return 'low';
  return 'high';
}

function dispatchBackgroundTask(input: {
  task: string;
  context?: string;
  model?: string;
  thinking?: ThinkingLevel;
  max_iterations?: number;
  capabilities?: string[];
  delivery?: 'agent-review' | 'user-pull';
}): string {
  const taskId = taskQueue.register(input.task, input.delivery ?? 'agent-review');

  // Fire and forget — run the sub-agent in the background
  void (async () => {
    try {
      const taskModel = input.model ?? model;
      const taskThinking: ThinkingLevel = input.thinking ?? thinkingForModel(taskModel);
      const maxIter = Math.min(input.max_iterations ?? 25, 50);
      const capabilities = new Set(input.capabilities ?? []);

      // Build capability-restricted tool set
      const subToolDefs = buildBackgroundToolSet(agent.getToolDefs(), capabilities);
      const toolNames = subToolDefs.map((t) => t.name).join(', ');

      const systemPrompt = [
        'You are a background research agent dispatched to complete a specific task.',
        'Work independently and return a clear, complete result.',
        '',
        capabilities.has('fs_write')
          ? 'You have read-write filesystem access and full shell exec.'
          : 'IMPORTANT: You are READ-ONLY. You CANNOT modify files, run destructive commands,\nor change repository state (no git commit/push/stash/checkout, no rm/mv/cp, no file writes).',
        '',
        `Available tools: ${toolNames}`,
        '',
        'Do NOT spawn further agents or dispatch tasks.',
        '',
        `Task: ${input.task}`,
        input.context ? `\nContext: ${input.context}` : '',
      ].join('\n');

      const { executeTool } = await import('./tools.js');

      // Reuse the agent's provider (SocketProvider in gatekeeper mode).
      // Creating a direct provider would fail in the sandbox (no API keys).
      let subProvider: import('./provider.js').Provider;
      if (agentProvider) {
        subProvider = agentProvider;
      } else {
        const { createProvider, detectProvider } = await import('./provider.js');
        subProvider = createProvider(detectProvider());
      }

      const subMessages: ProviderMessage[] = [
        { role: 'user', content: input.task + (input.context ? `\n\nContext: ${input.context}` : '') },
      ];

      let iterations = 0;
      let finalText = '';
      let taskInputTokens = 0;
      let taskOutputTokens = 0;

      while (iterations < maxIter) {
        iterations++;
        log.debug('Dispatch iteration', { taskId, iteration: iterations, maxIter });

        const response = await subProvider.sendMessage(
          systemPrompt,
          subMessages,
          subToolDefs,
          { model: taskModel, maxTokens: 16384, thinking: taskThinking },
        );

        taskInputTokens += response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
        taskOutputTokens += response.usage.output;

        log.debug('Dispatch response', { taskId, stopReason: response.stopReason, toolCalls: response.toolCalls.length });

        subMessages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        });

        if (response.toolCalls.length === 0) {
          finalText = response.text;
          break;
        }

        const results: ToolResult[] = [];
        for (const tc of response.toolCalls) {
          log.debug('Dispatch tool', { taskId, tool: tc.name });
          const result = await executeTool(tc.name, tc.input as Parameters<typeof executeTool>[1], agent.usingOAuth);
          if (typeof result === 'string') {
            const truncated = result.length > 50_000
              ? result.slice(0, 50_000) + '\n\n... [truncated]'
              : result;
            results.push({ id: tc.id, content: truncated });
          } else {
            results.push({ id: tc.id, content: result });
          }
        }

        subMessages.push({ role: 'tool_result', results });
      }

      if (!finalText) finalText = '[background agent hit iteration limit]';

      // Compute cost for this task and roll it into the global session usage
      const taskUsageRaw = { input: taskInputTokens, output: taskOutputTokens, cacheRead: 0, cacheWrite: 0 };
      const taskCost = computeCost(taskModel, taskUsageRaw);
      usage = {
        ...usage,
        input: usage.input + taskInputTokens,
        output: usage.output + taskOutputTokens,
        cost: (usage.cost ?? 0) + taskCost,
      };
      broadcast({ type: 'usage', usage });

      taskQueue.complete(taskId, finalText, { model: taskModel, inputTokens: taskInputTokens, outputTokens: taskOutputTokens, cost: taskCost });

    } catch (err: unknown) {
      const e = err as { message?: string; stack?: string };
      log.error('Dispatch error', { taskId, error: e.message });
      taskQueue.fail(taskId, e.message ?? 'unknown error', { model: input.model ?? model });
    }
  })();

  return taskId;
}

// --- Persistent usage tracking ---

interface LifetimeUsage {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  sessions: number;
  firstUsed: string;
  lastUsed: string;
}

function getUsagePath(): string {
  return join(workspacePath, 'usage.json');
}

function loadLifetimeUsage(): LifetimeUsage {
  try {
    const raw = readFileSync(getUsagePath(), 'utf-8');
    return JSON.parse(raw) as LifetimeUsage;
  } catch {
    return {
      totalInput: 0, totalOutput: 0, totalCacheRead: 0, totalCacheWrite: 0,
      sessions: 0, firstUsed: new Date().toISOString(), lastUsed: new Date().toISOString(),
    };
  }
}

function saveLifetimeUsage(sessionUsage: TokenUsage): void {
  const lifetime = loadLifetimeUsage();
  lifetime.totalInput += sessionUsage.input;
  lifetime.totalOutput += sessionUsage.output;
  lifetime.totalCacheRead += sessionUsage.cacheRead;
  lifetime.totalCacheWrite += sessionUsage.cacheWrite;
  lifetime.sessions++;
  lifetime.lastUsed = new Date().toISOString();
  try {
    writeFileSync(getUsagePath(), JSON.stringify(lifetime, null, 2) + '\n', 'utf-8');
  } catch {
    // Non-critical
  }
}

function formatLifetimeUsage(): string {
  const lt = loadLifetimeUsage();
  const total = lt.totalInput + lt.totalOutput;
  const fmt = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return String(n);
  };

  const sessionTotal = usage.input + usage.output;
  const lines = [
    `This session:  ${fmt(sessionTotal)} tokens (${fmt(usage.input)} in, ${fmt(usage.output)} out)`,
    `Lifetime:      ${fmt(total + sessionTotal)} tokens across ${lt.sessions + 1} session(s)`,
    `  Input:       ${fmt(lt.totalInput + usage.input)}`,
    `  Output:      ${fmt(lt.totalOutput + usage.output)}`,
    `  Cache read:  ${fmt(lt.totalCacheRead + usage.cacheRead)}`,
    `  Cache write: ${fmt(lt.totalCacheWrite + usage.cacheWrite)}`,
    `First used:    ${lt.firstUsed.slice(0, 10)}`,
  ];
  return lines.join('\n');
}

// --- Helpers ---

function send(socket: Socket, event: ServerEvent): void {
  try {
    socket.write(JSON.stringify(event) + '\n');
  } catch {
    // Client disconnected, will be cleaned up
  }
}

function broadcast(event: ServerEvent): void {
  for (const client of clients) {
    send(client, event);
  }
}

function addSystemMessage(content: string): void {
  const msg: DisplayMessage = { role: 'system', content, timestamp: new Date().toISOString() };
  messages.push(msg);
  broadcast({ type: 'system', content });
}

function getState(): ServerState {
  return {
    messages,
    usage,
    thinking: currentThinking,
    concise: currentConcise,
    profile: currentProfile,
    sessionId: currentSessionId,
    model,
    availableModels: AVAILABLE_MODELS,
    availableTools: getToolDefinitions(false).map((t) => t.name),
    isLoading,
    tasks: taskQueue.getInfos(),
    pendingResults: taskQueue.pendingCount,
  };
}

function doAutoSave(): void {
  try {
    autoSaveSession(workspacePath, agent.getMessages(), messages, usage, {
      current: currentThinking,
      savedEffort: savedEffortLevel,
    }, model, currentConcise);
  } catch {
    // Non-critical
  }
}

// --- Command handling ---

function handleCommand(cmd: string): boolean {
  const trimmed = cmd.trim();

  if (trimmed === '/reset') {
    // Distill to memory before wiping — best effort, non-blocking
    const messagesToDistill = agent.getMessages();
    if (messagesToDistill.length >= 4) {
      addSystemMessage('Distilling session to memory...');
      void distillToMemory(agent.underlyingProvider, agent.currentModel, messagesToDistill, workspacePath)
        .then(() => addSystemMessage('Memory updated.'))
        .catch(() => {}); // already logged inside distillToMemory
    }
    agent.reset();
    messages = [];
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    clearAutoSave(workspacePath);
    addSystemMessage('Conversation reset.');
    broadcast({ type: 'usage', usage });
    return true;
  }

  if (trimmed === '/refresh') {
    agent.reloadSystemPrompt();
    addSystemMessage('Workspace files reloaded.');
    return true;
  }

  if (trimmed === '/restart') {
    addSystemMessage('Restarting server...');
    // Brief delay so the client receives the message, then clean shutdown
    setTimeout(requestRestart, 200);
    return true;
  }

  if (trimmed === '/reasoning') {
    const isOn = currentThinking !== 'off';
    addSystemMessage(`Reasoning: ${isOn ? 'on' : 'off'}\nUsage: /reasoning on | /reasoning off`);
    return true;
  }

  if (trimmed === '/reasoning on') {
    if (currentThinking === 'off') {
      agent.thinkingLevel = savedEffortLevel;
      currentThinking = savedEffortLevel;
    }
    addSystemMessage(`Reasoning: on (${currentThinking})`);
    broadcast({ type: 'state', thinking: currentThinking });
    doAutoSave();
    return true;
  }

  if (trimmed === '/reasoning off') {
    if (currentThinking !== 'off') {
      savedEffortLevel = currentThinking;
    }
    agent.thinkingLevel = 'off';
    currentThinking = 'off';
    addSystemMessage('Reasoning: off');
    broadcast({ type: 'state', thinking: currentThinking });
    doAutoSave();
    return true;
  }

  if (trimmed === '/effort') {
    const effortLevels = VALID_THINKING_LEVELS.filter((l) => l !== 'off');
    addSystemMessage(`Effort: ${currentThinking === 'off' ? '(reasoning off)' : currentThinking}\nLevels: ${effortLevels.join(', ')}\nUsage: /effort <level>`);
    return true;
  }

  if (trimmed.startsWith('/effort ')) {
    const level = trimmed.split(' ')[1] as ThinkingLevel;
    const effortLevels: ThinkingLevel[] = ['low', 'medium', 'high', 'max'];
    if (effortLevels.includes(level)) {
      agent.thinkingLevel = level;
      currentThinking = level;
      addSystemMessage(`Effort: ${level}`);
      broadcast({ type: 'state', thinking: currentThinking });
      doAutoSave();
    } else {
      addSystemMessage(`Invalid effort. Options: ${effortLevels.join(', ')}`);
    }
    return true;
  }

  if (trimmed === '/concise') {
    addSystemMessage(`Concise mode: ${currentConcise ? 'on' : 'off'}\nUsage: /concise on | /concise off`);
    return true;
  }

  if (trimmed === '/concise on') {
    currentConcise = true;
    agent.setExtraSystemPrompt(buildExtraSystemPrompt());
    addSystemMessage('Concise mode: on');
    broadcast({ type: 'state', concise: true });
    return true;
  }

  if (trimmed === '/concise off') {
    currentConcise = false;
    agent.setExtraSystemPrompt(buildExtraSystemPrompt());
    addSystemMessage('Concise mode: off');
    broadcast({ type: 'state', concise: false });
    return true;
  }

  if (trimmed === '/profiles' || trimmed === '/profile list') {
    const profiles = listProfiles(workspacePath);
    if (profiles.length === 0) {
      addSystemMessage(`No profiles yet. Current: ${currentProfile}\nCreate one: /profile create <name>`);
    } else {
      const list = profiles.map((p) => `  ${p.name === currentProfile ? '>' : ' '} ${p.name}`).join('\n');
      addSystemMessage(`Profiles:\n${list}`);
    }
    return true;
  }

  if (trimmed.startsWith('/profile create ')) {
    const name = trimmed.slice('/profile create '.length).trim();
    if (!name || name.includes('/') || name.includes('..')) {
      addSystemMessage('Invalid profile name.');
      return true;
    }
    getProfilePath(workspacePath, name);
    addSystemMessage(`Profile "${name}" created. Switch to it: /profile ${name}`);
    return true;
  }

  if (trimmed.startsWith('/profile ') && !trimmed.startsWith('/profile list') && !trimmed.startsWith('/profile create')) {
    const name = trimmed.slice('/profile '.length).trim();
    const profileDir = getProfilePath(workspacePath, name);
    agent.reset();
    agent.reloadWorkspace(profileDir);
    currentProfile = name;
    currentSessionId = generateSessionId();
    messages = [];
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    addSystemMessage(`Switched to profile: ${name}`);
    broadcast({ type: 'state', profile: currentProfile, sessionId: currentSessionId });
    broadcast({ type: 'usage', usage });
    return true;
  }

  if (trimmed === '/save') {
    saveSession(workspacePath, currentProfile, currentSessionId, agent.getMessages());
    addSystemMessage(`Session saved: ${currentSessionId}`);
    return true;
  }

  if (trimmed === '/sessions') {
    const sessions = listSessions(workspacePath, currentProfile);
    if (sessions.length === 0) {
      addSystemMessage('No saved sessions. Use /save to save current session.');
    } else {
      const list = sessions.map((s) =>
        `  ${s.id === currentSessionId ? '>' : ' '} ${s.id} (${s.messageCount} msgs, ${s.lastActiveAt.slice(0, 10)})`
      ).join('\n');
      addSystemMessage(`Sessions (${currentProfile}):\n${list}`);
    }
    return true;
  }

  if (trimmed.startsWith('/load ')) {
    const sessionId = trimmed.slice('/load '.length).trim();
    const data = loadSession(workspacePath, currentProfile, sessionId);
    if (!data) {
      addSystemMessage(`Session not found: ${sessionId}`);
      return true;
    }
    agent.setMessages(data.messages as ProviderMessage[]);
    currentSessionId = sessionId;
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    addSystemMessage(`Loaded session: ${sessionId} (${data.messages.length} messages)`);
    broadcast({ type: 'state', sessionId: currentSessionId });
    broadcast({ type: 'usage', usage });
    return true;
  }

  if (trimmed.startsWith('/image ')) {
    const rest = trimmed.slice('/image '.length).trim();
    if (!rest) {
      addSystemMessage('Usage: /image <path> [message]\nExample: /image /tmp/screenshot.png What is this?');
      return true;
    }
    const spaceIdx = rest.indexOf(' ');
    const imgPath = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
    const imgText = spaceIdx > 0 ? rest.slice(spaceIdx + 1).trim() : 'Describe this image.';

    const img = readImageBase64(imgPath);
    if (!img) {
      addSystemMessage(`Cannot read image: ${imgPath}\nSupported formats: PNG, JPG, GIF, WebP`);
      return true;
    }

    const userContent: UserContent = [
      { type: 'image', mediaType: img.mediaType, data: img.data },
      { type: 'text', text: imgText },
    ];

    if (isLoading) {
      addSystemMessage('Cannot send image while processing. Wait for the current request to finish.');
      return true;
    }
    void processAgentTurn(userContent, { displayText: `[image: ${imgPath}] ${imgText}` });
    return true;
  }

  if (trimmed === '/compact') {
    if (isLoading) {
      addSystemMessage('Cannot compact while loading.');
      return true;
    }
    addSystemMessage('Compacting conversation...');
    void (async () => {
      try {
        const result = await agent.forceCompact({
          onCompact: (summary) => {
            addSystemMessage(`Context compacted: ${summary.slice(0, 200)}...`);
          },
        });
        addSystemMessage(result);
        doAutoSave();
      } catch (err: unknown) {
        const e = err as { message?: string };
        addSystemMessage(`Compaction failed: ${e.message ?? 'unknown error'}`);
      }
    })();
    return true;
  }

  if (trimmed === '/usage') {
    addSystemMessage(formatLifetimeUsage());
    return true;
  }

  if (trimmed === '/context') {
    broadcast({ type: 'context_breakdown', breakdown: agent.getContextBreakdown() });
    return true;
  }

  if (trimmed === '/tasks') {
    const allTasks = taskQueue.getInfos();
    if (allTasks.length === 0) {
      addSystemMessage('No background tasks.');
    } else {
      const running = allTasks.filter((t) => t.status === 'running');
      const completed = allTasks.filter((t) => t.status !== 'running');
      const pending = taskQueue.pendingCount;
      const lines: string[] = [];
      if (running.length > 0) {
        lines.push(`Running (${running.length}):`);
        for (const t of running) {
          const elapsed = ((Date.now() - new Date(t.startedAt).getTime()) / 1000).toFixed(0);
          lines.push(`  ${t.id}: ${t.description} (${elapsed}s)`);
        }
      }
      if (pending > 0) {
        lines.push(`Awaiting review: ${pending} result${pending > 1 ? 's' : ''}`);
      }
      if (completed.length > 0) {
        lines.push(`History (${completed.length}):`);
        for (const t of completed.slice(-5)) {
          lines.push(`  ${t.id}: ${t.description} [${t.status}]`);
        }
      }
      addSystemMessage(lines.join('\n'));
    }
    return true;
  }

  if (trimmed === '/model') {
    const list = AVAILABLE_MODELS.map((m) => (m === model ? `> ${m}` : `  ${m}`)).join('\n');
    addSystemMessage(`Current model: ${model}\nAvailable:\n${list}\nUsage: /model <name>`);
    return true;
  }

  if (trimmed.startsWith('/model ')) {
    const requested = trimmed.slice('/model '.length).trim();
    if (!AVAILABLE_MODELS.includes(requested)) {
      addSystemMessage(`Unknown model: ${requested}\nAvailable: ${AVAILABLE_MODELS.join(', ')}`);
    } else if (requested === model) {
      addSystemMessage(`Already using: ${model}`);
    } else {
      model = requested;
      agent.currentModel = requested;
      addSystemMessage(`Model switched to: ${model}`);
      broadcast({ type: 'state', model });
      doAutoSave();
    }
    return true;
  }

  if (trimmed === '/help') {
    addSystemMessage(
      'Commands:\n' +
      '  /reset              Clear conversation\n' +
      '  /restart            Restart server (picks up code changes)\n' +
      '  /refresh            Reload workspace files\n' +
      '  /compact            Compact context (free up space)\n' +
      '  /reasoning on|off   Toggle reasoning\n' +
      '  /effort <level>     Set effort (low/medium/high/max)\n' +
      '  /concise on|off     Concise/voice mode (short plain-text replies)\n' +
      '  /model [name]       Show or switch model\n' +
      '  /image <path> [msg] Send an image with optional message\n' +
      '  /usage              Show token usage (session + lifetime)\n' +
      '  /context            Show context window breakdown by component\n' +
      '  /tasks              Show background tasks\n' +
      '  /profiles           List profiles\n' +
      '  /profile <name>     Switch profile\n' +
      '  /profile create <n> Create new profile\n' +
      '  /save               Save current session\n' +
      '  /sessions           List saved sessions\n' +
      '  /load <id>          Load a saved session\n' +
      '  Esc                 Cancel generation / clear input\n' +
      '  Ctrl+C              Cancel / clear input (x2 to exit)\n' +
      '\n' +
      'Gatekeeper (host-side):\n' +
      '  /mount <path> [ro|rw]  Mount a host folder into the sandbox\n' +
      '  /unmount <path>        Remove a mount (sandbox restarts)\n' +
      '  /mounts                List active mounts\n' +
      '  /grant <id> [ro|rw]    Approve a mount request from the agent\n' +
      '  /deny <id>             Deny a mount request'
    );
    return true;
  }

  if (trimmed.startsWith('/')) {
    addSystemMessage(`Unknown command: ${trimmed}\nType /help for available commands.`);
    return true;
  }

  return false;
}

// --- Message processing ---

interface QueuedMessage { content: string | UserContent; displayText?: string; thinkingOverride?: ThinkingLevel | undefined }
const messageQueue: QueuedMessage[] = [];
let processingQueue = false;

async function processMessage(msg: QueuedMessage): Promise<void> {
  // Apply one-shot thinking override if requested (Ctrl+Enter toggle)
  const savedThinking = msg.thinkingOverride ? agent.thinkingLevel : undefined;
  if (msg.thinkingOverride) {
    agent.thinkingLevel = msg.thinkingOverride;
  }
  try {
    await processAgentTurn(msg.content, msg.displayText ? { displayText: msg.displayText } : {});
  } finally {
    // Restore previous thinking level after one-shot override
    if (savedThinking !== undefined) {
      agent.thinkingLevel = savedThinking;
    }
  }
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  while (messageQueue.length > 0) {
    const next = messageQueue.shift();
    if (next) await processMessage(next);
  }

  processingQueue = false;

  // After user messages are drained, process any completed task results
  if (taskQueue.hasPendingResults()) {
    void processTaskResults();
  }
}

function handleCancel(): void {
  if (isLoading && abortController) {
    abortController.abort();
    abortController = null;
    messageQueue.length = 0;
    isLoading = false;

    // Remove the trailing user message — but only for normal user turns.
    // Task result turns don't add user messages to the display.
    if (!isProcessingTaskResult && messages.length > 0 && messages[messages.length - 1]!.role === 'user') {
      messages.pop();
    }
    isProcessingTaskResult = false;

    taskQueue.cancelAll();
    broadcast({ type: 'text', content: '' });
    broadcast({ type: 'loading', isLoading: false });
    addSystemMessage('Cancelled.');
  }
}

// --- Client connection handling ---

function handleClient(socket: Socket): void {
  clients.add(socket);
  let buffer = '';

  // Send current state
  send(socket, { type: 'connected', state: getState() });

  // Replay any pending permission requests so reconnecting clients see them
  for (const [id, req] of pendingMountRequests) {
    send(socket, { type: 'mount_request', id, path: req.path, mode: req.mode, ...(req.reason !== undefined ? { reason: req.reason } : {}), ...(req.durationMinutes !== undefined ? { durationMinutes: req.durationMinutes } : {}) });
  }
  for (const [id, req] of pendingConfigWriteRequests) {
    send(socket, { type: 'config_write_request', id, file: req.file, content: req.content, reason: req.reason });
  }
  for (const [id, req] of pendingEditFileRequests) {
    send(socket, { type: 'edit_file_request', id, path: req.path, edits: req.edits, reason: req.reason });
  }
  for (const [id, req] of pendingExecRequests) {
    send(socket, { type: 'exec_request', id, command: req.command });
  }

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const cmd = JSON.parse(line) as ClientCommand;
        switch (cmd.type) {
          case 'message': {
            const trimmed = cmd.content.trim();
            const hasImages = cmd.images && cmd.images.length > 0;
            const hasAttachments = cmd.attachments && cmd.attachments.length > 0;
            if (!trimmed && !hasImages && !hasAttachments) break;
            if (trimmed && !hasImages && !hasAttachments && handleCommand(trimmed)) break;

            // Build content: if images/attachments present, create UserContent array
            let content: string | UserContent = trimmed;
            let displayText: string | undefined;
            if (hasImages || hasAttachments) {
              const parts: (TextContent | ImageContent | DocumentContent)[] = [];

              // Legacy image field (backward compat)
              if (hasImages) {
                for (const img of cmd.images!) {
                  parts.push({ type: 'image', mediaType: img.mediaType as ImageMediaType, data: img.data });
                }
              }

              // New attachments field
              if (hasAttachments) {
                for (const att of cmd.attachments!) {
                  if (IMAGE_TYPES_SET.has(att.mediaType)) {
                    parts.push({ type: 'image', mediaType: att.mediaType as ImageMediaType, data: att.data });
                  } else if (att.mediaType === 'application/pdf') {
                    parts.push({ type: 'document', mediaType: 'application/pdf', data: att.data, title: att.name });
                  } else if (isTextMime(att.mediaType)) {
                    const decoded = Buffer.from(att.data, 'base64').toString('utf-8');
                    const truncated = decoded.length > MAX_TEXT_FILE_SIZE
                      ? decoded.slice(0, MAX_TEXT_FILE_SIZE) + '\n\n... [truncated]'
                      : decoded;
                    parts.push({ type: 'text', text: `--- File: ${att.name} ---\n${truncated}\n--- End of ${att.name} ---` });
                  } else {
                    parts.push({ type: 'text', text: `[Unsupported file: ${att.name} (${att.mediaType})]` });
                  }
                }
              }

              parts.push({ type: 'text', text: trimmed || 'Review these attachments.' });
              content = parts;

              // Build display text label
              const imgCount = parts.filter(p => p.type === 'image').length;
              const docCount = parts.filter(p => p.type === 'document').length;
              const fileCount = parts.filter(p => p.type === 'text' && p.text.startsWith('--- File:')).length;
              const labels: string[] = [];
              if (imgCount) labels.push(`${imgCount} image${imgCount > 1 ? 's' : ''}`);
              if (docCount) labels.push(`${docCount} PDF${docCount > 1 ? 's' : ''}`);
              if (fileCount) labels.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
              displayText = labels.length > 0
                ? (trimmed ? `[${labels.join(', ')}] ${trimmed}` : `[${labels.join(', ')}]`)
                : undefined;
            }

            const queued: QueuedMessage = {
              content,
              ...(displayText ? { displayText } : {}),
              ...(cmd.thinkingOverride ? { thinkingOverride: cmd.thinkingOverride } : {}),
            };
            if (isLoading) {
              messageQueue.push(queued);
              const queuedMsg: DisplayMessage = {
                role: 'user',
                content: `[queued] ${displayText ?? trimmed}`,
                timestamp: new Date().toISOString(),
              };
              messages.push(queuedMsg);
              broadcast({ type: 'message', message: queuedMsg });
            } else {
              messageQueue.push(queued);
              void processQueue();
            }
            break;
          }
          case 'cancel':
            handleCancel();
            break;
          case 'command':
            handleCommand(cmd.cmd);
            break;
          case 'mount_response':
            resolveMountRequest(cmd.id, cmd);
            break;
          case 'host_state':
            // Update our cache of active mounts for duplicate detection
            if (cmd.mounts) {
              activeMounts = cmd.mounts;
            }
            break;
          case 'config_write_response':
            resolveConfigWriteRequest(cmd.id, cmd);
            break;
          case 'edit_file_response':
            resolveEditFileRequest(cmd.id, cmd);
            break;
          case 'exec_response':
            resolveExecRequest(cmd.id, { ok: cmd.ok, alwaysAllow: cmd.alwaysAllow ?? false, message: cmd.message });
            break;
          case 'fetch_response':
            resolveFetchRequest(cmd.id, { ok: cmd.ok, alwaysAllow: cmd.alwaysAllow ?? false, message: cmd.message });
            break;
          case 'screenshot_response':
            resolveScreenshotRequest(cmd.id, {
              ok: cmd.ok,
              ...(cmd.data !== undefined ? { data: cmd.data } : {}),
              ...(cmd.mediaType !== undefined ? { mediaType: cmd.mediaType } : {}),
              message: cmd.message,
            });
            break;
          case 'screen_share_response':
            resolveScreenShareRequest(cmd.id, { ok: cmd.ok, message: cmd.message });
            break;
          case 'context_breakdown_request':
            send(socket, { type: 'context_breakdown', breakdown: agent.getContextBreakdown() });
            break;
          case 'ping':
            send(socket, { type: 'pong' });
            break;
        }
      } catch {
        // Malformed JSON, ignore
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('error', () => {
    clients.delete(socket);
  });
}

// --- Server startup ---

function startServer(): Server {
  // Ensure socket directory exists
  const socketDir = dirname(SOCKET_PATH);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }

  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  }

  const server = createServer(handleClient);
  server.listen(SOCKET_PATH, () => {
    // Server ready
  });

  return server;
}

function restoreSession(): void {
  const saved = autoLoadSession(workspacePath);
  if (saved) {
    const agentMessages = saved.agentMessages as ProviderMessage[];

    // Fix orphaned tool_use blocks — assistant messages with toolCalls but no
    // following tool_result. This can happen if the previous session was
    // interrupted during tool execution. Strip the toolCalls to prevent
    // 400 errors from the API.
    for (let i = 0; i < agentMessages.length; i++) {
      const msg = agentMessages[i]!;
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const next = agentMessages[i + 1];
        if (!next || next.role !== 'tool_result') {
          log.warn('Session restore: stripping orphaned tool_use', { index: i });
          msg.toolCalls = undefined;
        }
      }
    }

    // If the conversation ends mid-tool-loop (last message is a tool_result),
    // the model will try to continue the previous work instead of handling new
    // user input. Cap it with a synthetic assistant message so the model knows
    // the previous turn is complete.
    if (agentMessages.length > 0 && agentMessages[agentMessages.length - 1]!.role === 'tool_result') {
      agentMessages.push({
        role: 'assistant',
        content: '[Previous session ended. Awaiting new instructions.]',
      });
    }

    agent.setMessages(agentMessages);
    messages = saved.uiMessages as DisplayMessage[];
    // Restore saved usage so token counts are continuous across restarts
    if (saved.usage) {
      usage = saved.usage;
      agent.setUsage(saved.usage);
    }
    // Restore thinking level so it persists across restarts (env var is just the default)
    if (saved.thinking) {
      const level = saved.thinking.current as ThinkingLevel;
      const effort = saved.thinking.savedEffort as ThinkingLevel;
      if (VALID_THINKING_LEVELS.includes(level)) {
        currentThinking = level;
        agent.thinkingLevel = level;
      }
      if (VALID_THINKING_LEVELS.includes(effort)) {
        savedEffortLevel = effort;
      }
      log.info('Thinking restored', { current: currentThinking, savedEffort: savedEffortLevel });
    }
    // Restore model so it persists across restarts
    if (saved.model && AVAILABLE_MODELS.includes(saved.model)) {
      model = saved.model;
      agent.currentModel = saved.model;
      log.info('Model restored', { model });
    }
    // Restore concise mode so it persists across restarts
    if (saved.concise !== undefined) {
      currentConcise = saved.concise;
      agent.setExtraSystemPrompt(buildExtraSystemPrompt());
      log.info('Concise mode restored', { concise: currentConcise });
    }
    log.info('Session restored', { messages: messages.length, tokens: usage.input + usage.output });
  }
}

// --- Main ---

model = process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6';
currentThinking = (process.env['AIGENT_THINKING'] as ThinkingLevel | undefined) ?? 'high';
workspacePath = process.env['AIGENT_WORKSPACE'] ?? '/workspace';

let mcpManager: MCPManager | null = null;

// --- Host daemon client ---

import { initHostClient } from './host-client.js';
import type { HostClient } from './host-client.js';

let hostClient: HostClient | null = null;

function buildHostSystemPrompt(): string {
  if (!hostClient || !hostClient.isConnected()) return '';

  const available = hostClient.getAvailableCapabilities();
  const denied = hostClient.getDeniedCapabilities();

  if (available.length === 0 && denied.length === 0) return '';

  const lines = ['\n\n## Host Daemon'];
  lines.push('The host daemon (aigent-host) is running. Use the `host` tool to access OS capabilities.');
  if (available.length > 0) {
    lines.push(`Available: ${available.join(', ')}`);
  }
  if (denied.length > 0) {
    lines.push(`Denied: ${denied.join(', ')}`);
  }
  lines.push('Some capabilities may require user approval when first used.');
  return lines.join('\n');
}

function buildExtraSystemPrompt(): string {
  let extra = buildHostSystemPrompt();
  if (currentConcise) {
    extra += '\n\n## Response Style (Voice Mode)\n\nStart every response with a spoken summary on its own line, before anything else:\n\n<speak>One or two sentence plain English summary for text-to-speech. No markdown, no lists.</speak>\n\nThen give your full response with markdown as normal. The <speak> block is read aloud immediately while the rest loads. Keep it brief and conversational.';
  }
  return extra;
}

// Initialize MCP, host client, and agent
async function initAgent(): Promise<void> {
  // Start MCP servers (non-blocking — failures are logged, not fatal)
  try {
    mcpManager = await loadMCP(workspacePath);
    const { servers, tools } = mcpManager.stats;
    if (servers > 0) {
      log.info('MCP initialized', { servers, tools });
    }
  } catch (err: unknown) {
    const e = err as { message?: string };
    log.warn('MCP init failed (non-fatal)', { error: e.message });
  }

  // Connect to host daemon (non-blocking — agent works without it)
  hostClient = initHostClient();
  if (hostClient) {
    log.info('Host daemon connected');
    // Wait briefly for capabilities event
    await new Promise<void>((r) => setTimeout(r, 200));
  }

  // Check for LLM proxy socket — if present, use SocketProvider
  // (API keys stay on the host, worker proxies through gatekeeper)
  let proxyProvider: import('./provider.js').Provider | undefined;
  try {
    const { SocketProvider, LLM_PROXY_SOCKET } = await import('./socket-provider.js');
    const { existsSync: exists } = await import('node:fs');
    if (exists(LLM_PROXY_SOCKET)) {
      const sp = new SocketProvider();
      if (sp.connect()) {
        // Wait for connection to establish
        await new Promise<void>((r) => setTimeout(r, 300));
        if (sp.isConnected()) {
          proxyProvider = sp;
          log.info('Using LLM proxy (API keys on host)');
        }
      }
    }
  } catch {}

  // Store provider at module level so background tasks can reuse it
  // (in the sandbox there are no API keys — only the SocketProvider works)
  agentProvider = proxyProvider;

  agent = new Agent({
    model,
    thinking: currentThinking,
    workspacePath,
    ...(mcpManager ? { mcpManager } : {}),
    ...(proxyProvider ? { provider: proxyProvider } : {}),
    extraSystemPrompt: buildExtraSystemPrompt(),
  });

  // Fetch available models from the provider (non-blocking — falls back to defaults)
  void (async () => {
    try {
      const provider = agentProvider ?? agent.underlyingProvider;
      if (provider?.listModels) {
        const models = await provider.listModels();
        if (models && models.length > 0) {
          AVAILABLE_MODELS = models.map((m) => m.id);
          log.info('Model list updated from API', { count: AVAILABLE_MODELS.length });
          broadcast({ type: 'state', availableModels: AVAILABLE_MODELS });
        }
      }
    } catch (err: unknown) {
      const e = err as { message?: string };
      log.warn('Failed to fetch model list (using defaults)', { error: e.message });
    }
  })();
}

try {
  await initAgent();
} catch (err: unknown) {
  const error = err as { message?: string };
  log.error('Fatal', { error: error.message ?? 'Failed to initialize agent' });
  process.exit(1);
}

restoreSession();
const server = startServer();
log.info('Listening', { socket: SOCKET_PATH });

// --- End-of-session summary ---

function writeEndOfSessionSummary(): void {
  try {
    if (messages.length < 4) return;

    const userMessages = messages.filter((m) => m.role === 'user' && !m.content.startsWith('[queued]'));
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const systemMessages = messages.filter((m) => m.role === 'system');

    if (userMessages.length === 0) return;

    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    const dateStr = now.toISOString().slice(0, 10);

    // Collect user topics (first 80 chars of each message)
    const topics = userMessages
      .map((m) => String(m.content).slice(0, 80).replace(/\n/g, ' '))
      .slice(0, 10) // max 10 topics
      .map((t) => `  - ${t}`);

    // Estimate cost
    const costStr = usage.cost ? `$${usage.cost < 0.01 ? usage.cost.toFixed(3) : usage.cost.toFixed(2)}` : 'n/a';

    const summary =
      `- Messages: ${messages.length} total (${userMessages.length} user, ${assistantMessages.length} assistant, ${systemMessages.length} system)\n` +
      `- Model: ${model}\n` +
      `- Cost: ${costStr}\n` +
      `- Topics discussed:\n${topics.join('\n')}\n`;

    const memoryDir = join(workspacePath, 'memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const filePath = join(memoryDir, `${dateStr}.md`);
    appendFileSync(filePath, `\n## Session End (${time})\n\n${summary}\n`);
  } catch {
    // Non-critical — don't prevent shutdown
  }
}

// Graceful shutdown
let restartRequested = false;
let isShuttingDown = false;

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // If the agent was mid-tool-loop, cancel before saving to avoid
  // autosaving a conversation that ends with tool_result (which would
  // cause the model to continue previous work on restore).
  if (isLoading && abortController) {
    abortController.abort();
    abortController = null;
    isLoading = false;
  }

  // Distill conversation to MEMORY.md — give it up to 30s before forcing exit
  const agentMessages = agent?.getMessages() ?? [];
  if (agentMessages.length >= 4 && agent) {
    try {
      await Promise.race([
        distillToMemory(agent.underlyingProvider, agent.currentModel, agentMessages, workspacePath),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
      ]);
    } catch {
      // Non-critical — write a minimal fallback entry
      writeEndOfSessionSummary();
    }
  } else {
    writeEndOfSessionSummary();
  }

  saveLifetimeUsage(usage);
  doAutoSave();
  if (mcpManager) mcpManager.shutdown();
  server.close();
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  }
  process.exit(restartRequested ? 100 : 0);
}

function requestRestart(): void {
  restartRequested = true;
  void shutdown();
}

process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

// Keep alive
setInterval(() => {}, 60_000);
