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
import { existsSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Agent, type ThinkingLevel } from './agent.js';
import { generateSessionId, autoSaveSession, autoLoadSession } from './profiles.js';
import type { ProviderMessage, UserContent, TextContent, ImageContent, DocumentContent, ImageMediaType, ToolResult } from './provider.js';
import type { ClientCommand, ServerEvent, DisplayMessage, DisplayAttachment, ServerState, TokenUsage } from './protocol.js';
import { SOCKET_PATH } from './protocol.js';
import { computeCost } from './pricing.js';
import { distillToMemory } from './compact.js';
import { loadMCP, type MCPManager } from './mcp.js';
import { createLogger } from './logger.js';
import { execReadonlyTool, fetchReadonlyTool, getToolDefinitions } from './tools.js';
import type { ProviderToolDef } from './provider.js';
import { PendingRequestBroker } from './pending-request.js';
import { parseImagesInMessage, IMAGE_TYPES_SET, isTextMime, MAX_TEXT_FILE_SIZE } from './image-support.js';
import { saveLifetimeUsage } from './usage-tracking.js';
import {
  buildHostSystemPrompt as _buildHostSystemPrompt,
  buildBrowserExtSystemPrompt as _buildBrowserExtSystemPrompt,
  SHORT_MODE_PROMPT,
  ensureSpeakTag as _ensureSpeakTag,
} from './system-prompts.js';
import { handleCommand as _handleCommand, type CommandContext } from './commands.js';

const log = createLogger('server');

const VALID_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

// Default model list — used until the provider reports its own list.
// Ordered most capable → fastest/cheapest.
let AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

// --- State ---

let agent: Agent;
let agentProvider: import('./provider.js').Provider | undefined;
let messages: DisplayMessage[] = [];
let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let currentThinking: ThinkingLevel;
let savedEffortLevel: ThinkingLevel = 'high';
let currentShort = false;
let currentProfile = 'default';
let currentSessionId = generateSessionId();
let model: string;
let workspacePath: string;
let isLoading = false;
let isProcessingTaskResult = false;
let abortController: AbortController | null = null;
const clients = new Set<Socket>();

// --- Permission request brokers ---
// Each broker manages one category of pending request (exec, fetch, etc.).
// See pending-request.ts for the generic implementation.

type OkAlwaysAllow = { ok: boolean; alwaysAllow: boolean; message: string };
type OkMessage = { ok: boolean; message: string };

const execBroker = new PendingRequestBroker<{ command: string }, OkAlwaysAllow>({
  prefix: 'exec',
  abortResponse: { ok: false, alwaysAllow: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, alwaysAllow: false, message: 'Exec approval request timed out (60s)' },
});

type BrowserExtResponse = { ok: boolean; treeText?: string; dataUrl?: string; tabs?: { id: number; title: string; url: string; active: boolean; windowId: number }[]; stepsCompleted?: number; totalSteps?: number; finalUrl?: string; finalTitle?: string; newTabId?: number; error?: string };

const browserExtBroker = new PendingRequestBroker<
  { action: string; tabId?: number; rootSelector?: string; steps?: unknown[]; url?: string },
  BrowserExtResponse
>({
  prefix: 'bext',
  timeoutMs: 30_000,
  abortResponse: { ok: false, error: 'Aborted by user' },
  timeoutResponse: { ok: false, error: 'Browser extension request timed out (30s). Is the extension connected?' },
});

const fetchBroker = new PendingRequestBroker<{ url: string; method?: string }, OkAlwaysAllow>({
  prefix: 'fetch',
  abortResponse: { ok: false, alwaysAllow: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, alwaysAllow: false, message: 'Fetch approval request timed out (60s)' },
});

const fileAccessBroker = new PendingRequestBroker<{ path: string; operation: 'read' | 'write' }, OkMessage>({
  prefix: 'file',
  abortResponse: { ok: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, message: 'File access approval request timed out (60s)' },
});

export const FETCH_DEFAULT_BYTES = 1 * 1024 * 1024;   // 1 MB
export const FETCH_MAX_BYTES_HARD = 10 * 1024 * 1024; // 10 MB hard ceiling

