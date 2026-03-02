import type Anthropic from '@anthropic-ai/sdk';
import type { TextBlock, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages.js';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClient, buildSystemPrompt } from './auth.js';
import type { ThinkingLevel, TokenUsage } from './agent.js';

// --- Unified types ---

export interface StreamCallbacks {
  onText?: ((fullText: string) => void) | undefined;
  onThinking?: ((fullText: string) => void) | undefined;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: TokenUsage;
}

export interface ProviderToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Content block for tool results — text or image. */
export type ToolContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string };

export interface ToolResult {
  id: string;
  content: string | ToolContentBlock[];
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface ImageContent {
  type: 'image';
  mediaType: ImageMediaType;
  data: string; // base64
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type DocumentMediaType = 'application/pdf';

export interface DocumentContent {
  type: 'document';
  mediaType: DocumentMediaType;
  data: string; // base64
  title?: string;
}

/** User message content — plain string or mixed text+images+documents. */
export type UserContent = string | (TextContent | ImageContent | DocumentContent)[];

// --- Provider interface ---

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Context window size in tokens, if provided by the API. */
  contextLength?: number;
  /** Pricing in USD per million tokens, if provided by the API. */
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface Provider {
  sendMessage(
    systemPrompt: string | string[],
    messages: ProviderMessage[],
    tools: ProviderToolDef[],
    options: {
      model: string;
      maxTokens: number;
      thinking: ThinkingLevel;
      signal?: AbortSignal;
    },
    callbacks?: StreamCallbacks,
  ): Promise<ProviderResponse>;

  /** List available models. Optional — providers that don't support it return null. */
  listModels?(): Promise<ModelInfo[] | null>;
}

export type ProviderMessage =
  | { role: 'user'; content: UserContent }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] | undefined }
  | { role: 'tool_result'; results: ToolResult[] };

// --- Anthropic provider ---

export class AnthropicProvider implements Provider {
  private client: Anthropic;
  private isOAuth: boolean;

  constructor(apiKey: string) {
    const { client, isOAuth } = createClient(apiKey);
    this.client = client;
    this.isOAuth = isOAuth;
  }

  get isOAuthToken(): boolean {
    return this.isOAuth;
  }

  async sendMessage(
    systemPrompt: string | string[],
    messages: ProviderMessage[],
    tools: ProviderToolDef[],
    options: { model: string; maxTokens: number; thinking: ThinkingLevel; signal?: AbortSignal },
    callbacks?: StreamCallbacks,
  ): Promise<ProviderResponse> {
    const anthropicMessages = this.convertMessages(messages);
    const anthropicTools = tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      // Cache the last tool definition so all tools are covered by prompt caching
      ...(i === tools.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    })) as Anthropic.Tool[];

    const system = buildSystemPrompt(systemPrompt, this.isOAuth);

    const params: Record<string, unknown> = {
      model: options.model,
      max_tokens: options.maxTokens,
      system,
      tools: anthropicTools,
      messages: anthropicMessages,
    };

    // Request extended thinking if the caller asked for it.
    // Not all models support this — if the API rejects it, the caller should
    // catch the error, retry without thinking, and remember the model doesn't support it.
    if (options.thinking !== 'off') {
      params['thinking'] = { type: 'adaptive' };
      params['output_config'] = { effort: options.thinking };
    }

    const stream = this.client.messages.stream(
      params as Parameters<typeof this.client.messages.stream>[0],
    );

    // Abort the stream when the signal fires
    if (options.signal) {
      if (options.signal.aborted) {
        stream.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      options.signal.addEventListener('abort', () => stream.abort(), { once: true });
    }

    let currentText = '';
    let thinkingText = '';
    stream.on('text', (text) => {
      currentText += text;
      callbacks?.onText?.(currentText);
    });
    (stream as unknown as { on(e: string, cb: (d: unknown) => void): void }).on('contentBlock', (block: unknown) => {
      const b = block as { type: string; thinking?: string };
      if (b.type === 'thinking' && b.thinking) {
        thinkingText += b.thinking;
        callbacks?.onThinking?.(thinkingText);
      }
    });

    const response = await stream.finalMessage();

    const usage = response.usage;
    const rawUsage = usage as unknown as Record<string, number>;

    const textBlocks = response.content.filter(
      (block): block is TextBlock => block.type === 'text',
    );
    const toolUseBlocks = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );

    const stopReason: ProviderResponse['stopReason'] =
      toolUseBlocks.length > 0 && response.stop_reason !== 'end_turn'
        ? 'tool_use'
        : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end_turn';

    return {
      text: textBlocks.map((b) => b.text).join('\n'),
      toolCalls: toolUseBlocks.map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      })),
      stopReason,
      usage: {
        input: usage.input_tokens,
        output: usage.output_tokens,
        cacheRead: rawUsage['cache_read_input_tokens'] ?? 0,
        cacheWrite: rawUsage['cache_creation_input_tokens'] ?? 0,
      },
    };
  }

  async listModels(): Promise<ModelInfo[] | null> {
    try {
      const page = await this.client.models.list({ limit: 100 });
      return page.data.map((m) => ({
        id: m.id,
        displayName: (m as unknown as { display_name?: string }).display_name ?? m.id,
      }));
    } catch {
      return null;
    }
  }

  private convertMessages(messages: ProviderMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          // Mixed content (text + images + documents)
          const blocks: Anthropic.ContentBlockParam[] = msg.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text };
            }
            if (part.type === 'document') {
              return {
                type: 'document' as const,
                source: {
                  type: 'base64' as const,
                  media_type: part.mediaType,
                  data: part.data,
                },
                ...(part.title ? { title: part.title } : {}),
              };
            }
            return {
              type: 'image' as const,
              source: {
                type: 'base64' as const,
                media_type: part.mediaType,
                data: part.data,
              },
            };
          });
          result.push({ role: 'user', content: blocks });
        }
      } else if (msg.role === 'assistant') {
        const content: Anthropic.ContentBlock[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content } as Anthropic.TextBlock);
        }
        if (msg.toolCalls) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.input,
            } as Anthropic.ToolUseBlock);
          }
        }
        result.push({ role: 'assistant', content });
      } else if (msg.role === 'tool_result') {
        result.push({
          role: 'user',
          content: msg.results.map((r) => ({
            type: 'tool_result' as const,
            tool_use_id: r.id,
            content: typeof r.content === 'string'
              ? r.content
              : r.content.map((block) => {
                  if (block.type === 'text') {
                    return { type: 'text' as const, text: block.text };
                  }
                  return {
                    type: 'image' as const,
                    source: {
                      type: 'base64' as const,
                      media_type: block.mediaType,
                      data: block.data,
                    },
                  };
                }),
          })),
        });
      }
    }

    // Add cache_control to the last N user messages.
    // Anthropic allows at most 4 cache_control blocks per request.
    // Non-OAuth uses 2 (system base + tools), leaving 2 for messages.
    // OAuth adds a 3rd system block (identity prefix), leaving only 1 for messages.
    // String-content user messages are promoted to array form so they can receive cache_control.
    const maxMessageBreakpoints = this.isOAuth ? 1 : 2;
    let breakpointsAdded = 0;
    for (let i = result.length - 1; i >= 0 && breakpointsAdded < maxMessageBreakpoints; i--) {
      const msg = result[i]!;
      if (msg.role !== 'user') continue;

      if (typeof msg.content === 'string') {
        // Promote to array so we can attach cache_control
        (msg as unknown as { content: Anthropic.ContentBlockParam[] }).content = [
          { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
        ];
        breakpointsAdded++;
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastBlock = msg.content[msg.content.length - 1] as unknown as Record<string, unknown>;
        lastBlock['cache_control'] = { type: 'ephemeral' };
        breakpointsAdded++;
      }
    }

    return result;
  }
}

