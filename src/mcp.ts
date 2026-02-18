/**
 * MCP (Model Context Protocol) client implementation.
 *
 * Connects to MCP servers via stdio transport, discovers tools,
 * and routes tool calls to the appropriate server.
 *
 * Config format (mcp.json in workspace):
 * {
 *   "servers": {
 *     "name": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-github"],
 *       "env": { "GITHUB_TOKEN": "..." }
 *     }
 *   }
 * }
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolDef } from './tools.js';

// --- JSON-RPC types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params: Record<string, unknown> | undefined;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// --- MCP types ---

interface MCPToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

interface MCPConfig {
  servers: Record<string, MCPServerConfig>;
}

interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// --- MCP Client (single server) ---

class MCPClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (result: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private buffer = Buffer.alloc(0);
  private tools: MCPToolSchema[] = [];
  readonly serverName: string;

  constructor(
    serverName: string,
    private config: MCPServerConfig,
  ) {
    this.serverName = serverName;
  }

  async start(): Promise<void> {
    const { command, args = [], env, cwd } = this.config;

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      cwd: cwd ?? process.cwd(),
    });

    // Parse stdout for JSON-RPC responses (Content-Length framing)
    this.process.stdout?.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.processBuffer();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // Log MCP server errors but don't crash
      const text = data.toString().trim();
      if (text) console.error(`[mcp:${this.serverName}] ${text}`);
    });

    this.process.on('exit', (code) => {
      console.error(`[mcp:${this.serverName}] Process exited (code=${code})`);
      // Reject all pending requests
      for (const [, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new Error(`MCP server ${this.serverName} exited`));
      }
      this.pending.clear();
      this.process = null;
    });

    // Initialize the MCP connection
    await this.initialize();

    // Discover tools
    this.tools = await this.discoverTools();
  }

  private processBuffer(): void {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.subarray(0, headerEnd).toString();
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header — advance past the \r\n\r\n
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const bodyStart = headerEnd + 4;

      if (this.buffer.length < bodyStart + contentLength) break; // Incomplete

      const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString();
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      try {
        const message = JSON.parse(body) as JsonRpcResponse;
        this.handleMessage(message);
      } catch {
        // Malformed JSON
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (!('id' in message) || message.id === undefined) return; // Notification, ignore

    const pending = this.pending.get(message.id);
    if (!pending) return;

    const { resolve, reject, timer } = pending;
    clearTimeout(timer);
    this.pending.delete(message.id);

    if (message.error) {
      reject(new Error(`MCP error: ${message.error.message} (code ${message.error.code})`));
    } else {
      resolve(message.result);
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.process?.stdin?.writable) {
      return Promise.reject(new Error(`MCP server ${this.serverName} not running`));
    }

    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      const body = JSON.stringify(request);
      const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
      this.process!.stdin!.write(header + body);
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.process?.stdin?.writable) return;

    const notification: JsonRpcRequest = { jsonrpc: '2.0', method, params };
    const body = JSON.stringify(notification);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'aigent', version: '0.1.0' },
    });

    // Send initialized notification
    this.sendNotification('notifications/initialized');
  }

  private async discoverTools(): Promise<MCPToolSchema[]> {
    const result = await this.sendRequest('tools/list') as { tools?: MCPToolSchema[] };
    return result.tools ?? [];
  }

  getTools(): MCPToolSchema[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.sendRequest('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };

    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c) => c.type === 'text' && c.text)
        .map((c) => c.text!);
      if (textParts.length > 0) return textParts.join('\n');
    }

    return JSON.stringify(result);
  }

  shutdown(): void {
    // Send shutdown notification before killing
    if (this.process?.stdin?.writable) {
      try {
        this.sendNotification('notifications/cancelled');
      } catch {
        // Already dead
      }
    }

    for (const [, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('Shutting down'));
    }
    this.pending.clear();

    if (this.process) {
      this.process.kill('SIGTERM');
      // Force kill after 5s
      setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
      }, 5000);
      this.process = null;
    }
  }
}

// --- MCP Manager (multiple servers) ---

export class MCPManager {
  private clients = new Map<string, MCPClient>();
  private toolToServer = new Map<string, string>(); // tool name → server name
  private _tools: ToolDef[] = [];

  /**
   * Initialize from an mcp.json config file.
   * Starts all configured servers and discovers their tools.
   */
  async initialize(configPath: string): Promise<void> {
    if (!existsSync(configPath)) return;

    let config: MCPConfig;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      config = JSON.parse(raw) as MCPConfig;
    } catch (err: unknown) {
      const e = err as { message?: string };
      console.error(`[mcp] Failed to parse config: ${e.message}`);
      return;
    }

    if (!config.servers || typeof config.servers !== 'object') return;

    const startPromises: Promise<void>[] = [];

    for (const [name, serverConfig] of Object.entries(config.servers)) {
      const client = new MCPClient(name, serverConfig);
      this.clients.set(name, client);

      startPromises.push(
        client.start()
          .then(() => {
            const tools = client.getTools();
            console.error(`[mcp:${name}] Connected — ${tools.length} tool(s)`);
            for (const tool of tools) {
              // Prefix with server name to avoid collisions
              const prefixedName = `mcp_${name}_${tool.name}`;
              this.toolToServer.set(prefixedName, name);
              const schema: ToolDef['input_schema'] = {
                type: 'object' as const,
                properties: tool.inputSchema.properties ?? {},
              };
              if (tool.inputSchema.required) {
                schema.required = tool.inputSchema.required;
              }
              this._tools.push({
                name: prefixedName,
                description: `[MCP:${name}] ${tool.description ?? tool.name}`,
                input_schema: schema,
              });
            }
          })
          .catch((err: unknown) => {
            const e = err as { message?: string };
            console.error(`[mcp:${name}] Failed to start: ${e.message}`);
            this.clients.delete(name);
          }),
      );
    }

    await Promise.allSettled(startPromises);
  }

  /**
   * Get all MCP tool definitions (ready to merge with built-in tools).
   */
  getTools(): ToolDef[] {
    return this._tools;
  }

  /**
   * Check if a tool name belongs to an MCP server.
   */
  isMCPTool(name: string): boolean {
    return this.toolToServer.has(name);
  }

  /**
   * Call an MCP tool by its prefixed name.
   */
  async callTool(prefixedName: string, args: Record<string, unknown>): Promise<string> {
    const serverName = this.toolToServer.get(prefixedName);
    if (!serverName) return `Error: unknown MCP tool: ${prefixedName}`;

    const client = this.clients.get(serverName);
    if (!client) return `Error: MCP server ${serverName} not running`;

    // Strip the prefix to get the original tool name
    const originalName = prefixedName.replace(`mcp_${serverName}_`, '');

    try {
      return await client.callTool(originalName, args);
    } catch (err: unknown) {
      const e = err as { message?: string };
      return `MCP error (${serverName}): ${e.message ?? 'unknown error'}`;
    }
  }

  /**
   * Get the count of connected servers and tools.
   */
  get stats(): { servers: number; tools: number } {
    return { servers: this.clients.size, tools: this._tools.length };
  }

  /**
   * Shut down all MCP servers.
   */
  shutdown(): void {
    for (const [name, client] of this.clients) {
      console.error(`[mcp:${name}] Shutting down`);
      client.shutdown();
    }
    this.clients.clear();
    this.toolToServer.clear();
    this._tools = [];
  }
}

/**
 * Load MCP config and start servers.
 * Returns an initialized MCPManager (may have 0 servers if no config).
 */
export async function loadMCP(workspacePath: string): Promise<MCPManager> {
  const manager = new MCPManager();
  const configPath = join(workspacePath, 'mcp.json');
  await manager.initialize(configPath);
  return manager;
}
