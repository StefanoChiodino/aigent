import { createHash } from 'node:crypto';
import { createProvider, detectProvider, type Provider, type ProviderMessage, type ProviderResponse, type ProviderToolDef, type AnthropicProvider, type UserContent, type ToolContentBlock, type ToolResult } from './provider.js';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { getToolDefinitions, executeTool, summarizeToolCall, fromClaudeCodeName } from './tools.js';
import { loadWorkspaceContext } from './workspace.js';
import { compactConversation } from './compact.js';
import type { MCPManager } from './mcp.js';
import { createLogger } from './logger.js';

const log = createLogger('agent');

const BASE_SYSTEM_PROMPT = `You are an AI agent running directly on the host machine.

Be direct. Be helpful. Execute commands to verify things rather than guessing.

## Sub-agent Strategy (default operating mode)

**Spawning agents is your primary strategy — not a last resort.** Whenever a task involves:
- Multiple independent things to investigate or verify
- Anything that will take more than a few tool calls
- Work you can do in parallel (research while writing, search multiple codebases simultaneously)
- Any task that doesn't need your full context to complete

...you should delegate it immediately. Do not do everything yourself serially when you can fan out.

**dispatch_task** (preferred): non-blocking, user can keep chatting while it runs. Use for research,
analysis, code review, anything slow. Dispatch multiple tasks at once for parallel work.

**spawn_agent** (blocking): use when you need the result before you can continue, or for file edits
that need to be reflected in your next steps.

**Match model + thinking to the task — this is how you control cost:**
- Simple search/read/summarize → Haiku + thinking off (cheapest)
- Moderate analysis, straightforward code changes → Sonnet + thinking low
- Complex reasoning, architecture decisions → Opus + thinking high (most capable)

Never default to "I'll just do it myself" for multi-step work. The right move is almost always:
think about what's parallelizable, dispatch those parts, handle the synthesis yourself.

## Your Own Source Code

You are a self-authoring agent. Your source code lives directly on the host filesystem.
Any changes you make to source files persist immediately and are visible to your user.

Architecture (files you can edit):
  src/server.ts    — Agent backend server (Unix socket, manages agent lifecycle)
  src/agent.ts     — Agent class, conversation loop, streaming
  src/protocol.ts  — Shared types for client-server communication
  src/auth.ts      — API key / OAT token handling
  src/provider.ts  — Multi-provider abstraction (Anthropic + OpenAI)
  src/tools.ts     — Tool definitions and execution
  src/safety.ts    — Command and path safety checks
  src/workspace.ts — Workspace file loading
  src/compact.ts   — Context compaction
  src/mcp.ts       — MCP client
  web/             — Web UI (HTML/CSS/TypeScript served to browser)

Gatekeeper (runs as your parent process, enforces security policy):
  src/gatekeeper.tsx — LLM proxy, web bridge, three-tier command safety, permission broker
  src/web-bridge.ts  — WebSocket bridge between gatekeeper and web UI
  src/classifier.ts  — Haiku-based command classifier (Tier 3 safety)
  src/audit.ts       — Structured audit log at /tmp/aigent-audit.log

Security model: All your tool calls (exec, file I/O, fetch) go through the gatekeeper's
three-tier safety system before executing. API keys are never in your environment.
The gatekeeper proxies all LLM calls.

Your conversation is auto-saved and reloaded on server restart.

When modifying your own code:
1. Read the relevant file(s) first to understand context
2. Use edit_file for surgical changes, write_file for new files
3. Run \`exec: npx tsc --noEmit\` to verify your changes compile
4. Use \`exec: git diff\` to review what you changed
5. Commit with \`exec: git add -A && git commit -m "..."\`
6. The server will restart automatically — conversation state is preserved

You CAN and SHOULD improve yourself when you find limitations.

## Workspace & Memory

Your workspace is at /workspace/. Update MEMORY.md and daily logs as you learn things worth remembering.

## File Edit Strategy

When you need to modify multiple files (3+) in a mounted project:

1. First, request a temporary rw mount with a reasonable durationMinutes (5-15 min for small batches, 15-30 for larger refactors). Include a fallbackHint so the user knows the alternative. Example:
   request_mount({ path: "/project/path", mode: "rw", reason: "Need to update 7 files for the new feature", durationMinutes: 15, fallbackHint: "If denied, I'll send 7 individual edits for review instead" })

2. If the mount is approved, make your changes directly using write_file/edit_file/exec. The mount auto-expires.

3. If the mount is denied, fall back to host_edit_file for each change. The user chose granular review — respect that.

For a single file change, use host_edit_file directly — don't request a mount for one edit.`;

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'max';