// --- OpenAI-compatible provider ---

export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || 'not-needed',
      baseURL: baseURL ?? undefined,
    });
  }

  async sendMessage(
    systemPrompt: string | string[],
    messages: ProviderMessage[],
    tools: ProviderToolDef[],
    options: { model: string; maxTokens: number; thinking: ThinkingLevel; signal?: AbortSignal },
    callbacks?: StreamCallbacks,
  ): Promise<ProviderResponse> {
    const promptStr = Array.isArray(systemPrompt) ? systemPrompt.join('\n\n') : systemPrompt;
    const openaiMessages = this.convertMessages(promptStr, messages);
    const openaiTools: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const noTools = process.env['AIGENT_NO_TOOLS'] === '1' || process.env['AIGENT_NO_TOOLS'] === 'true';
    const allowlist = process.env['AIGENT_TOOLS_ALLOWLIST']?.split(',').map((s) => s.trim()).filter(Boolean);
    const filteredTools = noTools
      ? []
      : allowlist
        ? openaiTools.filter((t) => t.type === 'function' && allowlist.includes(t.function.name))
        : openaiTools;
    const stream = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: openaiMessages,
      ...(filteredTools.length > 0 ? { tools: filteredTools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let currentText = '';
    const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        currentText += delta.content;
        callbacks?.onText?.(currentText);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccum.get(tc.index);
          if (existing) {
            existing.args += tc.function?.arguments ?? '';
          } else {
            toolCallAccum.set(tc.index, {
              id: tc.id ?? `call_${tc.index}`,
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }

      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallAccum) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          input: JSON.parse(tc.args || '{}') as Record<string, unknown>,
        });
      } catch {
        toolCalls.push({ id: tc.id, name: tc.name, input: {} });
      }
    }

    return {
      text: currentText,
      toolCalls,
      stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      usage: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
  }

  private convertMessages(systemPrompt: string, messages: ProviderMessage[]): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
    ];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content });
        } else {
          // Mixed content (text + images + documents) for OpenAI vision
          const parts = msg.content.map((part) => {
            if (part.type === 'text') {
              return { type: 'text' as const, text: part.text };
            }
            if (part.type === 'document') {
              return { type: 'text' as const, text: `[PDF document: ${part.title ?? 'untitled'}] (PDF content not supported by this provider)` };
            }
            return {
              type: 'image_url' as const,
              image_url: { url: `data:${part.mediaType};base64,${part.data}` },
            };
          });
          result.push({ role: 'user', content: parts });
        }
      } else if (msg.role === 'assistant') {
        const entry: ChatCompletionMessageParam = {
          role: 'assistant',
          content: msg.content || null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          (entry as unknown as Record<string, unknown>)['tool_calls'] = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }));
        }
        result.push(entry);
      } else if (msg.role === 'tool_result') {
        for (const r of msg.results) {
          let textContent: string;
          if (typeof r.content === 'string') {
            textContent = r.content;
          } else {
            const textParts = r.content
              .filter((b): b is Extract<ToolContentBlock, { type: 'text' }> => b.type === 'text')
              .map((b) => b.text);
            const imageCount = r.content.filter((b) => b.type === 'image').length;
            textContent = textParts.join('\n');
            if (imageCount > 0) {
              textContent += `\n[${imageCount} image(s) captured — not supported by this provider]`;
            }
          }
          result.push({
            role: 'tool',
            tool_call_id: r.id,
            content: textContent,
          });
        }
      }
    }

    return result;
  }

  async listModels(): Promise<ModelInfo[] | null> {
    try {
      const response = await this.client.models.list();
      return response.data.map((m) => {
        // OpenRouter (and some other providers) include context_length and pricing
        const raw = m as unknown as {
          context_length?: number;
          pricing?: { prompt?: string; completion?: string; cache_read?: string; cache_write?: string };
        };
        const info: ModelInfo = { id: m.id, displayName: m.id };
        if (typeof raw.context_length === 'number' && raw.context_length > 0) {
          info.contextLength = raw.context_length;
        }
        if (raw.pricing) {
          const toPerMillion = (s?: string) => (s ? parseFloat(s) * 1_000_000 : 0);
          const input = toPerMillion(raw.pricing.prompt);
          const output = toPerMillion(raw.pricing.completion);
          // Only register if non-zero (some free models have "0" pricing which is valid)
          info.pricing = {
            input,
            output,
            cacheRead: toPerMillion(raw.pricing.cache_read),
            cacheWrite: toPerMillion(raw.pricing.cache_write),
          };
        }
        return info;
      });
    } catch {
      return null;
    }
  }
}

