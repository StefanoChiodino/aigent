/**
 * Agent backend server.
 *
 * Runs the agent, processes commands, streams events to connected TUI clients
 * over a Unix socket using newline-delimited JSON.
 *
 * On restart (code change), auto-saves conversation state and reloads it,
 * so the TUI can reconnect seamlessly.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Agent, type ThinkingLevel } from './agent.js';
import { listProfiles, getProfilePath, listSessions, saveSession, loadSession, generateSessionId, autoSaveSession, autoLoadSession, clearAutoSave } from './profiles.js';
import type { ProviderMessage, UserContent, TextContent, ImageContent, ImageMediaType } from './provider.js';
import type { ClientCommand, ServerEvent, DisplayMessage, ServerState, TokenUsage } from './protocol.js';
import { SOCKET_PATH } from './protocol.js';
import { computeCost } from './pricing.js';
import { loadMCP, type MCPManager } from './mcp.js';

const VALID_THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];

// --- Image support ---

const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const IMAGE_PATH_REGEX = /(?:^|\s)(\/\S+\.(?:png|jpg|jpeg|gif|webp))\b/gi;

function getImageMediaType(path: string): ImageMediaType | null {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS[ext] ?? null;
}

function readImageBase64(filePath: string): { data: string; mediaType: ImageMediaType } | null {
  const resolved = resolve(filePath);
  const mediaType = getImageMediaType(resolved);
  if (!mediaType) return null;
  try {
    const buffer = readFileSync(resolved);
    return { data: buffer.toString('base64'), mediaType };
  } catch {
    return null;
  }
}

/**
 * Parse a user message for image file paths.
 * Returns UserContent — either a plain string (no images) or a mixed content array.
 */