const fetchSizeBroker = new PendingRequestBroker<{ url: string; requestedBytes: number }, { ok: boolean; approvedBytes: number; message: string }>({
  prefix: 'fetchsz',
  abortResponse: { ok: false, approvedBytes: FETCH_DEFAULT_BYTES, message: 'Aborted by user' },
  timeoutResponse: { ok: false, approvedBytes: FETCH_DEFAULT_BYTES, message: 'Fetch size approval request timed out (60s)' },
});

const mcpToolBroker = new PendingRequestBroker<{ server: string; tool: string; params: string }, OkMessage>({
  prefix: 'mcp',
  abortResponse: { ok: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, message: 'MCP tool approval request timed out (60s)' },
});

const screenShareBroker = new PendingRequestBroker<Record<string, never>, OkMessage>({
  prefix: 'ss',
  abortResponse: { ok: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, message: 'Screen share request timed out (60s)' },
});

const screenshotBroker = new PendingRequestBroker<Record<string, never>, { ok: boolean; data?: string; mediaType?: string; message: string }>({
  prefix: 'sc',
  timeoutMs: 30_000,
  abortResponse: { ok: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, message: 'Screenshot request timed out (30s)' },
});

const configWriteBroker = new PendingRequestBroker<{ file: string; content: string; reason: string }, OkMessage>({
  prefix: 'config',
  abortResponse: { ok: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, message: 'Config write request timed out (60s)' },
});

const editFileBroker = new PendingRequestBroker<
  { path: string; edits: Array<{ old_str: string; new_str: string; index?: number }>; reason: string },
  OkMessage
>({
  prefix: 'edit',
  timeoutMs: 120_000,
  abortResponse: { ok: false, message: 'Aborted by user' },
  timeoutResponse: { ok: false, message: 'Edit request timed out (120s)' },
});

const userQuestionBroker = new PendingRequestBroker<
  { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowFreeText?: boolean },
  { answer: string; selectedOptions?: string[]; dismissed: boolean }
>({
  prefix: 'question',
  timeoutMs: 300_000,
  abortResponse: { answer: '', dismissed: true },
  timeoutResponse: { answer: '', dismissed: true },
});

// --- Thin wrappers that preserve the original exported API ---

export function requestExecApproval(command: string, signal?: AbortSignal): Promise<OkAlwaysAllow> {
  const [id, promise] = execBroker.request({ command }, signal);
  broadcast({ type: 'exec_request', id, command });
  return promise;
}

export async function requestBrowserExt(
  action: 'extract_a11y' | 'screenshot' | 'list_tabs' | 'run_script' | 'navigate' | 'activate_tab' | 'open_tab' | 'close_tab',
  params: { tabId?: number; rootSelector?: string; steps?: unknown[]; url?: string } = {},
  signal?: AbortSignal,
): Promise<string | import('./provider.js').ToolContentBlock[]> {
  if (signal?.aborted) return 'Aborted by user';
  const [id, promise] = browserExtBroker.request({ action, ...params }, signal);
  broadcast({ type: 'browser_ext_request', id, action, ...params });
  const response = await promise;

  if (!response.ok) return `Browser extension error: ${response.error ?? 'unknown error'}`;

  if (action === 'screenshot' && response.dataUrl) {
    const [header, b64] = response.dataUrl.split(',');
    const rawType = header?.replace('data:', '').replace(';base64', '') ?? 'image/png';
    const mediaType: import('./provider.js').ImageMediaType =
      (rawType === 'image/png' || rawType === 'image/jpeg' || rawType === 'image/gif' || rawType === 'image/webp')
        ? rawType : 'image/png';
    return [{ type: 'image' as const, mediaType, data: b64 ?? '' }];
  }
  if (action === 'list_tabs' && response.tabs) {
    const lines = response.tabs.map(t => `[${t.active ? '*' : ' '}] tab:${t.id}  ${t.title}  (${t.url})`);
    return `Open browser tabs (${response.tabs.length}):\n${lines.join('\n')}\n\nUse tabId parameter with extract_a11y or screenshot to target a specific tab. Active tab is marked with [*].`;
  }
  if (action === 'navigate') return `Navigated to: ${response.finalUrl ?? params.url ?? '?'}\nTitle: ${response.finalTitle ?? '(unknown)'}`;
  if (action === 'run_script') {
    const parts: string[] = [`Script completed: ${response.stepsCompleted ?? '?'}/${response.totalSteps ?? '?'} steps`];
    if (response.finalUrl) parts.push(`Final URL: ${response.finalUrl}`);
    if (response.finalTitle) parts.push(`Final title: ${response.finalTitle}`);
    return parts.join('\n');
  }
  if (action === 'activate_tab') return `Switched to tab: ${response.finalUrl ?? '?'}\nTitle: ${response.finalTitle ?? '(unknown)'}`;
  if (action === 'open_tab') return `Opened new tab (id: ${response.newTabId ?? '?'}): ${response.finalUrl ?? params.url ?? '?'}\nTitle: ${response.finalTitle ?? '(unknown)'}`;
  return response.treeText ?? '(no content)';
}