// --- Factory ---

export type ProviderType = 'anthropic' | 'openai';

interface ProviderConfig {
  provider?: ProviderType;
  baseURL?: string;
  apiKey?: string;
}

/** Read persistent provider config from ~/.config/aigent/provider.json (if it exists). */
export function loadProviderConfig(): ProviderConfig {
  const configPath = join(homedir(), '.config', 'aigent', 'provider.json');
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as ProviderConfig;
  } catch {
    return {};
  }
}

export function createProvider(type: ProviderType): Provider {
  const fileConfig = loadProviderConfig();
  if (type === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'] ?? process.env['AIGENT_API_KEY'] ?? fileConfig.apiKey ?? '';
    const baseURL = process.env['AIGENT_BASE_URL'] ?? fileConfig.baseURL;
    return new OpenAIProvider(apiKey, baseURL);
  }

  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) {
    throw new Error('No API key. Set ANTHROPIC_API_KEY (Anthropic) or OPENAI_API_KEY (OpenAI/OpenRouter) or configure ~/.config/aigent/provider.json');
  }
  return new AnthropicProvider(apiKey);
}

export function detectProvider(): ProviderType {
  const explicit = process.env['AIGENT_PROVIDER'];
  if (explicit === 'openai') return 'openai';
  if (explicit === 'anthropic') return 'anthropic';

  // Auto-detect from environment
  if (process.env['AIGENT_BASE_URL']) return 'openai';
  if (process.env['OPENAI_API_KEY'] && !process.env['ANTHROPIC_API_KEY']) return 'openai';

  // Fall back to config file
  const fileConfig = loadProviderConfig();
  if (fileConfig.provider) return fileConfig.provider;
  if (fileConfig.baseURL) return 'openai';

  return 'anthropic';
}

// ---------------------------------------------------------------------------
// Test-only exports for message conversion logic
// ---------------------------------------------------------------------------

/** @internal Test-only: expose AnthropicProvider.convertMessages as a plain function. */
export function _convertMessagesForAnthropicTest(
  messages: ProviderMessage[],
  isOAuth = false,
): Anthropic.MessageParam[] {
  // We use `as any` here because convertMessages is private — this is only for tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = new AnthropicProvider('test-key') as unknown as { isOAuth: boolean; convertMessages(m: ProviderMessage[]): Anthropic.MessageParam[] };
  p.isOAuth = isOAuth;
  return p.convertMessages(messages);
}

/** @internal Test-only: expose OpenAIProvider.convertMessages as a plain function. */
export function _convertMessagesForOpenAITest(
  systemPrompt: string,
  messages: ProviderMessage[],
): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = new OpenAIProvider('test-key') as unknown as { convertMessages(s: string, m: ProviderMessage[]): unknown[] };
  return p.convertMessages(systemPrompt, messages);
}
