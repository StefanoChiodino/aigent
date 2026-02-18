/**
 * LLM Proxy — runs in the gatekeeper, proxies LLM API calls for the worker.
 *
 * The gatekeeper holds the API keys. The worker sends LLM requests over a
 * Unix socket. This proxy forwards them to the actual LLM API and streams
 * responses back.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Provider,
  ProviderMessage,
  ProviderToolDef,
  ProviderResponse,
} from './provider.js';
import type { LLMRequest, LLMEvent } from './socket-provider.js';
import { LLM_PROXY_SOCKET } from './socket-provider.js';

function writeLine(socket: Socket, data: LLMEvent): void {
  try {
    socket.write(JSON.stringify(data) + '\n');
  } catch {}
}

export class LLMProxy {
  private server: Server | null = null;
  private provider: Provider;

  constructor(provider: Provider) {
    this.provider = provider;
  }

  /** Start the LLM proxy socket server. */
  start(): void {
    const socketDir = dirname(LLM_PROXY_SOCKET);
    mkdirSync(socketDir, { recursive: true });

    if (existsSync(LLM_PROXY_SOCKET)) {
      try { unlinkSync(LLM_PROXY_SOCKET); } catch {}
    }

    this.server = createServer((socket: Socket) => {
      let buffer = '';

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const req = JSON.parse(line) as LLMRequest;
            if (req.type === 'llm_request') {
              void this.handleRequest(socket, req);
            }
          } catch {}
        }
      });

      socket.on('error', () => {});
    });

    this.server.listen(LLM_PROXY_SOCKET, () => {
      // LLM proxy ready
    });

    this.server.on('error', (err) => {
      console.error(`[llm-proxy] Error: ${err.message}`);
    });
  }

  private async handleRequest(socket: Socket, req: LLMRequest): Promise<void> {
    const { id, system, messages, tools, options } = req;

    try {
      const response = await this.provider.sendMessage(
        system,
        messages as ProviderMessage[],
        tools as ProviderToolDef[],
        {
          model: options.model,
          maxTokens: options.maxTokens,
          thinking: options.thinking,
        },
        {
          onText: (content: string) => {
            writeLine(socket, { type: 'llm_text', id, content });
          },
          onThinking: (content: string) => {
            writeLine(socket, { type: 'llm_thinking', id, content });
          },
        },
      );

      writeLine(socket, { type: 'llm_done', id, response });
    } catch (err: unknown) {
      const e = err as { message?: string; status?: number; code?: string };
      writeLine(socket, {
        type: 'llm_error',
        id,
        message: e.message ?? 'Unknown LLM error',
        status: e.status,
        code: e.code,
      });
    }
  }

  /** Stop the proxy. */
  stop(): void {
    if (this.server) {
      this.server.close();
      try { unlinkSync(LLM_PROXY_SOCKET); } catch {}
      this.server = null;
    }
  }
}
