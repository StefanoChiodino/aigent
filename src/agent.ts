import { createHash } from 'node:crypto';
import { createProvider, detectProvider, type Provider, type ProviderMessage, type ProviderResponse, type ProviderToolDef, type AnthropicProvider, type UserContent, type ToolContentBlock, type ToolResult } from './provider.js';
import { getToolDefinitions, executeTool, summarizeToolCall, fromClaudeCodeName } from './tools.js';
import { loadWorkspaceContext } from './workspace.js';
import { compactConversation } from './compact.js';
import type { MCPManager } from './mcp.js';
import { createLogger } from './logger.js';

const log = createLogger('agent');

const BASE_SYSTEM_PROMPT = `You are an AI agent running inside a Docker container. You have access to:
- A shell (exec tool) to run any command, with optional cwd
- File read/write/edit to inspect and modify files (read_file supports line ranges via offset/limit)
- grep, glob, and list_files for searching and navigating
- tree for visualizing directory structure
- fetch for HTTP requests (with text_only mode for web pages)
- patch for applying multiple edits to a file at once
- screenshot to capture the virtual display (verify GUI state, browser content, etc.)
- dispatch_task to run long tasks in the background (non-blocking — you keep chatting)
- spawn_agent to run a sub-agent synchronously (blocks until complete)
- switch_model to change your active model mid-conversation (upgrade for complex tasks, downgrade for simple ones)
- host to access OS capabilities via the host daemon (clipboard, audio, screen, etc.)
- request_mount to ask the user for access to a folder on their machine
- MCP tools from connected servers (if configured via mcp.json)
- Internet access via curl, wget, etc.

Be direct. Be helpful. Execute commands to verify things rather than guessing.

## Your Own Source Code

You are a self-authoring agent. Your source code is mounted at /app/ from the host filesystem.
Any changes you make to files in /app/ persist on the host and are visible to your user.

Architecture (backend/frontend split):
  /app/src/server.ts    — Agent backend server (Unix socket, manages agent lifecycle)
  /app/src/client.ts    — Client connector (TUI connects to server)
  /app/src/agent.ts     — Agent class, conversation loop, streaming
  /app/src/protocol.ts  — Shared types for client-server communication
  /app/src/auth.ts      — API key / OAT token handling
  /app/src/provider.ts  — Multi-provider abstraction (Anthropic + OpenAI)
  /app/src/tools.ts     — Tool definitions and execution (12 tools)
  /app/src/host-client.ts — Client for host daemon (clipboard, audio, screen)
  /app/src/host/        — Host daemon (runs on host, not in Docker)
  /app/src/workspace.ts — Workspace file loading
  /app/src/supervisor.tsx — Process manager (server + TUI)
  /app/src/index.tsx    — TUI entry point
  /app/src/repl.ts      — Fallback readline REPL
  /app/src/ui/          — ink (React) TUI components

The supervisor watches for source file changes and restarts only the backend server.
The TUI frontend survives server restarts — it reconnects automatically and restores
conversation state. Your conversation is auto-saved and reloaded on server restart.

When modifying your own code:
1. Read the relevant file(s) first to understand context
2. Use edit_file for surgical changes, write_file for new files
3. Run \`exec: npx tsc --noEmit\` to verify your changes compile
4. Use \`exec: git diff\` to review what you changed
5. Commit with \`exec: git add -A && git commit -m "..."\`
6. The server will restart automatically — the TUI reconnects seamlessly

You CAN and SHOULD improve yourself when you find limitations.

## Workspace & Memory

Your workspace is at /workspace/. It contains persistent files that survive restarts:
- AGENTS.md — your operating instructions
- SOUL.md — your personality and values
- USER.md — info about your user
- MEMORY.md — long-term curated memory
- TOOLS.md — tool notes and gotchas
- memory/YYYY-MM-DD.md — daily session logs

Update these files as you learn. If it's worth remembering, write it down.`;

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
import type { TokenUsage } from './protocol.js';

export interface ChatCallbacks {
  onText?: (fullText: string) => void;
  onThinking?: (fullText: string) => void;
  onToolStart?: (name: string, input: string, summary: string) => void;
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
    this.model = options.model ?? process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';
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

      // Mid-loop compaction: check context before sending to avoid blowing the window
      if (iterations > 1 && this._totalUsage.contextTokens) {
        const contextUsed = this._totalUsage.contextTokens;
        if (contextUsed > this.getContextWindow() * 0.6 && this.messages.length > 8) {
          await this.compact(callbacks);
        }
      }

      const response = await this.sendWithRetry(callbacks);

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
        if (contextUsed > this.getContextWindow() * 0.7 && this.messages.length > 8) {
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
          callbacks?.onToolStart?.(tc.name, truncatedInput, summary);

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
            result = await this.mcpManager.callTool(toolName, tc.input as Record<string, unknown>);
          } else {
            result = await executeTool(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth, callbacks?.onToolOutput);
          }
          const toolMs = (performance.now() - toolStart).toFixed(0);
          log.info('Tool executed', { tool: toolName, ms: toolMs });

          // Truncate string results based on remaining context budget; deduplicate images
          if (typeof result === 'string') {
            const maxLen = this.getToolOutputMaxChars(result.length);
            const truncated = result.length > maxLen
              ? result.slice(0, maxLen) + `\n\n... [truncated, ${result.length} bytes total]`
              : result;
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

  private async executeSpawnAgent(input: Record<string, unknown>): Promise<string> {
    const task = String(input['task'] ?? '');
    const context = input['context'] ? String(input['context']) : '';
    const requestedModel = input['model'] ? String(input['model']) : this.model;
    const maxIter = Math.min(Number(input['max_iterations'] ?? 15), 25);

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

    // Reuse the agent's provider — creating a new one would fail in the
    // sandbox (no API keys; the SocketProvider proxies through the gatekeeper).
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
          { model: requestedModel, maxTokens: this.maxTokens, thinking: this.thinking },
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
    const before = this.messages.length;
    log.info('Compacting', { messagesBefore: before });

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
}
