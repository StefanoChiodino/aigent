import Anthropic from '@anthropic-ai/sdk';
import type { ToolUseBlock, TextBlock } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { toolDefinitions, executeTool } from './tools.js';

const SYSTEM_PROMPT = `You are an AI agent running inside a sandboxed environment. You have access to:
- A shell (exec tool) to run any command
- File read/write to inspect and modify files
- Internet access via curl, wget, etc.

You can install packages, write code, and modify your own source code.
Your source code is in the current working directory.

Be direct. Be helpful. Execute commands to verify things rather than guessing.`;

export interface AgentOptions {
  model?: string;
  maxTokens?: number;
}

export class Agent {
  private client: Anthropic;
  private messages: Anthropic.MessageParam[] = [];
  private model: string;
  private maxTokens: number;

  constructor(options: AgentOptions = {}) {
    this.client = new Anthropic();
    this.model = options.model ?? 'claude-sonnet-4-20250514';
    this.maxTokens = options.maxTokens ?? 8192;
  }

  async chat(userMessage: string): Promise<string> {
    this.messages.push({ role: 'user', content: userMessage });

    // Loop to handle tool use
    while (true) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: SYSTEM_PROMPT,
        tools: toolDefinitions,
        messages: this.messages,
      });

      // Collect the full response
      this.messages.push({ role: 'assistant', content: response.content });

      // Find tool use blocks
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use'
      );

      if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
        // No tool calls — extract text and return
        const textBlocks = response.content.filter(
          (block): block is TextBlock => block.type === 'text'
        );
        return textBlocks.map((b) => b.text).join('\n');
      }

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((toolUse) => {
        console.log(`  ⚡ ${toolUse.name}: ${JSON.stringify(toolUse.input).slice(0, 100)}...`);
        const result = executeTool(toolUse.name, toolUse.input as Parameters<typeof executeTool>[1]);
        return {
          type: 'tool_result' as const,
          tool_use_id: toolUse.id,
          content: result,
        };
      });

      this.messages.push({ role: 'user', content: toolResults });
    }
  }
}
