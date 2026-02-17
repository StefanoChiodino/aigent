import type Anthropic from '@anthropic-ai/sdk';
import type { TextBlock, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { createClient, buildSystemPrompt } from './auth.js';
import { getToolDefinitions, executeTool } from './tools.js';
import { loadWorkspaceContext } from './workspace.js';

const BASE_SYSTEM_PROMPT = `You are an AI agent running inside a sandboxed environment. You have access to:
- A shell (exec tool) to run any command
- File read/write/edit to inspect and modify files
- grep and list_files for searching and navigating
- Internet access via curl, wget, etc.

You can install packages, write code, and modify your own source code.
Your source code is at /app/src/ and your workspace is at /workspace/.

Be direct. Be helpful. Execute commands to verify things rather than guessing.

## Memory

You have persistent memory via workspace files. At minimum:
- Update memory/YYYY-MM-DD.md with notable events during each session
- Update MEMORY.md when you learn something worth keeping long-term
- Read SOUL.md and USER.md to know who you are and who you're helping`;

export interface AgentOptions {
  model?: string;
  maxTokens?: number;
  apiKey?: string;
  workspacePath?: string;
}

export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private model: string;
  private maxTokens: number;
  private isOAuth: boolean;
  private tools: Anthropic.Tool[];
  private systemPromptText: string;

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

    // Load workspace context into system prompt
    const workspacePath = options.workspacePath ?? process.env['AIGENT_WORKSPACE'] ?? '/workspace';
    const workspaceContext = loadWorkspaceContext(workspacePath);
    this.systemPromptText = BASE_SYSTEM_PROMPT + workspaceContext;

    if (workspaceContext) {
      const fileCount = (workspaceContext.match(/^## /gm) ?? []).length;
      console.log(`  (loaded ${fileCount} workspace files from ${workspacePath})`);
    }

    if (isOAuth) {
      console.log('  (using subscription auth — Claude Code compatible mode)');
    }
  }

  async chat(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    let iterations = 0;
    const maxIterations = 25; // Safety limit

    while (iterations < maxIterations) {
      iterations++;

      const systemPrompt = buildSystemPrompt(this.systemPromptText, this.isOAuth);

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        tools: this.tools,
        messages: this.messages,
      });

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
        const displayName = toolUse.name;
        const inputStr = JSON.stringify(toolUse.input);
        const truncated = inputStr.length > 120 ? inputStr.slice(0, 120) + '...' : inputStr;
        console.log(`  ⚡ ${displayName}: ${truncated}`);

        const result = executeTool(
          toolUse.name,
          toolUse.input as Parameters<typeof executeTool>[1],
          this.isOAuth
        );

        // Truncate very large results to avoid context bloat
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

      this.messages.push({ role: 'user', content: toolResults });
    }

    return '[agent hit maximum tool-use iterations]';
  }

  /** Reset conversation history */
  reset(): void {
    this.messages = [];
  }

  /** Get current conversation length */
  get conversationLength(): number {
    return this.messages.length;
  }
}
