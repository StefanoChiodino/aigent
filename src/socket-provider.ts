/**
 * SocketProvider — LLM provider that proxies requests through the gatekeeper.
 *
 * Implements the same Provider interface as AnthropicProvider/OpenAIProvider,
 * but instead of calling the LLM API directly, sends requests over the Unix
 * socket to the gatekeeper, which holds the API keys.
 *
 * This means the sandbox never sees API credentials.
 */

import { connect, type Socket } from 'node:net';
import { SOCKET_DIR } from './protocol.js';
import type {
  Provider,
  ModelInfo,
  ProviderMessage,
  ProviderToolDef,
  ProviderResponse,
  StreamCallbacks,
} from './provider.js';
import type { ThinkingLevel } from './agent.js';
import { createLogger } from './logger.js';

const log = createLogger('socket-provider');

/** Path for the LLM proxy socket (separate from the worker↔gatekeeper socket). */
export const LLM_PROXY_SOCKET = `${SOCKET_DIR}/llm-proxy.sock`;

// --- Protocol types for LLM proxy ---

export interface LLMRequest {
  type: 'llm_request';
  id: string;
  system: string | string[];
  messages: ProviderMessage[];
  tools: ProviderToolDef[];
  options: {
    model: string;
    maxTokens: number;
    thinking: ThinkingLevel;
  };
}

export interface ListModelsRequest {
  type: 'list_models';
  id: string;
}

export type LLMSocketRequest = LLMRequest | ListModelsRequest;

export type LLMEvent =
  | { type: 'llm_text'; id: string; content: string }
  | { type: 'llm_thinking'; id: string; content: string }
  | { type: 'llm_done'; id: string; response: ProviderResponse }
  | { type: 'llm_error'; id: string; message: string; status?: number; code?: string }
  | { type: 'models_list'; id: string; models: ModelInfo[] | null };

// --- SocketProvider (used by worker/agent) ---

export class SocketProvider implements Provider {
  private socket: Socket | null = null;
  private connected = false;
  private buffer = '';
  private reqCounter = 0;
  private pending = new Map<string, {
    resolve: (res: ProviderResponse) => void;
    reject: (err: Error & { status?: number; code?: string }) => void;
    callbacks?: StreamCallbacks;
  }>();
  private pendingModels = new Map<string, {
    resolve: (models: ModelInfo[] | null) => void;
  }>();

  get isOAuthToken(): boolean {
    // The gatekeeper knows — we don't care in the worker
    return false;
  }

  /** Connect to the LLM proxy socket. */
  connect(): boolean {
    try {
      this.socket = connect(LLM_PROXY_SOCKET);

      this.socket.on('connect', () => {
        this.connected = true;
        log.debug('Connected to LLM proxy');
      });

      this.socket.on('data', (chunk) => {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as LLMEvent;
            this.handleEvent(event);
          } catch {}
        }
      });

      this.socket.on('close', () => {
        log.warn('LLM proxy disconnected', { pendingRequests: this.pending.size });
        this.connected = false;
        this.socket = null;
        // Reject all pending LLM requests
        for (const [, p] of this.pending) {
          p.reject(Object.assign(new Error('LLM proxy disconnected'), { code: 'ECONNRESET' }));
        }
        this.pending.clear();
        // Resolve pending model list requests with null (graceful fallback)
        for (const [, p] of this.pendingModels) {
          p.resolve(null);
        }
        this.pendingModels.clear();
      });

      this.socket.on('error', () => {
        this.connected = false;
      });

      return true;
    } catch {
      return false;
    }
  }

  private handleEvent(event: LLMEvent): void {
    // Handle models_list separately — it uses pendingModels, not pending
    if (event.type === 'models_list') {
      const pm = this.pendingModels.get(event.id);
      if (pm) {
        this.pendingModels.delete(event.id);
        pm.resolve(event.models);
      }
      return;
    }

    const p = this.pending.get(event.id);
    if (!p) return;

    switch (event.type) {
      case 'llm_text':
        p.callbacks?.onText?.(event.content);
        break;
      case 'llm_thinking':
        p.callbacks?.onThinking?.(event.content);
        break;
      case 'llm_done':
        this.pending.delete(event.id);
        p.resolve(event.response);
        break;
      case 'llm_error': {
        this.pending.delete(event.id);
        log.warn('LLM error received', { id: event.id, message: event.message });
        const err = Object.assign(new Error(event.message), {
          ...(event.status !== undefined ? { status: event.status } : {}),
          ...(event.code !== undefined ? { code: event.code } : {}),
        });
        p.reject(err);
        break;
      }
    }
  }

  async sendMessage(
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
  ): Promise<ProviderResponse> {
    if (!this.connected || !this.socket) {
      throw Object.assign(
        new Error('LLM proxy not connected. Is the gatekeeper running?'),
        { code: 'ECONNREFUSED' },
      );
    }

    const id = `llm_${++this.reqCounter}`;
    const req: LLMRequest = {
      type: 'llm_request',
      id,
      system: systemPrompt,
      messages,
      tools,
      options: {
        model: options.model,
        maxTokens: options.maxTokens,
        thinking: options.thinking,
      },
    };

    return new Promise<ProviderResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, ...(callbacks ? { callbacks } : {}) });

      // Handle abort
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          this.pending.delete(id);
          reject(new DOMException('Aborted', 'AbortError'));
          // TODO: send cancel to gatekeeper
        }, { once: true });
      }

      this.socket!.write(JSON.stringify(req) + '\n');
    });
  }

  async listModels(): Promise<ModelInfo[] | null> {
    if (!this.connected || !this.socket) return null;
    const id = `models_${++this.reqCounter}`;
    const req: ListModelsRequest = { type: 'list_models', id };
    return new Promise<ModelInfo[] | null>((resolve) => {
      this.pendingModels.set(id, { resolve });
      this.socket!.write(JSON.stringify(req) + '\n');
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
