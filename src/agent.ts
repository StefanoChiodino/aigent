import { createProvider, detectProvider, type Provider, type ProviderMessage, type ProviderResponse, type ProviderToolDef, type AnthropicProvider } from './provider.js';
import { getToolDefinitions, executeTool, summarizeToolCall, fromClaudeCodeName } from './tools.js';
import { loadWorkspaceContext } from './workspace.js';
import { compactConversation } from './compact.js';

const BASE_SYSTEM_PROMPT = `You are an AI agent running inside a Docker container. You have access to:
- A shell (exec tool) to run any command
- File read/write/edit to inspect and modify files
- grep and list_files for searching and navigating
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
  /app/src/tools.ts     — Tool definitions and execution
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
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ChatCallbacks {
  onText?: (fullText: string) => void;
  onThinking?: (fullText: string) => void;
  onToolStart?: (name: string, input: string, summary: string) => void;
  onToolEnd?: () => void;
  onUsage?: (usage: TokenUsage) => void;
  onCompact?: (summary: string) => void;
}

export class Agent {
  private provider: Provider;
  private messages: ProviderMessage[] = [];
  private model: string;
  private maxTokens: number;
  private isOAuth: boolean;
  private toolDefs: ProviderToolDef[];
  private systemPromptText: string;
  private thinking: ThinkingLevel;
  private workspacePath: string;
  private _totalUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  readonly providerType: string;

  constructor(options: AgentOptions = {}) {
    const providerType = detectProvider();
    this.providerType = providerType;
    this.provider = createProvider(providerType);
    this.isOAuth = providerType === 'anthropic' && (this.provider as AnthropicProvider).isOAuthToken;
    this.model = options.model ?? process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';
    this.maxTokens = options.maxTokens ?? 16384;
    this.thinking = options.thinking ?? (process.env['AIGENT_THINKING'] as ThinkingLevel | undefined) ?? 'high';

    // Get tool definitions
    const rawTools = getToolDefinitions(this.isOAuth);
    this.toolDefs = rawTools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.input_schema as Record<string, unknown>,
    }));

    // Load workspace context
    this.workspacePath = options.workspacePath ?? process.env['AIGENT_WORKSPACE'] ?? '/workspace';
    const workspaceContext = loadWorkspaceContext(this.workspacePath);
    this.systemPromptText = BASE_SYSTEM_PROMPT + workspaceContext;
  }

  async chat(userMessage: string, callbacks?: ChatCallbacks): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    let iterations = 0;
    const maxIterations = 25;

    while (iterations < maxIterations) {
      iterations++;

      const response = await this.sendWithRetry(callbacks);

      // Track usage
      this._totalUsage.input += response.usage.input;
      this._totalUsage.output += response.usage.output;
      this._totalUsage.cacheRead += response.usage.cacheRead;
      this._totalUsage.cacheWrite += response.usage.cacheWrite;
      callbacks?.onUsage?.({ ...this._totalUsage });

      // Add assistant response to history
      this.messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      });

      // No tool calls — return text
      if (response.toolCalls.length === 0 || response.stopReason === 'end_turn') {
        // Auto-compact check
        const contextUsed = this._totalUsage.input + this._totalUsage.output;
        if (contextUsed > this.getContextWindow() * 0.7 && this.messages.length > 12) {
          await this.compact(callbacks);
        }
        return response.text;
      }

      // Execute tools
      const results: { id: string; content: string }[] = [];
      for (const tc of response.toolCalls) {
        const inputStr = JSON.stringify(tc.input);
        const truncatedInput = inputStr.length > 120 ? inputStr.slice(0, 120) + '\u2026' : inputStr;
        const toolName = this.isOAuth ? fromClaudeCodeName(tc.name) : tc.name;
        const summary = summarizeToolCall(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth);
        callbacks?.onToolStart?.(tc.name, truncatedInput, summary);

        let result: string;
        if (toolName === 'spawn_agent') {
          result = await this.executeSpawnAgent(tc.input as Record<string, unknown>);
        } else {
          result = executeTool(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth);
        }

        const maxLen = 50_000;
        const truncated = result.length > maxLen
          ? result.slice(0, maxLen) + `\n\n... [truncated, ${result.length} bytes total]`
          : result;

        results.push({ id: tc.id, content: truncated });
      }

      callbacks?.onToolEnd?.();
      this.messages.push({ role: 'tool_result', results });
    }

    return '[agent hit maximum tool-use iterations]';
  }

  private async sendWithRetry(callbacks?: ChatCallbacks): Promise<ProviderResponse> {
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.provider.sendMessage(
          this.systemPromptText,
          this.messages,
          this.toolDefs,
          { model: this.model, maxTokens: this.maxTokens, thinking: this.thinking },
          {
            onText: callbacks?.onText,
            onThinking: callbacks?.onThinking,
          },
        );
      } catch (err: unknown) {
        const e = err as { status?: number; message?: string; code?: string };
        const status = e.status ?? 0;
        const isTransient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529
          || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND';

        if (!isTransient || attempt === maxRetries) throw err;

        // Exponential backoff: 2s, 4s, 8s
        const delay = 2000 * Math.pow(2, attempt);
        const reason = status === 429 ? 'rate limited' : status >= 500 ? `server error (${status})` : (e.code ?? 'network error');
        console.error(`[agent] ${reason}, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${maxRetries})...`);
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

    // Create a sub-agent with its own conversation but same provider/tools
    // Exclude spawn_agent from sub-agent tools to prevent recursion
    const subProvider = createProvider(detectProvider());
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

        if (response.toolCalls.length === 0 || response.stopReason === 'end_turn') {
          finalText = response.text;
          break;
        }

        // Execute sub-agent tools (no spawn_agent)
        const results: { id: string; content: string }[] = [];
        for (const tc of response.toolCalls) {
          const result = executeTool(tc.name, tc.input as Parameters<typeof executeTool>[1], this.isOAuth);
          const truncated = result.length > 50_000
            ? result.slice(0, 50_000) + '\n\n... [truncated]'
            : result;
          results.push({ id: tc.id, content: truncated });
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
    const { messages: compacted, summary } = await compactConversation(
      this.provider,
      this.model,
      this.messages,
      this.workspacePath,
    );

    if (summary) {
      this.messages = compacted;
      callbacks?.onCompact?.(summary);
    }
  }

  private getContextWindow(): number {
    return 200_000;
  }

  get thinkingLevel(): ThinkingLevel { return this.thinking; }
  set thinkingLevel(level: ThinkingLevel) { this.thinking = level; }

  reset(): void {
    this.messages = [];
    this._totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  get conversationLength(): number { return this.messages.length; }
  get totalUsage(): TokenUsage { return { ...this._totalUsage }; }

  getMessages(): ProviderMessage[] { return [...this.messages]; }
  setMessages(messages: ProviderMessage[]): void { this.messages = [...messages]; }

  reloadWorkspace(workspacePath: string): void {
    const workspaceContext = loadWorkspaceContext(workspacePath);
    this.systemPromptText = BASE_SYSTEM_PROMPT + workspaceContext;
  }
}