export function requestFetchApproval(url: string, method?: string, signal?: AbortSignal): Promise<OkAlwaysAllow> {
  const [id, promise] = fetchBroker.request({ url, ...(method !== undefined ? { method } : {}) }, signal);
  broadcast({ type: 'fetch_request', id, url, ...(method ? { method } : {}) });
  return promise;
}

export function requestFileApproval(path: string, operation: 'read' | 'write', signal?: AbortSignal): Promise<OkMessage> {
  const [id, promise] = fileAccessBroker.request({ path, operation }, signal);
  broadcast({ type: 'file_access_request', id, path, operation, reason: `Agent wants to ${operation} this path` });
  return promise;
}

export function requestFetchSizeApproval(url: string, requestedBytes: number, signal?: AbortSignal): Promise<{ ok: boolean; approvedBytes: number; message: string }> {
  const [id, promise] = fetchSizeBroker.request({ url, requestedBytes }, signal);
  broadcast({ type: 'fetch_size_request', id, url, requestedBytes, defaultBytes: FETCH_DEFAULT_BYTES });
  return promise;
}

export function requestMcpToolApproval(server: string, tool: string, params: unknown, signal?: AbortSignal): Promise<OkMessage> {
  const paramsStr = JSON.stringify(params ?? {}, null, 2).slice(0, 500);
  const [id, promise] = mcpToolBroker.request({ server, tool, params: paramsStr }, signal);
  broadcast({ type: 'mcp_tool_request', id, server, tool, params: paramsStr });
  return promise;
}

export function requestBrowserScreenShare(): Promise<OkMessage> {
  const [id, promise] = screenShareBroker.request({});
  broadcast({ type: 'screen_share_request', id });
  return promise;
}

export async function requestBrowserScreenshot(): Promise<{ ok: boolean; data?: string; mediaType?: string; message: string }> {
  // Try screenshot directly — if screen share isn't active, the browser will reply with ok:false
  const [id, promise] = screenshotBroker.request({});
  broadcast({ type: 'screenshot_request', id });
  const result = await promise;
  if (result.ok) return result;

  // Screen share wasn't active — ask the browser to start it now
  const shareResult = await requestBrowserScreenShare();
  if (!shareResult.ok) return { ok: false, message: shareResult.message };

  // Small delay so the OS screen-share approval dialog has time to dismiss
  await new Promise((r) => setTimeout(r, 1500));

  // Retry screenshot now that sharing is active
  const [retryId, retryPromise] = screenshotBroker.request({});
  broadcast({ type: 'screenshot_request', id: retryId });
  return retryPromise;
}

export function requestConfigWrite(file: string, content: string, reason: string): Promise<OkMessage> {
  const [id, promise] = configWriteBroker.request({ file, content, reason });
  broadcast({ type: 'config_write_request', id, file, content, reason });
  return promise;
}

export function requestHostEditFile(
  path: string,
  edits: Array<{ old_str: string; new_str: string; index?: number }>,
  reason: string,
): Promise<OkMessage> {
  const [id, promise] = editFileBroker.request({ path, edits, reason });
  broadcast({ type: 'edit_file_request', id, path, edits, reason });
  return promise;
}