function parseImagesInMessage(text: string): UserContent {
  const matches: { path: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  IMAGE_PATH_REGEX.lastIndex = 0;
  while ((match = IMAGE_PATH_REGEX.exec(text)) !== null) {
    const path = match[1]!;
    // Verify file exists and is a valid image
    if (existsSync(path)) {
      const fullMatchStart = match.index + match[0].indexOf(path);
      matches.push({ path, start: fullMatchStart, end: fullMatchStart + path.length });
    }
  }

  if (matches.length === 0) return text;

  const parts: (TextContent | ImageContent)[] = [];
  let lastEnd = 0;

  for (const m of matches) {
    // Add text before this image
    if (m.start > lastEnd) {
      const textBefore = text.slice(lastEnd, m.start).trim();
      if (textBefore) parts.push({ type: 'text', text: textBefore });
    }

    const img = readImageBase64(m.path);
    if (img) {
      parts.push({ type: 'image', mediaType: img.mediaType, data: img.data });
    } else {
      // Failed to read — keep as text
      parts.push({ type: 'text', text: m.path });
    }
    lastEnd = m.end;
  }

  // Add remaining text
  if (lastEnd < text.length) {
    const remaining = text.slice(lastEnd).trim();
    if (remaining) parts.push({ type: 'text', text: remaining });
  }

  // If no images were actually loaded, return plain string
  if (parts.every((p) => p.type === 'text')) {
    return text;
  }

  // Ensure there's at least one text block (API requirement)
  if (!parts.some((p) => p.type === 'text')) {
    parts.push({ type: 'text', text: 'Describe this image.' });
  }

  return parts;
}

// --- State ---

let agent: Agent;
let messages: DisplayMessage[] = [];
let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let currentThinking: ThinkingLevel;
let currentProfile = 'default';
let currentSessionId = generateSessionId();
let model: string;
let workspacePath: string;
let isLoading = false;
let abortController: AbortController | null = null;
const clients = new Set<Socket>();

// --- Helpers ---

function send(socket: Socket, event: ServerEvent): void {
  try {
    socket.write(JSON.stringify(event) + '\n');
  } catch {
    // Client disconnected, will be cleaned up
  }
}

function broadcast(event: ServerEvent): void {
  for (const client of clients) {
    send(client, event);
  }
}

function addSystemMessage(content: string): void {
  const msg: DisplayMessage = { role: 'system', content, timestamp: new Date().toISOString() };
  messages.push(msg);
  broadcast({ type: 'system', content });
}

function getState(): ServerState {
  return {
    messages,
    usage,
    thinking: currentThinking,
    profile: currentProfile,
    sessionId: currentSessionId,
    model,
    isLoading,
  };
}

function doAutoSave(): void {
  try {
    autoSaveSession(workspacePath, agent.getMessages(), messages);
  } catch {
    // Non-critical
  }
}

// --- Command handling ---

function handleCommand(cmd: string): boolean {
  const trimmed = cmd.trim();

  if (trimmed === '/reset') {
    agent.reset();
    messages = [];
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    clearAutoSave(workspacePath);
    addSystemMessage('Conversation reset.');
    broadcast({ type: 'usage', usage });
    return true;
  }

  if (trimmed === '/reasoning') {
    const isOn = currentThinking !== 'off';
    addSystemMessage(`Reasoning: ${isOn ? 'on' : 'off'}\nUsage: /reasoning on | /reasoning off`);
    return true;
  }

  if (trimmed === '/reasoning on') {
    if (currentThinking === 'off') {
      agent.thinkingLevel = 'medium';
      currentThinking = 'medium';
    }
    addSystemMessage('Reasoning: on');
    broadcast({ type: 'state', thinking: currentThinking });
    return true;
  }

  if (trimmed === '/reasoning off') {
    agent.thinkingLevel = 'off';
    currentThinking = 'off';
    addSystemMessage('Reasoning: off');
    broadcast({ type: 'state', thinking: currentThinking });
    return true;
  }

  if (trimmed === '/effort') {
    const effortLevels = VALID_THINKING_LEVELS.filter((l) => l !== 'off');
    addSystemMessage(`Effort: ${currentThinking === 'off' ? '(reasoning off)' : currentThinking}\nLevels: ${effortLevels.join(', ')}\nUsage: /effort <level>`);
    return true;
  }

  if (trimmed.startsWith('/effort ')) {
    const level = trimmed.split(' ')[1] as ThinkingLevel;
    const effortLevels: ThinkingLevel[] = ['low', 'medium', 'high', 'max'];
    if (effortLevels.includes(level)) {
      agent.thinkingLevel = level;
      currentThinking = level;
      addSystemMessage(`Effort: ${level}`);
      broadcast({ type: 'state', thinking: currentThinking });
    } else {
      addSystemMessage(`Invalid effort. Options: ${effortLevels.join(', ')}`);
    }
    return true;
  }

  if (trimmed === '/profiles' || trimmed === '/profile list') {
    const profiles = listProfiles(workspacePath);
    if (profiles.length === 0) {
      addSystemMessage(`No profiles yet. Current: ${currentProfile}\nCreate one: /profile create <name>`);
    } else {
      const list = profiles.map((p) => `  ${p.name === currentProfile ? '>' : ' '} ${p.name}`).join('\n');
      addSystemMessage(`Profiles:\n${list}`);
    }
    return true;
  }

  if (trimmed.startsWith('/profile create ')) {
    const name = trimmed.slice('/profile create '.length).trim();
    if (!name || name.includes('/') || name.includes('..')) {
      addSystemMessage('Invalid profile name.');
      return true;
    }
    getProfilePath(workspacePath, name);
    addSystemMessage(`Profile "${name}" created. Switch to it: /profile ${name}`);
    return true;
  }

  if (trimmed.startsWith('/profile ') && !trimmed.startsWith('/profile list') && !trimmed.startsWith('/profile create')) {
    const name = trimmed.slice('/profile '.length).trim();
    const profileDir = getProfilePath(workspacePath, name);
    agent.reset();
    agent.reloadWorkspace(profileDir);
    currentProfile = name;
    currentSessionId = generateSessionId();
    messages = [];
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    addSystemMessage(`Switched to profile: ${name}`);
    broadcast({ type: 'state', profile: currentProfile, sessionId: currentSessionId });
    broadcast({ type: 'usage', usage });
    return true;
  }

  if (trimmed === '/save') {
    saveSession(workspacePath, currentProfile, currentSessionId, agent.getMessages());
    addSystemMessage(`Session saved: ${currentSessionId}`);
    return true;
  }

  if (trimmed === '/sessions') {
    const sessions = listSessions(workspacePath, currentProfile);
    if (sessions.length === 0) {
      addSystemMessage('No saved sessions. Use /save to save current session.');
    } else {
      const list = sessions.map((s) =>
        `  ${s.id === currentSessionId ? '>' : ' '} ${s.id} (${s.messageCount} msgs, ${s.lastActiveAt.slice(0, 10)})`
      ).join('\n');
      addSystemMessage(`Sessions (${currentProfile}):\n${list}`);
    }
    return true;
  }

  if (trimmed.startsWith('/load ')) {
    const sessionId = trimmed.slice('/load '.length).trim();
    const data = loadSession(workspacePath, currentProfile, sessionId);
    if (!data) {
      addSystemMessage(`Session not found: ${sessionId}`);
      return true;
    }
    agent.setMessages(data.messages as ProviderMessage[]);
    currentSessionId = sessionId;
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    addSystemMessage(`Loaded session: ${sessionId} (${data.messages.length} messages)`);
    broadcast({ type: 'state', sessionId: currentSessionId });
    broadcast({ type: 'usage', usage });
    return true;
  }

  if (trimmed.startsWith('/image ')) {
    const rest = trimmed.slice('/image '.length).trim();
    if (!rest) {
      addSystemMessage('Usage: /image <path> [message]\nExample: /image /tmp/screenshot.png What is this?');
      return true;
    }
    // Split into path and optional message
    const spaceIdx = rest.indexOf(' ');
    const imgPath = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
    const imgText = spaceIdx > 0 ? rest.slice(spaceIdx + 1).trim() : 'Describe this image.';

    const img = readImageBase64(imgPath);
    if (!img) {
      addSystemMessage(`Cannot read image: ${imgPath}\nSupported formats: PNG, JPG, GIF, WebP`);
      return true;
    }

    // Queue as a message with image content
    const userContent: UserContent = [
      { type: 'image', mediaType: img.mediaType, data: img.data },
      { type: 'text', text: imgText },
    ];
    const userMsg: DisplayMessage = { role: 'user', content: `[image: ${imgPath}] ${imgText}`, timestamp: new Date().toISOString() };
    messages.push(userMsg);
    broadcast({ type: 'message', message: userMsg });

    isLoading = true;
    broadcast({ type: 'loading', isLoading: true });
    const controller = new AbortController();
    abortController = controller;
    const startTime = Date.now();

    void (async () => {
      try {
        const response = await agent.chat(userContent, {
          onText: (text) => { if (!controller.signal.aborted) broadcast({ type: 'text', content: text }); },
          onThinking: (text) => { if (!controller.signal.aborted) broadcast({ type: 'thinking', content: text }); },
          onToolStart: (name, toolInput, summary) => { if (!controller.signal.aborted) broadcast({ type: 'tool_start', name, input: toolInput, summary }); },
          onToolOutput: (content) => { if (!controller.signal.aborted) broadcast({ type: 'tool_output', content }); },
          onToolEnd: () => { if (!controller.signal.aborted) broadcast({ type: 'tool_end' }); },
          onUsage: (u) => { usage = { ...u, cost: computeCost(model, u) }; broadcast({ type: 'usage', usage }); },
          onCompact: (summary) => { addSystemMessage(`Context compacted: ${summary.slice(0, 200)}...`); },
        });

        if (!controller.signal.aborted) {
          const elapsed = (Date.now() - startTime) / 1000;
          broadcast({ type: 'text', content: '' });
          const assistantMsg: DisplayMessage = { role: 'assistant', content: response, timestamp: new Date().toISOString(), elapsed };
          messages.push(assistantMsg);
          broadcast({ type: 'message', message: assistantMsg });
          doAutoSave();
        }
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          const e = err as { status?: number; message?: string };
          broadcast({ type: 'error', message: e.message ?? 'Unknown error' });
        }
      } finally {
        abortController = null;
        isLoading = false;
        broadcast({ type: 'loading', isLoading: false });
      }
    })();

    return true;
  }

  if (trimmed === '/compact') {
    if (isLoading) {
      addSystemMessage('Cannot compact while loading.');
      return true;
    }
    addSystemMessage('Compacting conversation...');
    void (async () => {
      try {
        const result = await agent.forceCompact({
          onCompact: (summary) => {
            addSystemMessage(`Context compacted: ${summary.slice(0, 200)}...`);
          },
        });
        addSystemMessage(result);
        doAutoSave();
      } catch (err: unknown) {
        const e = err as { message?: string };
        addSystemMessage(`Compaction failed: ${e.message ?? 'unknown error'}`);
      }
    })();
    return true;
  }

  if (trimmed === '/help') {
    addSystemMessage(
      'Commands:\n' +
      '  /reset              Clear conversation\n' +
      '  /compact            Compact context (free up space)\n' +
      '  /reasoning on|off   Toggle reasoning\n' +
      '  /effort <level>     Set effort (low/medium/high/max)\n' +
      '  /image <path> [msg] Send an image with optional message\n' +
      '  /profiles           List profiles\n' +
      '  /profile <name>     Switch profile\n' +
      '  /profile create <n> Create new profile\n' +
      '  /save               Save current session\n' +
      '  /sessions           List saved sessions\n' +
      '  /load <id>          Load a saved session\n' +
      '  Esc                 Cancel generation / clear input\n' +
      '  Ctrl+C              Cancel / clear input (x2 to exit)'
    );
    return true;
  }

  if (trimmed.startsWith('/')) {
    addSystemMessage(`Unknown command: ${trimmed}\nType /help for available commands.`);
    return true;
  }

  return false;
}

