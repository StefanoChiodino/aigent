import type Anthropic from '@anthropic-ai/sdk';
import type { TextBlock, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { createClient, buildSystemPrompt } from './auth.js';
import { getToolDefinitions, executeTool, summarizeToolCall } from './tools.js';
import { loadWorkspaceContext } from './workspace.js';

const BASE_SYSTEM_PROMPT = `You are an AI agent running inside a Docker container. You have access to:
- A shell (exec tool) to run any command
- File read/write/edit to inspect and modify files
- grep and list_files for searching and navigating
- Internet access via curl, wget, etc.

Be direct. Be helpful. Execute commands to verify things rather than guessing.

## Your Own Source Code

You are a self-authoring agent. Your source code is mounted at /app/ from the host filesystem.
Any changes you make to files in /app/ persist on the host and are visible to your user.

Architecture:
  /app/src/index.tsx    — Entry point, TUI/REPL launcher
  /app/src/agent.ts     — Agent class, conversation loop, streaming
  /app/src/auth.ts      — API key / OAT token handling
  /app/src/tools.ts     — Tool definitions and execution
  /app/src/workspace.ts — Workspace file loading
  /app/src/repl.ts      — Fallback readline REPL
  /app/src/ui/          — ink (React) TUI components
    App.tsx, ChatView.tsx, InputBar.tsx, StatusBar.tsx

The container runs tsx --watch, so saving any source file auto-restarts the process.
Your conversation will reset on restart, but workspace memory persists.

When modifying your own code:
1. Read the relevant file(s) first to understand context
2. Use edit_file for surgical changes, write_file for new files
3. Run \`exec: npx tsc --noEmit\` to verify your changes compile
4. Use \`exec: git diff\` to review what you changed
5. Commit with \`exec: git add -A && git commit -m "..."\`

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
  apiKey?: string;
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
}

export interface AgentInit {
  isOAuth: boolean;
  workspaceFileCount: number;
  workspacePath: string;
}

export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private model: string;
  private maxTokens: number;
  private isOAuth: boolean;
  private tools: Anthropic.Tool[];
  private systemPromptText: string;
  private thinking: ThinkingLevel;
  private _totalUsage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  constructor(options: AgentOptions = {}) {
    const apiKey = options.apiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    if (!apiKey) {
      throw new Error(
        'No API key found. Set ANTHROPIC_API_KEY in your environment or .env file.'
      );
    }

    const { client, isOAuth } = createClient(apiKey);
    this.client = client;
    this.isOAuth = isOAuth;
    this.model = options.model ?? process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';
    this.maxTokens = options.maxTokens ?? 16384;
    this.tools = getToolDefinitions(isOAuth);
    this.thinking = options.thinking ?? (process.env['AIGENT_THINKING'] as ThinkingLevel | undefined) ?? 'medium';

    // Load workspace context into system prompt
    const workspacePath = options.workspacePath ?? process.env['AIGENT_WORKSPACE'] ?? '/workspace';
    const workspaceContext = loadWorkspaceContext(workspacePath);
    this.systemPromptText = BASE_SYSTEM_PROMPT + workspaceContext;
  }

  /** Get initialization info for display */
  getInitInfo(): AgentInit {
    const workspacePath = process.env['AIGENT_WORKSPACE'] ?? '/workspace';
    const workspaceContext = loadWorkspaceContext(workspacePath);
    const fileCount = workspaceContext ? (workspaceContext.match(/^## /gm) ?? []).length : 0;
    return {
      isOAuth: this.isOAuth,
      workspaceFileCount: fileCount,
      workspacePath,
    };
  }

  /**
   * Send a message and get a response.
   * Supports streaming callbacks for real-time UI updates.
   */
  async chat(userMessage: string, callbacks?: ChatCallbacks): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    let iterations = 0;
    const maxIterations = 25;

    while (iterations < maxIterations) {
      iterations++;

      const systemPrompt = buildSystemPrompt(this.systemPromptText, this.isOAuth);

      // Build request params
      const params: Record<string, unknown> = {
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        tools: this.tools,
        messages: this.messages,
      };

      // Add extended thinking for supported models
      if (this.thinking !== 'off' && this.supportsAdaptiveThinking()) {
        params['thinking'] = { type: 'adaptive' };
        params['output_config'] = { effort: this.thinking };
      }

      // Use streaming API
      const stream = this.client.messages.stream(params as Parameters<typeof this.client.messages.stream>[0]);

      // Accumulate streaming text for real-time display
      let currentText = '';
      stream.on('text', (text) => {
        currentText += text;
        callbacks?.onText?.(currentText);
      });

      const response = await stream.finalMessage();

      // Track token usage
      const usage = response.usage;
      this._totalUsage.input += usage.input_tokens;
      this._totalUsage.output += usage.output_tokens;
      this._totalUsage.cacheRead += (usage as unknown as Record<string, number>)['cache_read_input_tokens'] ?? 0;
      this._totalUsage.cacheWrite += (usage as unknown as Record<string, number>)['cache_creation_input_tokens'] ?? 0;
      callbacks?.onUsage?.({ ...this._totalUsage });

      // Add assistant response to history
      this.messages.push({ role: 'assistant', content: response.content });

      // Find tool use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      );

      // If no tool calls or end of turn, extract text and return
      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        const textBlocks = response.content.filter(
          (block): block is TextBlock => block.type === 'text'
        );
        return textBlocks.map((b) => b.text).join('\n');
      }

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const toolInput = toolUse.input as Parameters<typeof executeTool>[1];
        const inputStr = JSON.stringify(toolUse.input);
        const truncatedInput = inputStr.length > 120 ? inputStr.slice(0, 120) + '…' : inputStr;
        const summary = summarizeToolCall(toolUse.name, toolInput, this.isOAuth);
        callbacks?.onToolStart?.(toolUse.name, truncatedInput, summary);

        const result = executeTool(toolUse.name, toolInput, this.isOAuth);

        // Truncate very large results
        const maxResultLen = 50_000;
        const truncatedResult =
          result.length > maxResultLen
            ? result.slice(0, maxResultLen) + `\n\n... [truncated, ${result.length} bytes total]`
            : result;

        toolResults.push({
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: truncatedResult,
        });
      }

      callbacks?.onToolEnd?.();
      this.messages.push({ role: 'user', content: toolResults });
    }

    return '[agent hit maximum tool-use iterations]';
  }

  /** Check if the current model supports adaptive thinking */
  private supportsAdaptiveThinking(): boolean {
    return this.model.includes('opus-4-6') || this.model.includes('opus-4.6');
  }

  /** Get/set thinking level */
  get thinkingLevel(): ThinkingLevel {
    return this.thinking;
  }

  set thinkingLevel(level: ThinkingLevel) {
    this.thinking = level;
  }

  /** Reset conversation history */
  reset(): void {
    this.messages = [];
  }

  /** Get current conversation length */
  get conversationLength(): number {
    return this.messages.length;
  }

  /** Get cumulative token usage for this session */
  get totalUsage(): TokenUsage {
    return { ...this._totalUsage };
  }
}