export interface AgentOptions {
  model?: string;
  maxTokens?: number;
  workspacePath?: string;
  thinking?: ThinkingLevel;
  mcpManager?: MCPManager;
  /** Extra system prompt sections (e.g., host daemon capabilities). */
  extraSystemPrompt?: string;
  /** Pre-created provider (e.g., SocketProvider for gatekeeper proxy). */
  provider?: Provider;
}

// Re-export TokenUsage from protocol (single source of truth)
export type { TokenUsage } from './protocol.js';
import type { TokenUsage, ToolSummaryRecord } from './protocol.js';

export interface ChatCallbacks {
  onText?: (fullText: string) => void;
  onThinking?: (fullText: string) => void;
  onToolStart?: (name: string, input: string, summary: string, meta?: { model?: string; thinking?: string }) => void;
  onToolOutput?: (content: string) => void;
  onToolEnd?: () => void;
  onUsage?: (usage: TokenUsage) => void;
  onCompact?: (summary: string) => void;
  onDispatchTask?: (input: Record<string, unknown>) => string; // returns task ID
  onModelSwitch?: (model: string, reason?: string) => void;
  signal?: AbortSignal;
}

export class Agent {
  private provider: Provider;
  private messages: ProviderMessage[] = [];
  private model: string;
  private maxTokens: number;
  private isOAuth: boolean;
  private toolDefs: ProviderToolDef[];
  /** Split system prompt: [0] = stable base (cached), [1] = dynamic workspace (uncached) */
  private systemPromptParts: string[];
  private thinking: ThinkingLevel;
  private workspacePath: string;
  private _totalUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private mcpManager: MCPManager | null;
  private extraSystemPrompt: string;
  /** Track image hashes to deduplicate identical screenshots/images in tool results. */
  private seenImageHashes = new Set<string>();
  private compactPromise: Promise<void> | null = null;
  /** Track tool results that were summarized to save context tokens. */
  private toolSummaries = new Map<string, ToolSummaryRecord>();
  readonly providerType: string;