// --- Message processing ---

const messageQueue: string[] = [];
let processingQueue = false;

async function processMessage(content: string): Promise<void> {
  const userMsg: DisplayMessage = { role: 'user', content, timestamp: new Date().toISOString() };
  messages.push(userMsg);
  broadcast({ type: 'message', message: userMsg });

  isLoading = true;
  broadcast({ type: 'loading', isLoading: true });

  const controller = new AbortController();
  abortController = controller;
  const startTime = Date.now();

  // Parse for image file paths
  const userContent = parseImagesInMessage(content);

  try {
    const response = await agent.chat(userContent, {
      onText: (text) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'text', content: text });
      },
      onThinking: (text) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'thinking', content: text });
      },
      onToolStart: (name, toolInput, summary) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_start', name, input: toolInput, summary });
      },
      onToolOutput: (content) => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_output', content });
      },
      onToolEnd: () => {
        if (controller.signal.aborted) return;
        broadcast({ type: 'tool_end' });
      },
      onUsage: (u) => {
        usage = { ...u, cost: computeCost(model, u) };
        broadcast({ type: 'usage', usage });
      },
      onCompact: (summary) => {
        addSystemMessage(`Context compacted: ${summary.slice(0, 200)}...`);
      },
    });

    if (!controller.signal.aborted) {
      const elapsed = (Date.now() - startTime) / 1000;
      // Clear streaming text
      broadcast({ type: 'text', content: '' });
      const assistantMsg: DisplayMessage = {
        role: 'assistant',
        content: response,
        timestamp: new Date().toISOString(),
        elapsed,
      };
      messages.push(assistantMsg);
      broadcast({ type: 'message', message: assistantMsg });
      doAutoSave();
    }
  } catch (err: unknown) {
    if (!controller.signal.aborted) {
      const e = err as { status?: number; message?: string };
      let errorMsg = e.message ?? 'Unknown error';
      if (e.status === 401) errorMsg = 'Authentication failed. Check ANTHROPIC_API_KEY.';
      if (e.status === 429) errorMsg = 'Rate limited. Wait a moment.';
      broadcast({ type: 'error', message: errorMsg });
    }
  } finally {
    abortController = null;
    isLoading = false;
    broadcast({ type: 'loading', isLoading: false });
  }
}

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  while (messageQueue.length > 0) {
    const next = messageQueue.shift();
    if (next) await processMessage(next);
  }

  processingQueue = false;
}