export function requestUserQuestion(
  question: string,
  options?: { label: string; description?: string }[],
  multiSelect?: boolean,
  allowFreeText?: boolean,
  signal?: AbortSignal,
): Promise<{ answer: string; selectedOptions?: string[]; dismissed: boolean }> {
  const meta: { question: string; options?: { label: string; description?: string }[]; multiSelect?: boolean; allowFreeText?: boolean } = { question };
  if (options !== undefined) meta.options = options;
  if (multiSelect !== undefined) meta.multiSelect = multiSelect;
  if (allowFreeText !== undefined) meta.allowFreeText = allowFreeText;
  const [id, promise] = userQuestionBroker.request(meta, signal);
  broadcast({
    type: 'user_question_request', id, question,
    ...(options ? { options } : {}),
    ...(multiSelect !== undefined ? { multiSelect } : {}),
    ...(allowFreeText !== undefined ? { allowFreeText } : {}),
  });
  return promise;
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
  opts: { isTaskResult?: boolean; displayText?: string; displayAttachments?: DisplayAttachment[] } = {},
): Promise<void> {
  const { isTaskResult = false, displayText, displayAttachments } = opts;

  if (!isTaskResult) {
    const text = displayText ?? (typeof content === 'string' ? content : '[message with attachments]');
    const userMsg: DisplayMessage = {
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      ...(displayAttachments && displayAttachments.length > 0 ? { attachments: displayAttachments } : {}),
    };
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
  let userContent = typeof content === 'string' && !isTaskResult
    ? parseImagesInMessage(content)
    : content;

  // Short mode: inject a per-message reminder close to the generation point.
  // System prompt instructions get buried in long conversations; a user-turn
  // reminder is far more reliable at keeping the model concise.
  if (currentShort && !isTaskResult) {
    const shortReminder = '\n\n[SHORT MODE — HARD LIMIT 100 WORDS. <speak>1-2 sentences</speak> first, then at most 1-3 sentences. No blockquotes, no long content, no before/after comparisons. If content is needed, use a tool.]';
    if (typeof userContent === 'string') {
      userContent = userContent + shortReminder;
    } else if (Array.isArray(userContent)) {
      userContent = [...userContent, { type: 'text' as const, text: shortReminder }];
    }
  }

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
      onToolStart: (name, toolInput, summary, meta) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_start', name, input: toolInput, summary, ...meta });
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
      const finalContent = _ensureSpeakTag(response, currentShort);
      broadcast({ type: 'text', content: '' });
      const assistantMsg: DisplayMessage = {
        role: 'assistant',
        content: finalContent,
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
    'request_config_write',
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

// Usage tracking — see usage-tracking.ts

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
    short: currentShort,
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
    }, model, currentShort);
  } catch {
    // Non-critical
  }
}

// --- Command handling ---

function handleCommand(cmd: string): boolean {
  const ctx: CommandContext = {
    agent,
    taskQueue,
    get messages() { return messages; },
    set messages(v) { messages = v; },
    get usage() { return usage; },
    set usage(v) { usage = v; },
    get currentThinking() { return currentThinking; },
    set currentThinking(v) { currentThinking = v; },
    get savedEffortLevel() { return savedEffortLevel; },
    set savedEffortLevel(v) { savedEffortLevel = v; },
    get currentShort() { return currentShort; },
    set currentShort(v) { currentShort = v; },
    get currentProfile() { return currentProfile; },
    set currentProfile(v) { currentProfile = v; },
    get currentSessionId() { return currentSessionId; },
    set currentSessionId(v) { currentSessionId = v; },
    get model() { return model; },
    set model(v) { model = v; },
    get isLoading() { return isLoading; },
    get workspacePath() { return workspacePath; },
    get availableModels() { return AVAILABLE_MODELS; },
    addSystemMessage,
    broadcast,
    doAutoSave,
    buildExtraSystemPrompt,
    requestRestart,
    processAgentTurn,
  };
  return _handleCommand(cmd, ctx);
}

// --- Message processing ---

interface QueuedMessage { content: string | UserContent; displayText?: string; displayAttachments?: DisplayAttachment[]; thinkingOverride?: ThinkingLevel | undefined }
const messageQueue: QueuedMessage[] = [];
let processingQueue = false;

