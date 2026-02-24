import type { ServerEvent } from '../types';

/**
 * Minimal WebSocket mock that satisfies the interface used by useWebSocket.ts.
 * Instead of connecting to a server, it receives events from the DemoPlaybackEngine.
 */
export class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState: number = MockWebSocket.CONNECTING;

  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(_url: string) {
    // Auto-open after a microtask to mimic real WS behavior
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  /** Emit a ServerEvent as if the server sent it */
  emit(event: ServerEvent): void {
    if (this.readyState !== MockWebSocket.OPEN) return;
    const data = JSON.stringify(event);
    this.onmessage?.(new MessageEvent('message', { data }));
  }

  /** Handle client messages — respond to interactive requests like context_breakdown */
  send(data: string): void {
    try {
      const msg = JSON.parse(data) as Record<string, unknown>;
      if (msg.type === 'context_breakdown_request') {
        setTimeout(() => this.emitContextBreakdown(), 200);
      }
    } catch { /* ignore malformed */ }
  }

  private emitContextBreakdown(): void {
    this.emit({
      type: 'context_breakdown',
      breakdown: {
        systemBase: 4200,
        systemBaseContent: '# System Prompt\n\nYou are aigent, a self-authoring AI coding assistant running in a sandboxed Docker container.\n\n## Tools\nYou have access to: read_file, write_file, edit_file, exec, grep, glob, fetch\n\n## Rules\n- Always explain changes before making them\n- Request minimal permissions\n- Prefer editing over creating new files',
        workspaceContext: 2800,
        workspaceContent: '# AGENTS.md\n\naigent — a self-authoring AI agent.\n\n## Architecture\n\nHost (gatekeeper) ↔ Docker container (worker)\n\n## Key Files\n- src/server.ts — Express server\n- src/config.ts — Configuration\n- src/routes/ — API routes',
        toolDefs: 1900,
        toolDefsContent: JSON.stringify([
          { name: 'read_file', description: 'Read a file from the filesystem', parameters: { path: 'string' } },
          { name: 'write_file', description: 'Write content to a file', parameters: { path: 'string', content: 'string' } },
          { name: 'edit_file', description: 'Apply a targeted edit to a file', parameters: { path: 'string', old: 'string', new: 'string' } },
          { name: 'exec', description: 'Execute a shell command', parameters: { command: 'string' } },
          { name: 'grep', description: 'Search file contents', parameters: { pattern: 'string', path: 'string' } },
          { name: 'glob', description: 'Find files by pattern', parameters: { pattern: 'string' } },
          { name: 'fetch', description: 'Make an HTTP request', parameters: { url: 'string', method: 'string' } },
        ], null, 2),
        messages: [
          { role: 'user', tokens: 320, preview: 'Read the main config file and add a health check endpoint' },
          { role: 'assistant', tokens: 1847, preview: "I've added a health check endpoint to your server. Here's what I did:\n\n1. **Read** `src/config.ts` to understand the existing route structure\n2. **Searched** for route registration patterns across the codebase\n3. **Added** a `/health` endpoint that returns `{ status: \"ok\", uptime: <seconds> }`" },
          { role: 'tool_result', tokens: 580, preview: 'export const config = {\n  port: 3000,\n  host: "0.0.0.0",\n  routes: {\n    api: "/api/v1",\n    docs: "/docs",\n  },\n  cors: { origin: "*" },\n};' },
          { role: 'tool_result', tokens: 210, preview: 'src/server.ts:12: app.use(config.routes.api, apiRouter);\nsrc/server.ts:13: app.use(config.routes.docs, docsRouter);' },
        ],
        messagesTotal: 2957,
        total: 11857,
      },
    });
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}