function handleCancel(): void {
  if (isLoading && abortController) {
    abortController.abort();
    abortController = null;
    messageQueue.length = 0;
    isLoading = false;
    broadcast({ type: 'text', content: '' });
    broadcast({ type: 'loading', isLoading: false });
    addSystemMessage('Cancelled.');
  }
}

// --- Client connection handling ---

function handleClient(socket: Socket): void {
  clients.add(socket);
  let buffer = '';

  // Send current state
  send(socket, { type: 'connected', state: getState() });

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const cmd = JSON.parse(line) as ClientCommand;
        switch (cmd.type) {
          case 'message': {
            const trimmed = cmd.content.trim();
            if (!trimmed) break;
            if (handleCommand(trimmed)) break;
            if (isLoading) {
              messageQueue.push(trimmed);
              const queuedMsg: DisplayMessage = {
                role: 'user',
                content: `[queued] ${trimmed}`,
                timestamp: new Date().toISOString(),
              };
              messages.push(queuedMsg);
              broadcast({ type: 'message', message: queuedMsg });
            } else {
              messageQueue.push(trimmed);
              void processQueue();
            }
            break;
          }
          case 'cancel':
            handleCancel();
            break;
          case 'command':
            handleCommand(cmd.cmd);
            break;
          case 'ping':
            send(socket, { type: 'pong' });
            break;
        }
      } catch {
        // Malformed JSON, ignore
      }
    }
  });

  socket.on('close', () => {
    clients.delete(socket);
  });

  socket.on('error', () => {
    clients.delete(socket);
  });
}