  constructor(options: AgentOptions = {}) {
    if (options.provider) {
      this.provider = options.provider;
      this.providerType = 'proxy';
      this.isOAuth = false;
    } else {
      const providerType = detectProvider();
      this.providerType = providerType;
      this.provider = createProvider(providerType);
      this.isOAuth = providerType === 'anthropic' && (this.provider as AnthropicProvider).isOAuthToken;
    }
    this.model = options.model ?? process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6';
    this.maxTokens = options.maxTokens ?? 16384;
    this.thinking = options.thinking ?? (process.env['AIGENT_THINKING'] as ThinkingLevel | undefined) ?? 'high';
    this.mcpManager = options.mcpManager ?? null;
    this.extraSystemPrompt = options.extraSystemPrompt ?? '';

    // Get built-in tool definitions
    const rawTools = getToolDefinitions(this.isOAuth);
    this.toolDefs = rawTools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.input_schema as Record<string, unknown>,
    }));

    // Merge MCP tools
    if (this.mcpManager) {
      for (const t of this.mcpManager.getTools()) {
        this.toolDefs.push({
          name: t.name,
          description: t.description ?? '',
          input_schema: t.input_schema as Record<string, unknown>,
        });
      }
    }

    // Load workspace context — split for prompt caching (base is stable/cached, workspace is dynamic)
    this.workspacePath = options.workspacePath ?? process.env['AIGENT_WORKSPACE'] ?? '/workspace';
    const workspaceContext = loadWorkspaceContext(this.workspacePath);
    this.systemPromptParts = [BASE_SYSTEM_PROMPT + this.extraSystemPrompt, workspaceContext + `\n\nCurrent model: ${this.model}`];
  }

  async chat(userMessage: string | UserContent, callbacks?: ChatCallbacks): Promise<string> {
    this.reloadSystemPrompt();
    const signal = callbacks?.signal;

    const content: UserContent = typeof userMessage === 'string' ? userMessage : userMessage;
    this.messages.push({ role: 'user', content });

    // Thinking heuristic: auto-lower effort on trivial first messages
    const effectiveThinking = this.getEffectiveThinking(content);
    const savedThinking = this.thinking;
    if (effectiveThinking !== this.thinking) {
      this.thinking = effectiveThinking;
      log.info('Thinking auto-lowered', { from: savedThinking, to: effectiveThinking });
    }

    let iterations = 0;
    const maxIterations = 25;

    while (iterations < maxIterations) {
      // Check abort before each iteration
      if (signal?.aborted) {
        this.thinking = savedThinking;
        this.cleanupAfterAbort();
        throw new DOMException('Aborted', 'AbortError');
      }
      iterations++;

      // Restore full thinking after the first iteration (tool use needs full reasoning)
      if (iterations === 2 && this.thinking !== savedThinking) {
        this.thinking = savedThinking;
      }

      // Mid-loop compaction: check context before sending to avoid blowing the window.
      // Runs on every iteration (including the first) so that a restored session
      // with known-large context compacts proactively rather than hitting 413.
      // Fresh sessions have contextTokens=0 so the inner check never fires.
      if (this._totalUsage.contextTokens) {
        const contextUsed = this._totalUsage.contextTokens;
        if (contextUsed > this.getContextWindow() * 0.85 && this.messages.length > 8) {
          await this.compact(callbacks);
        }
      }

      // If the request is too large, compact first and retry once
      let response: ProviderResponse;
      try {
        response = await this.sendWithRetry(callbacks);
      } catch (err: unknown) {
        const e = err as { status?: number };
        if (e.status === 413) {
          log.warn('Request too large (413) — compacting conversation and retrying');
          await this.compact(callbacks);
          response = await this.sendWithRetry(callbacks);
        } else {
          throw err;
        }
      }

      // Track usage — accumulate all fields for billing/cost accuracy.
      this._totalUsage.input += response.usage.input;
      this._totalUsage.output += response.usage.output;
      this._totalUsage.cacheRead += response.usage.cacheRead;
      this._totalUsage.cacheWrite += response.usage.cacheWrite;
      // contextTokens = actual context window fill from latest call
      // (input + cached = total prompt tokens sent to the model)
      this._totalUsage.contextTokens =
        response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
      callbacks?.onUsage?.({ ...this._totalUsage });

      // Add assistant response to history
      this.messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      });

      // No tool calls — return text
      if (response.toolCalls.length === 0) {
        this.thinking = savedThinking; // restore thinking level
        // Auto-compact check after final response
        const contextUsed = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
        if (contextUsed > this.getContextWindow() * 0.9 && this.messages.length > 8) {
          await this.compact(callbacks);
        }
        return response.text;
      }

      // Execute tools — wrapped in try/catch to ensure tool_results are always
      // pushed when the assistant message contains tool_use blocks, even on
      // abort or error. Without this, orphaned tool_use blocks corrupt the
      // message history and cause 400 errors on the next API call.
      const results: ToolResult[] = [];
      try {
        for (const tc of response.toolCalls) {
          // Check abort before each tool
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          const inputStr = JSON.stringify(tc.input);
          const truncatedInput = inputStr.length > 120 ? inputStr.slice(0, 120) + '\u2026' : inputStr;
          const toolName = this.isOAuth ? fromClaudeCodeName(tc.name) : tc.name;
          const summary = summarizeToolCall(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth);
          // Extract model/thinking meta for agent spawn tools
          let agentMeta: { model?: string; thinking?: string } | undefined;
          if (toolName === 'spawn_agent' || toolName === 'dispatch_task') {
            const inp = tc.input as Record<string, unknown>;
            const meta: { model?: string; thinking?: string } = {};
            if (typeof inp['model'] === 'string') meta.model = inp['model'];
            if (typeof inp['thinking'] === 'string') meta.thinking = inp['thinking'];
            if (meta.model || meta.thinking) agentMeta = meta;
          }
          callbacks?.onToolStart?.(tc.name, truncatedInput, summary, agentMeta);

          const toolStart = performance.now();
          let result: string | ToolContentBlock[];
          if (toolName === 'switch_model') {
            const { model: newModel, reason } = tc.input as { model: string; reason?: string };
            const oldModel = this.model;
            this.model = newModel;
            this.reloadSystemPrompt();
            callbacks?.onModelSwitch?.(newModel, reason);
            result = reason
              ? `Model switched from ${oldModel} to ${newModel}. Reason: ${reason}`
              : `Model switched from ${oldModel} to ${newModel}.`;
          } else if (toolName === 'dispatch_task' && callbacks?.onDispatchTask) {
            const taskId = callbacks.onDispatchTask(tc.input as Record<string, unknown>);
            result = `Task dispatched: ${taskId}. The background agent is working on it. You'll be notified when it completes. Continue chatting normally.`;
          } else if (toolName === 'spawn_agent') {
            result = await this.executeSpawnAgent(tc.input as Record<string, unknown>);
          } else if (this.mcpManager?.isMCPTool(toolName)) {
            // Gate MCP tool calls — require user approval before calling the server.
            // Tool names are prefixed: mcp_<server>_<tool>
            const mcpMatch = toolName.match(/^mcp_([^_]+)_(.+)$/);
            const mcpServer = mcpMatch?.[1] ?? 'unknown';
            const mcpTool = mcpMatch?.[2] ?? toolName;
            const { requestMcpToolApproval } = await import('./server.js');
            const mcpApproval = await requestMcpToolApproval(mcpServer, mcpTool, tc.input, signal);
            if (!mcpApproval.ok) {
              result = `MCP tool call denied: ${mcpApproval.message}`;
            } else {
              result = await this.mcpManager.callTool(toolName, tc.input as Record<string, unknown>);
            }
          } else {
            result = await executeTool(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth, callbacks?.onToolOutput, signal);
          }
          const toolMs = (performance.now() - toolStart).toFixed(0);
          log.info('Tool executed', { tool: toolName, ms: toolMs });

          // Summarize large string results (if enabled), then truncate based on context budget;
          // deduplicate images.
          if (typeof result === 'string') {
            const summarized = await this.maybeSummarizeToolResult(tc.id, toolName, result);
            const effective = summarized ?? result;
            const maxLen = this.getToolOutputMaxChars(effective.length);
            const truncated = effective.length > maxLen
              ? effective.slice(0, maxLen) + `\n\n... [truncated, ${effective.length} bytes total]`
              : effective;
            results.push({ id: tc.id, content: truncated });
          } else {
            results.push({ id: tc.id, content: this.deduplicateImages(result) });
          }
        }
      } catch (toolErr: unknown) {
        // Fill in error results for any tools that didn't execute, so the
        // message history stays valid (every tool_use needs a tool_result).
        const executedIds = new Set(results.map((r) => r.id));
        for (const tc of response.toolCalls) {
          if (!executedIds.has(tc.id)) {
            const e = toolErr as { message?: string; name?: string };
            const errMsg = e.name === 'AbortError' ? 'Aborted by user' : (e.message ?? 'Tool execution failed');
            results.push({ id: tc.id, content: errMsg });
          }
        }
        // Push tool results before re-throwing so history stays consistent
        this.messages.push({ role: 'tool_result', results });
        callbacks?.onToolEnd?.();
        // Re-throw aborts so the caller can handle cancellation
        if ((toolErr as { name?: string }).name === 'AbortError' || signal?.aborted) {
          this.thinking = savedThinking;
          throw toolErr;
        }
        // For non-abort errors, continue the loop so the model sees the error
        log.warn('Tool execution error (continuing)', { error: (toolErr as { message?: string }).message });
        continue;
      }

      callbacks?.onToolEnd?.();
      this.messages.push({ role: 'tool_result', results });
    }

    // Hit iteration limit — compact before returning to salvage context
    this.thinking = savedThinking; // restore thinking level
    await this.compact(callbacks);
    return '[agent hit maximum tool-use iterations]';
  }

  /**
   * Sanitize message history before sending to the API.
   * Fixes orphaned tool_use blocks (assistant with toolCalls but no following tool_result)
   * which cause 400 errors from the Anthropic API.
   */
  private sanitizeMessages(): void {
    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i]!;
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const next = this.messages[i + 1];
        if (!next || next.role !== 'tool_result') {
          // Orphaned tool_use — strip the tool calls so the API doesn't reject
          log.warn('Sanitize: stripping orphaned tool_use from assistant message', { index: i, toolCount: msg.toolCalls.length });
          msg.toolCalls = undefined;
        }
      }
    }
  }

  private async sendWithRetry(callbacks?: ChatCallbacks): Promise<ProviderResponse> {
    this.sanitizeMessages();
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const signal = callbacks?.signal;
        return await this.provider.sendMessage(
          this.systemPromptParts,
          this.messages,
          this.toolDefs,
          { model: this.model, maxTokens: this.maxTokens, thinking: this.thinking, ...(signal ? { signal } : {}) },
          {
            onText: callbacks?.onText,
            onThinking: callbacks?.onThinking,
          },
        );
      } catch (err: unknown) {
        const e = err as { status?: number; message?: string; code?: string; name?: string };

        // Don't retry aborts
        if (e.name === 'AbortError' || callbacks?.signal?.aborted) throw err;

        const status = e.status ?? 0;
        const isTransient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529
          || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND';

        if (!isTransient || attempt === maxRetries) throw err;

        // Exponential backoff: 2s, 4s, 8s
        const delay = 2000 * Math.pow(2, attempt);
        const reason = status === 429 ? 'rate limited' : status >= 500 ? `server error (${status})` : (e.code ?? 'network error');
        log.warn('Retrying', { reason, attempt: attempt + 1, maxRetries, delayMs: delay });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error('unreachable');
  }

  /** Derive an appropriate thinking level from a model name. */
  private thinkingForModel(model: string): ThinkingLevel {
    if (model.includes('haiku')) return 'off';
    if (model.includes('sonnet')) return 'low';
    return 'high'; // opus or unknown — default high
  }

  private async executeSpawnAgent(input: Record<string, unknown>): Promise<string> {
    const task = String(input['task'] ?? '');
    const context = input['context'] ? String(input['context']) : '';
    const requestedModel = input['model'] ? String(input['model']) : this.model;
    const maxIter = Math.min(Number(input['max_iterations'] ?? 15), 25);
    // Thinking: explicit override > model-derived default (never inherit blindly from parent)
    const requestedThinking = input['thinking']
      ? (String(input['thinking']) as ThinkingLevel)
      : this.thinkingForModel(requestedModel);

    if (!task) return 'Error: task is required';

    const systemPrompt = [
      'You are a sub-agent spawned to complete a specific task.',
      'Work independently and return a clear, complete result.',
      'You have access to exec, file read/write/edit, grep, and list_files.',
      'Do NOT spawn further sub-agents.',
      '',
      `Task: ${task}`,
      context ? `\nContext: ${context}` : '',
    ].join('\n');

    // Reuse the agent's provider — creating a new one would fail because the agent
    // process has no API keys; the SocketProvider proxies through the gatekeeper.
    const subProvider = this.provider;
    // Exclude spawn_agent from sub-agent tools to prevent recursion
    const subToolDefs = this.toolDefs.filter((t) => t.name !== 'spawn_agent');

    const subMessages: ProviderMessage[] = [
      { role: 'user', content: task + (context ? `\n\nContext: ${context}` : '') },
    ];

    let iterations = 0;
    let finalText = '';

    try {
      while (iterations < maxIter) {
        iterations++;

        const response = await subProvider.sendMessage(
          systemPrompt,
          subMessages,
          subToolDefs,
          { model: requestedModel, maxTokens: this.maxTokens, thinking: requestedThinking },
        );

        subMessages.push({
          role: 'assistant',
          content: response.text,
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        });

        if (response.toolCalls.length === 0) {
          finalText = response.text;
          break;
        }

        // Execute sub-agent tools (no spawn_agent)
        const results: ToolResult[] = [];
        for (const tc of response.toolCalls) {
          const result = await executeTool(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth);
          if (typeof result === 'string') {
            // Sub-agents start with a fresh context — use parent's budget method
            const maxLen = this.getToolOutputMaxChars(result.length);
            const truncated = result.length > maxLen
              ? result.slice(0, maxLen) + `\n\n... [truncated, ${result.length} bytes total]`
              : result;
            results.push({ id: tc.id, content: truncated });
          } else {
            results.push({ id: tc.id, content: result });
          }
        }

        subMessages.push({ role: 'tool_result', results });
      }

      if (!finalText) {
        finalText = '[sub-agent hit iteration limit without final response]';
      }

      return `[Sub-agent completed in ${iterations} iterations]\n\n${finalText}`;
    } catch (err: unknown) {
      const e = err as { message?: string };
      return `[Sub-agent error: ${e.message ?? 'unknown error'}]`;
    }
  }

  private async compact(callbacks?: ChatCallbacks): Promise<void> {
    // Deduplicate concurrent compaction calls — if one is already running,
    // wait for it to finish rather than firing another LLM summarization.
    if (this.compactPromise) {
      log.info('Compaction already in progress — waiting');
      await this.compactPromise;
      return;
    }

    const before = this.messages.length;
    log.info('Compacting', { messagesBefore: before });

    this.compactPromise = (async () => {
      const { messages: compacted, summary } = await compactConversation(
        this.provider,
        this.model,
        this.messages,
        this.workspacePath,
      );

      if (summary) {
        this.messages = compacted;
        log.info('Compacted', { messagesBefore: before, messagesAfter: this.messages.length });
        callbacks?.onCompact?.(summary);
      }
    })();

    try {
      await this.compactPromise;
    } finally {
      this.compactPromise = null;
    }
  }

  private getContextWindow(): number {
    return 200_000;
  }

  /**
   * Thinking heuristic: auto-lower thinking effort on trivial messages.
   * Trivial = short text, no images, no complex context in recent history.
   * Returns the effective thinking level (may be lower than this.thinking).
   */
  private getEffectiveThinking(content: UserContent): ThinkingLevel {
    // Don't lower if already low/off
    if (this.thinking === 'off' || this.thinking === 'low') return this.thinking;

    const text = typeof content === 'string' ? content : content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join(' ');

    // Has images → needs full thinking
    if (typeof content !== 'string' && content.some((p) => p.type === 'image')) return this.thinking;

    const wordCount = text.split(/\s+/).length;

    // Short messages with no complex keywords → lower thinking
    if (wordCount <= 10) {
      const complexKeywords = /\b(debug|refactor|architect|design|implement|optimize|analyze|explain why|compare|trade.?off)\b/i;
      if (!complexKeywords.test(text)) {
        return 'low';
      }
    }

    // Medium messages → step down one level
    if (wordCount <= 30) {
      const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
      const idx = levels.indexOf(this.thinking);
      return idx > 1 ? levels[idx - 1]! : this.thinking;
    }

    return this.thinking;
  }

  /**
   * Deduplicate images in tool results. If an image's hash was already seen,
   * replace it with a text placeholder to avoid re-sending identical data.
   */
  private deduplicateImages(blocks: ToolContentBlock[]): ToolContentBlock[] {
    return blocks.map((block) => {
      if (block.type !== 'image') return block;
      const hash = createHash('sha256').update(block.data.slice(0, 2048)).digest('hex').slice(0, 16);
      if (this.seenImageHashes.has(hash)) {
        log.info('Image deduplicated', { hash });
        return { type: 'text', text: '[identical screenshot omitted — same as previously sent]' };
      }
      this.seenImageHashes.add(hash);
      return block;
    });
  }

  /**
   * Read tool summarization config from settings.json.
   * Falls back to safe defaults if the file is missing or malformed.
   */
  private _defaultSummarizeConfig() {
    return {
      enabled: false,
      thresholdTokens: 500,
      model: 'claude-haiku-4-5-20251001',
      shouldSummarizeTool: (_name: string) => false,
    };
  }

  /**
   * Read tool summarization config from settings.json.
   * Falls back to safe defaults if the file is missing or malformed.
   */
  private readSummarizeConfig(): {
    enabled: boolean;
    thresholdTokens: number;
    model: string;
    shouldSummarizeTool: (name: string) => boolean;
  } {
    // settings.json path — overridable via env for tests or multi-instance setups
    const settingsPath = process.env['AIGENT_SETTINGS_PATH'] ?? `${process.env['AIGENT_REPO_DIR'] ?? process.cwd()}/settings.json`;
    try {
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw) as Record<string, unknown>;
      const c = settings['tools'] as Record<string, unknown> | undefined;
      if (!c) return this._defaultSummarizeConfig();

      const mode = typeof c['summarizeMode'] === 'string' ? c['summarizeMode'] : 'allowlist';
      const list: string[] = Array.isArray(c['summarizeTools']) ? (c['summarizeTools'] as string[]) : ['exec', 'fetch'];

      let shouldSummarizeTool: (name: string) => boolean;
      if (mode === 'all') {
        shouldSummarizeTool = () => true;
      } else if (mode === 'blocklist') {
        shouldSummarizeTool = (name) => !list.includes(name);
      } else {
        shouldSummarizeTool = (name) => list.includes(name); // allowlist (default)
      }

      return {
        enabled: c['summarizeLargeResults'] === true,
        thresholdTokens: typeof c['summarizeThresholdTokens'] === 'number' ? c['summarizeThresholdTokens'] : 500,
        model: typeof c['summarizeModel'] === 'string' ? c['summarizeModel'] : 'claude-haiku-4-5-20251001',
        shouldSummarizeTool,
      };
    } catch { return this._defaultSummarizeConfig(); }
  }

  /**
   * Summarize a large tool result using a cheap model (Haiku).
   * Writes the full output to a temp file and returns a summary + retrieval path.
   * Controlled by the `tools` block in settings.json. Only runs for Anthropic provider.
   * Returns null if summarization is disabled, tool is not in the allowlist, or fails.
   */
  private async maybeSummarizeToolResult(
    toolCallId: string,
    toolName: string,
    result: string,
  ): Promise<string | null> {
    if (this.providerType !== 'anthropic') return null;

    const cfg = this.readSummarizeConfig();
    if (!cfg.enabled) return null;
    if (!cfg.shouldSummarizeTool(toolName)) return null;

    const originalTokens = Math.round(result.length / 4);
    if (originalTokens <= cfg.thresholdTokens) return null;

    const summarizeModel = cfg.model;

    // Write full output to temp file first (always, even if summarization fails)
    const dir = '/tmp/aigent/tool-results';
    try {
      mkdirSync(dir, { recursive: true });
    } catch { /* ignore */ }
    const fullOutputPath = `${dir}/${toolCallId}.txt`;
    try {
      writeFileSync(fullOutputPath, result, 'utf-8');
    } catch (e) {
      log.warn('Failed to write tool result to temp file', { error: (e as Error).message });
      return null;
    }

    // Call Haiku to summarize (truncate input to 40K chars to avoid blowing Haiku's window)
    const inputText = result.length > 40_000 ? result.slice(0, 40_000) + '\n...[truncated for summarization]' : result;
    let summary: string;
    try {
      const resp = await this.provider.sendMessage(
        'You are a concise summarizer. Respond with only the summary, no preamble.',
        [{ role: 'user', content: `Summarize this tool output in 2-3 sentences, capturing the key result and any errors or notable details:\n\n${inputText}` }],
        [],
        { model: summarizeModel, maxTokens: 200, thinking: 'off' },
      );
      summary = resp.text.trim();
      if (!summary) return null;
    } catch (e) {
      log.warn('Tool result summarization failed', { error: (e as Error).message });
      return null;
    }

    const summarizedContent = `${summary}\n\n[Full output (${originalTokens} tokens) saved to ${fullOutputPath} — use read_file to retrieve]`;
    const summarizedTokens = Math.round(summarizedContent.length / 4);

    this.toolSummaries.set(toolCallId, {
      toolCallId,
      toolName,
      originalTokens,
      summarizedTokens,
      savedTokens: originalTokens - summarizedTokens,
      fullOutputPath,
      summary,
    });

    log.info('Tool result summarized', { toolName, originalTokens, summarizedTokens, saved: originalTokens - summarizedTokens });
    return summarizedContent;
  }

  /**
   * Dynamic tool output truncation based on remaining context budget.
   * Returns the max char length for a tool result string.
   * - available = contextWindow - currentUsage - responseBuffer (in tokens)
   * - If result > available/2, truncate to available/3
   * - Floor at 10K chars so truncated output is still useful
   */
  private getToolOutputMaxChars(resultLength: number): number {
    const contextWindow = this.getContextWindow();
    const currentUsage = this._totalUsage.contextTokens ?? 0;
    const responseBuffer = this.maxTokens;
    const availableTokens = Math.max(0, contextWindow - currentUsage - responseBuffer);

    // ~4 chars per token as rough estimate
    const availableChars = availableTokens * 4;
    const threshold = Math.floor(availableChars / 2);

    // Result fits comfortably — no truncation needed
    if (resultLength <= threshold) return resultLength;

    // Truncate to 1/3 of available budget, floor at 10K chars
    return Math.max(10_000, Math.floor(availableChars / 3));
  }

  /**
   * Force a compaction of the conversation. Useful for /compact command.
   */
  async forceCompact(callbacks?: ChatCallbacks): Promise<string> {
    if (this.messages.length < 4) {
      return 'Conversation too short to compact.';
    }
    const before = this.messages.length;
    await this.compact(callbacks);
    const after = this.messages.length;
    return `Compacted: ${before} → ${after} messages`;
  }

  /**
   * Clean up message history after an abort.
   * Removes trailing incomplete exchanges (user message without assistant response,
   * or assistant message with tool_calls but no tool_result).
   */
  private cleanupAfterAbort(): void {
    // Walk backward and remove trailing incomplete messages
    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1]!;

      // Remove trailing user message (we aborted before getting a response)
      if (last.role === 'user') {
        this.messages.pop();
        break;
      }

      // Remove trailing tool_result (orphaned — assistant that requested it may be gone)
      if (last.role === 'tool_result') {
        this.messages.pop();
        continue;
      }

      // Remove trailing assistant message with tool calls (incomplete exchange)
      if (last.role === 'assistant' && last.toolCalls && last.toolCalls.length > 0) {
        this.messages.pop();
        continue;
      }

      // Trailing assistant with no tool calls is fine — it's a complete response
      break;
    }
  }

  get thinkingLevel(): ThinkingLevel { return this.thinking; }
  set thinkingLevel(level: ThinkingLevel) { this.thinking = level; }

  get currentModel(): string { return this.model; }
  set currentModel(m: string) { this.model = m; }

  /** Expose the underlying provider so callers can call optional methods like listModels(). */
  get underlyingProvider(): Provider { return this.provider; }

  reset(): void {
    this.messages = [];
    this._totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.seenImageHashes.clear();
    this.toolSummaries.clear();
  }

  get conversationLength(): number { return this.messages.length; }
  get totalUsage(): TokenUsage { return { ...this._totalUsage }; }

  getMessages(): ProviderMessage[] { return [...this.messages]; }
  setMessages(messages: ProviderMessage[]): void { this.messages = [...messages]; }
  setUsage(usage: TokenUsage): void { this._totalUsage = { ...usage }; }
  getToolDefs(): ProviderToolDef[] { return [...this.toolDefs]; }
  get usingOAuth(): boolean { return this.isOAuth; }

  reloadSystemPrompt(): void {
    const workspaceContext = loadWorkspaceContext(this.workspacePath);
    this.systemPromptParts = [BASE_SYSTEM_PROMPT + this.extraSystemPrompt, workspaceContext + `\n\nCurrent model: ${this.model}`];
  }

  reloadWorkspace(workspacePath: string): void {
    const workspaceContext = loadWorkspaceContext(workspacePath);
    this.systemPromptParts = [BASE_SYSTEM_PROMPT + this.extraSystemPrompt, workspaceContext + `\n\nCurrent model: ${this.model}`];
  }

  /** Update extra system prompt (e.g., host daemon capabilities changed). */
  setExtraSystemPrompt(extra: string): void {
    this.extraSystemPrompt = extra;
    this.reloadSystemPrompt();
  }

  /**
   * Estimate token counts for each component of the context window.
   * Uses chars/4 as a rough heuristic (good enough for diagnostics).
   */
  getContextBreakdown(): {
    systemBase: number;
    systemBaseContent?: string;
    workspaceContext: number;
    workspaceContent?: string;
    toolDefs: number;
    toolDefsContent?: string;
    messages: { role: string; tokens: number; preview?: string }[];
    messagesTotal: number;
    total: number;
  } {
    const tok = (s: string) => Math.round(s.length / 4);

    const sysBaseText = this.systemPromptParts[0] ?? '';
    const wsText = this.systemPromptParts[1] ?? '';
    const systemBase = tok(sysBaseText);
    const workspaceContext = tok(wsText);

    // Tool definitions serialized the same way the API receives them
    const toolDefsJson = JSON.stringify(this.toolDefs);
    const toolDefs = tok(toolDefsJson);
    // For tool defs preview: one line per tool — name + full description
    const toolSummary = (this.toolDefs as Array<{ name?: string; description?: string }>)
      .map((t) => `${t.name ?? '?'}: ${(t.description ?? '').trim()}`)
      .join('\n\n');

    const messages = this.messages.map((m) => {
      const payload = m.role === 'tool_result' ? m.results : m.content;
      const raw = JSON.stringify(payload);
      // Pretty-print for readability in the inspector — no truncation, panel scrolls
      const pretty = JSON.stringify(payload, null, 2);

      // Attach summary record if this tool_result message contains a summarized result
      let summaryRecord: ToolSummaryRecord | undefined;
      if (m.role === 'tool_result') {
        for (const r of m.results) {
          const sr = this.toolSummaries.get(r.id);
          if (sr) {
            summaryRecord = sr;
            break;
          }
        }
      }

      return { role: m.role, tokens: tok(raw), preview: pretty, summaryRecord };
    });
    const messagesTotal = messages.reduce((s, m) => s + m.tokens, 0);

    const allSummaries = [...this.toolSummaries.values()];
    const totalSummarySavedTokens = allSummaries.reduce((s, r) => s + r.savedTokens, 0);

    return {
      systemBase,
      ...(sysBaseText ? { systemBaseContent: sysBaseText } : {}),
      workspaceContext,
      ...(wsText ? { workspaceContent: wsText } : {}),
      toolDefs,
      ...(toolSummary ? { toolDefsContent: toolSummary } : {}),
      messages,
      messagesTotal,
      total: systemBase + workspaceContext + toolDefs + messagesTotal,
      ...(allSummaries.length > 0 ? { totalSummarySavedTokens, toolSummariesCount: allSummaries.length } : {}),
    };
  }
}