async function processMessage(msg: QueuedMessage): Promise<void> {
  // Apply one-shot thinking override if requested (Ctrl+Enter toggle)
  const savedThinking = msg.thinkingOverride ? agent.thinkingLevel : undefined;
  if (msg.thinkingOverride) {
    agent.thinkingLevel = msg.thinkingOverride;
  }
  try {
    await processAgentTurn(msg.content, {
      ...(msg.displayText ? { displayText: msg.displayText } : {}),
      ...(msg.displayAttachments ? { displayAttachments: msg.displayAttachments } : {}),
    });
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
  configWriteBroker.replayTo((id, meta) => {
    send(socket, { type: 'config_write_request', id, file: meta.file, content: meta.content, reason: meta.reason });
  });
  editFileBroker.replayTo((id, meta) => {
    send(socket, { type: 'edit_file_request', id, path: meta.path, edits: meta.edits, reason: meta.reason });
  });
  execBroker.replayTo((id, meta) => {
    send(socket, { type: 'exec_request', id, command: meta.command });
  });
  userQuestionBroker.replayTo((id, meta) => {
    send(socket, {
      type: 'user_question_request', id, question: meta.question,
      ...(meta.options ? { options: meta.options } : {}),
      ...(meta.multiSelect !== undefined ? { multiSelect: meta.multiSelect } : {}),
      ...(meta.allowFreeText !== undefined ? { allowFreeText: meta.allowFreeText } : {}),
    });
  });

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
              // Thumbnails are now rendered in the UI, so just show the user's text.
              // Fall back to a label only if the user sent no text at all.
              displayText = trimmed || (labels.length > 0 ? `[${labels.join(', ')}]` : undefined);
            }

            // Build display attachments with thumbnails for chat persistence
            const displayAttachments: DisplayAttachment[] | undefined =
              (hasImages || hasAttachments)
                ? [
                    ...(cmd.images ?? []).map((img, i) => ({
                      name: `image-${i + 1}`,
                      mediaType: img.mediaType,
                    })),
                    ...(cmd.attachments ?? []).map(att => ({
                      name: att.name,
                      mediaType: att.mediaType,
                      ...(att.thumbnail ? { thumbnail: att.thumbnail } : {}),
                    })),
                  ]
                : undefined;

            const queued: QueuedMessage = {
              content,
              ...(displayText ? { displayText } : {}),
              ...(displayAttachments ? { displayAttachments } : {}),
              ...(cmd.thinkingOverride ? { thinkingOverride: cmd.thinkingOverride } : {}),
            };
            if (isLoading) {
              messageQueue.push(queued);
              const queuedMsg: DisplayMessage = {
                role: 'user',
                content: `[queued] ${displayText ?? trimmed}`,
                timestamp: new Date().toISOString(),
                ...(displayAttachments ? { attachments: displayAttachments } : {}),
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
          case 'host_state':
            // Refresh system prompt so the agent sees current state
            agent?.setExtraSystemPrompt(buildExtraSystemPrompt());
            break;
          case 'config_write_response':
            configWriteBroker.resolve(cmd.id, cmd);
            break;
          case 'edit_file_response':
            editFileBroker.resolve(cmd.id, cmd);
            break;
          case 'exec_response':
            execBroker.resolve(cmd.id, { ok: cmd.ok, alwaysAllow: cmd.alwaysAllow ?? false, message: cmd.message });
            break;
          case 'fetch_response':
            fetchBroker.resolve(cmd.id, { ok: cmd.ok, alwaysAllow: cmd.alwaysAllow ?? false, message: cmd.message });
            break;
          case 'file_access_response':
            fileAccessBroker.resolve(cmd.id, { ok: cmd.ok, message: cmd.message });
            break;
          case 'fetch_size_response':
            fetchSizeBroker.resolve(cmd.id, { ok: cmd.ok, approvedBytes: cmd.approvedBytes, message: cmd.message });
            break;
          case 'mcp_tool_response':
            mcpToolBroker.resolve(cmd.id, { ok: cmd.ok, message: cmd.message });
            break;
          case 'screenshot_response':
            screenshotBroker.resolve(cmd.id, {
              ok: cmd.ok,
              ...(cmd.data !== undefined ? { data: cmd.data } : {}),
              ...(cmd.mediaType !== undefined ? { mediaType: cmd.mediaType } : {}),
              message: cmd.message,
            });
            break;
          case 'screen_share_response':
            screenShareBroker.resolve(cmd.id, { ok: cmd.ok, message: cmd.message });
            break;
          case 'browser_ext_result':
            browserExtBroker.resolve(cmd.id, cmd);
            break;
          case 'user_question_response': {
            const questionResponse: { answer: string; selectedOptions?: string[]; dismissed: boolean } = {
              answer: cmd.answer,
              dismissed: cmd.dismissed,
            };
            if (cmd.selectedOptions !== undefined) questionResponse.selectedOptions = cmd.selectedOptions;
            userQuestionBroker.resolve(cmd.id, questionResponse);
            break;
          }
          case 'context_breakdown_request':
            try {
              send(socket, { type: 'context_breakdown', breakdown: agent.getContextBreakdown() });
            } catch (err) {
              log.error('Failed to generate context breakdown', { error: String(err) });
              // Send an empty breakdown so the client doesn't hang on "Loading..."
              send(socket, { type: 'context_breakdown', breakdown: {
                systemBase: 0, workspaceContext: 0, toolDefs: 0,
                messages: [], messagesTotal: 0, total: 0,
              } });
            }
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

/** Restore session and return true if the session was interrupted mid-turn (needs auto-resume). */
function restoreSession(): boolean {
  const saved = autoLoadSession(workspacePath);
  if (!saved) return false;

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

  // Check if the session was interrupted mid-turn: last non-system UI message
  // is from the user, meaning the agent never completed its response.
  const uiMessages = saved.uiMessages as DisplayMessage[];
  const lastNonSystem = [...uiMessages].reverse().find(m => m.role !== 'system');
  const wasInterrupted = lastNonSystem?.role === 'user';

  // If the conversation ends mid-tool-loop (last message is a tool_result),
  // the model will try to continue the previous work instead of handling new
  // user input. Cap it with a synthetic assistant message so the model knows
  // the previous turn is complete — unless we're about to auto-resume.
  if (!wasInterrupted && agentMessages.length > 0 && agentMessages[agentMessages.length - 1]!.role === 'tool_result') {
    agentMessages.push({
      role: 'assistant',
      content: '[Previous session ended. Awaiting new instructions.]',
    });
  }

  agent.setMessages(agentMessages);
  messages = uiMessages;
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
  // Restore short mode so it persists across restarts
  if (saved.short !== undefined) {
    currentShort = saved.short;
    agent.setExtraSystemPrompt(buildExtraSystemPrompt());
    log.info('Short mode restored', { short: currentShort });
  }
  log.info('Session restored', { messages: messages.length, tokens: usage.input + usage.output, wasInterrupted });
  return wasInterrupted;
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

// Tracks whether the browser extension is currently connected.
// Updated by the extensionBridge event emitter (wired in initAgent).
let browserExtConnected = false;

function buildExtraSystemPrompt(): string {
  let extra = _buildHostSystemPrompt(hostClient);
  extra += _buildBrowserExtSystemPrompt(browserExtConnected);
  if (currentShort) extra += SHORT_MODE_PROMPT;
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

  // Subscribe to extension bridge connection events so the system prompt stays current
  {
    const { extensionBridge } = await import('./ext-bridge.js');
    extensionBridge.on('connected', () => {
      browserExtConnected = true;
      log.info('Browser extension connected — updating system prompt');
      agent?.setExtraSystemPrompt(buildExtraSystemPrompt());
      addSystemMessage('Browser extension connected. `browser_ext` tool is now available.');
    });
    extensionBridge.on('disconnected', () => {
      browserExtConnected = false;
      log.info('Browser extension disconnected — updating system prompt');
      agent?.setExtraSystemPrompt(buildExtraSystemPrompt());
      addSystemMessage('Browser extension disconnected.');
    });
    // Sync initial state in case extension was already connected before agent init
    browserExtConnected = extensionBridge.isConnected();
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

  // Save conversation state FIRST — this is synchronous and fast.
  // Must run before distillToMemory (which makes an API call) to ensure
  // state is preserved even if docker SIGKILL arrives during distillation.
  saveLifetimeUsage(workspacePath, usage);
  doAutoSave();

  // Distill conversation to MEMORY.md — give it up to 30s before forcing exit.
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