// --- Server startup ---

function startServer(): Server {
  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  }

  const server = createServer(handleClient);
  server.listen(SOCKET_PATH, () => {
    // Server ready
  });

  return server;
}

function restoreSession(): void {
  const saved = autoLoadSession(workspacePath);
  if (saved) {
    agent.setMessages(saved.agentMessages as ProviderMessage[]);
    messages = saved.uiMessages as DisplayMessage[];
    // Recalculate usage from agent
    usage = agent.totalUsage;
    console.error(`[server] Restored session (${messages.length} messages)`);
  }
}

// --- Main ---

model = process.env['AIGENT_MODEL'] ?? 'claude-opus-4-6-20250514';
currentThinking = (process.env['AIGENT_THINKING'] as ThinkingLevel | undefined) ?? 'high';
workspacePath = process.env['AIGENT_WORKSPACE'] ?? '/workspace';

let mcpManager: MCPManager | null = null;

// Initialize MCP and agent
async function initAgent(): Promise<void> {
  // Start MCP servers (non-blocking — failures are logged, not fatal)
  try {
    mcpManager = await loadMCP(workspacePath);
    const { servers, tools } = mcpManager.stats;
    if (servers > 0) {
      console.error(`[server] MCP: ${servers} server(s), ${tools} tool(s)`);
    }
  } catch (err: unknown) {
    const e = err as { message?: string };
    console.error(`[server] MCP init failed (non-fatal): ${e.message}`);
  }

  agent = new Agent({
    model,
    thinking: currentThinking,
    workspacePath,
    ...(mcpManager ? { mcpManager } : {}),
  });
}

try {
  await initAgent();
} catch (err: unknown) {
  const error = err as { message?: string };
  console.error(`Fatal: ${error.message ?? 'Failed to initialize agent'}`);
  process.exit(1);
}

restoreSession();
const server = startServer();
console.error(`[server] Listening on ${SOCKET_PATH}`);

// --- End-of-session summary ---

function writeEndOfSessionSummary(): void {
  try {
    if (messages.length < 4) return;

    const userMessages = messages.filter((m) => m.role === 'user' && !m.content.startsWith('[queued]'));
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    const systemMessages = messages.filter((m) => m.role === 'system');

    if (userMessages.length === 0) return;

    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    const dateStr = now.toISOString().slice(0, 10);

    // Collect user topics (first 80 chars of each message)
    const topics = userMessages
      .map((m) => String(m.content).slice(0, 80).replace(/\n/g, ' '))
      .slice(0, 10) // max 10 topics
      .map((t) => `  - ${t}`);

    // Estimate cost
    const costStr = usage.cost ? `$${usage.cost < 0.01 ? usage.cost.toFixed(3) : usage.cost.toFixed(2)}` : 'n/a';

    const summary =
      `- Messages: ${messages.length} total (${userMessages.length} user, ${assistantMessages.length} assistant, ${systemMessages.length} system)\n` +
      `- Model: ${model}\n` +
      `- Cost: ${costStr}\n` +
      `- Topics discussed:\n${topics.join('\n')}\n`;

    const memoryDir = join(workspacePath, 'memory');
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const filePath = join(memoryDir, `${dateStr}.md`);
    appendFileSync(filePath, `\n## Session End (${time})\n\n${summary}\n`);
  } catch {
    // Non-critical — don't prevent shutdown
  }
}

// Graceful shutdown
function shutdown(): void {
  writeEndOfSessionSummary();
  doAutoSave();
  if (mcpManager) mcpManager.shutdown();
  server.close();
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep alive
setInterval(() => {}, 60_000);
