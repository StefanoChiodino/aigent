/**
 * aigent Web UI — vanilla TypeScript, zero framework.
 *
 * Connects to the WebSocket bridge, receives ServerEvents,
 * and renders the chat UI using direct DOM manipulation.
 */

// @ts-ignore — loaded from /vendor/marked.js served by the bridge
import { marked } from '/vendor/marked.js';

// ── Types (mirrored from protocol.ts) ────────────────────────

interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
  contextTokens?: number;
}

interface DisplayMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  elapsed?: number;
}

interface BackgroundTaskInfo {
  id: string;
  description: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
}

interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: string;
  profile: string;
  sessionId: string;
  model: string;
  availableModels: string[];
  isLoading: boolean;
  tasks: BackgroundTaskInfo[];
  pendingResults: number;
}

type ServerEvent =
  | { type: 'connected'; state: ServerState }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; name: string; input: string; summary: string }
  | { type: 'tool_output'; content: string }
  | { type: 'tool_end' }
  | { type: 'message'; message: DisplayMessage }
  | { type: 'system'; content: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'loading'; isLoading: boolean }
  | { type: 'error'; message: string }
  | { type: 'state'; thinking?: string; profile?: string; sessionId?: string; model?: string }
  | { type: 'task_update'; task: BackgroundTaskInfo }
  | { type: 'mount_request'; id: string; path: string; mode: string; reason?: string }
  | { type: 'config_write_request'; id: string; file: string; content: string; reason: string }
  | { type: 'host_state'; mounts: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[]; capabilities?: Record<string, string> }
  | { type: 'pong' };

// ── Command registry (mirrors AnsiTUI) ───────────────────────

interface CommandDef {
  name: string;
  desc: string;
  argHint?: string;
}

const COMMANDS: CommandDef[] = [
  { name: '/help',      desc: 'Show available commands' },
  { name: '/reset',     desc: 'Clear conversation' },
  { name: '/compact',   desc: 'Compact context' },
  { name: '/refresh',   desc: 'Reload workspace files' },
  { name: '/restart',   desc: 'Restart server' },
  { name: '/reasoning', desc: 'Toggle reasoning',          argHint: 'on|off' },
  { name: '/effort',    desc: 'Set effort level',          argHint: 'low|medium|high|max' },
  { name: '/model',     desc: 'Show or switch model',      argHint: '<name>' },
  { name: '/image',     desc: 'Send an image',             argHint: '<path> [msg]' },
  { name: '/usage',     desc: 'Token usage stats' },
  { name: '/tasks',     desc: 'Background tasks' },
  { name: '/profiles',  desc: 'List profiles' },
  { name: '/profile',   desc: 'Switch profile',            argHint: '<name>' },
  { name: '/save',      desc: 'Save session' },
  { name: '/sessions',  desc: 'List sessions' },
  { name: '/load',      desc: 'Load session',              argHint: '<id>' },
  { name: '/mount',     desc: 'Mount folder into sandbox', argHint: '<path> [ro|rw]' },
  { name: '/unmount',   desc: 'Remove a mount',            argHint: '<path>' },
  { name: '/mounts',    desc: 'List active mounts' },
  { name: '/grant',     desc: 'Approve pending request' },
  { name: '/deny',      desc: 'Deny pending request' },
  { name: '/approve',   desc: 'Approve config write' },
  { name: '/reject',    desc: 'Reject config write' },
  { name: '/preview',   desc: 'Preview config write' },
];

// ── Configure marked ─────────────────────────────────────────

marked.setOptions({
  breaks: true,
  gfm: true,
});

// ── State ────────────────────────────────────────────────────

let messages: DisplayMessage[] = [];
let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let thinkingLevel = 'high';
let lastEffortLevel = 'high'; // remembered when toggling off/on
let isLoading = false;
let isThinking = false;
let tasks: BackgroundTaskInfo[] = [];
let connStatus: 'connecting' | 'connected' | 'reconnecting' = 'connecting';
let errorMsg: string | null = null;
let modelName = '';
let availableModels: string[] = [];
let mountsList: { hostPath: string; containerPath: string; mode: 'ro' | 'rw' }[] = [];
let capsList: Record<string, string> = {};
let modelPickerOpen = false;

// Streaming state
let streamActive = false;
let streamText = '';
let streamEl: HTMLElement | null = null;

// WebSocket
let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ── DOM refs ─────────────────────────────────────────────────

const $ = (id: string) => document.getElementById(id)!;

const $messages = $('messages');
const $emptyState = $('empty-state');
const $toolBar = $('tool-bar');
const $toolLabel = $('tool-label');
const $connBadge = $('conn-badge');
const $taskBadge = $('task-badge');
const $costBadge = $('cost-badge');
const $ctxMeter = $('ctx-meter');
const $ctxFill = $('ctx-fill');
const $ctxLabel = $('ctx-label');
const $errorBar = $('error-bar');
const $palette = $('command-palette');
const $input = $('input') as HTMLTextAreaElement;
const $send = $('send') as HTMLButtonElement;
const $cancel = $('cancel') as HTMLButtonElement;

// Sidebar DOM refs
const $sbModelBtn = $('sb-model-btn') as HTMLButtonElement;
const $sbModelValue = $('sb-model-value');
const $sbModelPicker = $('sb-model-picker');
const $sbReasoningToggle = $('sb-reasoning-toggle') as HTMLButtonElement;
const $sbEffortPills = $('sb-effort-pills');
const $sbCtxFill = $('sb-ctx-fill');
const $sbCtxLabel = $('sb-ctx-label');
const $sbCtxTokens = $('sb-ctx-tokens');
const $sbCostValue = $('sb-cost-value');
const $sbMountsList = $('sb-mounts-list');
const $sbCapsList = $('sb-caps-list');
const $sbTasksSection = $('sb-tasks-section');
const $sbTasksList = $('sb-tasks-list');

// Command palette state
let paletteItems: CommandDef[] = [];
let paletteSelected = 0;

// ── Pending attachments (images + files) ─────────────────────

interface PendingAttachment {
  id: string;
  name: string;
  mediaType: string;
  data: string;       // base64 (no data: prefix)
  dataUrl?: string;   // for image preview display (only images)
  size: number;       // original file size in bytes
}

let pendingAttachments: PendingAttachment[] = [];
let attachmentIdCounter = 0;

// Map from display text to image dataUrls for rendering in chat bubbles
const messageImageUrls = new Map<string, string[]>();

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ATTACHMENTS = 10;

function isAllowedType(mime: string): boolean {
  return IMAGE_TYPES.includes(mime)
    || mime === 'application/pdf'
    || mime.startsWith('text/')
    || ['application/json', 'application/javascript', 'application/typescript',
        'application/xml', 'application/yaml', 'application/x-yaml',
        'application/toml', 'application/x-sh'].includes(mime);
}

function guessMimeFromExtension(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', json: 'application/json',
    js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript',
    tsx: 'text/typescript', jsx: 'text/javascript',
    py: 'text/plain', yaml: 'application/yaml', yml: 'application/yaml',
    toml: 'application/toml', csv: 'text/csv', xml: 'application/xml',
    html: 'text/html', css: 'text/css', sh: 'application/x-sh',
    bash: 'application/x-sh', rs: 'text/plain', go: 'text/plain',
    java: 'text/plain', c: 'text/plain', cpp: 'text/plain', h: 'text/plain',
    rb: 'text/plain', php: 'text/plain', swift: 'text/plain',
    kt: 'text/plain', scala: 'text/plain', sql: 'text/plain',
    graphql: 'text/plain', proto: 'text/plain', r: 'text/plain',
    pdf: 'application/pdf', svg: 'text/xml', log: 'text/plain',
    env: 'text/plain', cfg: 'text/plain', ini: 'text/plain',
    conf: 'text/plain', dockerfile: 'text/plain', makefile: 'text/plain',
  };
  return map[ext ?? ''] ?? null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function addFile(file: File): void {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) return;
  if (file.size > MAX_FILE_SIZE) return;

  let mime = file.type;
  if (!mime || mime === 'application/octet-stream') {
    mime = guessMimeFromExtension(file.name) ?? mime;
  }
  if (!isAllowedType(mime)) return;

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    const base64 = dataUrl.split(',')[1];
    if (!base64) return;

    const isImage = IMAGE_TYPES.includes(mime);
    pendingAttachments.push({
      id: `att_${++attachmentIdCounter}`,
      name: file.name,
      mediaType: mime,
      data: base64,
      dataUrl: isImage ? dataUrl : undefined,
      size: file.size,
    });
    renderAttachmentPreview();
  };
  reader.readAsDataURL(file);
}

function renderAttachmentPreview(): void {
  let $preview = document.getElementById('attachment-preview');
  if (pendingAttachments.length === 0) {
    if ($preview) $preview.remove();
    return;
  }
  if (!$preview) {
    $preview = document.createElement('div');
    $preview.id = 'attachment-preview';
    const $inputRow = $('input-row');
    $inputRow.parentNode!.insertBefore($preview, $inputRow);
  }
  $preview.innerHTML = '';
  for (const att of pendingAttachments) {
    const thumb = document.createElement('div');
    if (att.dataUrl) {
      // Image thumbnail
      thumb.className = 'attachment-thumb image-thumb';
      const imgEl = document.createElement('img');
      imgEl.src = att.dataUrl;
      thumb.appendChild(imgEl);
    } else {
      // File badge
      thumb.className = 'attachment-thumb file-badge';
      const icon = document.createElement('span');
      icon.className = 'file-icon';
      icon.textContent = att.mediaType === 'application/pdf' ? '\uD83D\uDCC4' : '\uD83D\uDCCB';
      thumb.appendChild(icon);
      const info = document.createElement('div');
      info.className = 'file-info';
      const nameEl = document.createElement('span');
      nameEl.className = 'file-name';
      nameEl.textContent = att.name.length > 24 ? att.name.slice(0, 21) + '...' : att.name;
      nameEl.title = att.name;
      info.appendChild(nameEl);
      const sizeEl = document.createElement('span');
      sizeEl.className = 'file-size';
      sizeEl.textContent = formatFileSize(att.size);
      info.appendChild(sizeEl);
      thumb.appendChild(info);
    }
    // Remove button
    const btn = document.createElement('button');
    btn.className = 'attachment-remove';
    btn.textContent = '\u00d7';
    btn.title = 'Remove';
    btn.addEventListener('click', () => {
      pendingAttachments = pendingAttachments.filter(a => a.id !== att.id);
      renderAttachmentPreview();
    });
    thumb.appendChild(btn);
    $preview.appendChild(thumb);
  }
}

// ── WebSocket connection ─────────────────────────────────────

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    reconnectAttempt = 0;
  };

  ws.onmessage = (ev) => {
    try {
      const event = JSON.parse(ev.data) as ServerEvent;
      handleEvent(event);
    } catch {
      // Malformed JSON
    }
  };

  ws.onclose = () => {
    const wasConnected = connStatus === 'connected';
    connStatus = 'reconnecting';
    ws = null;
    if (wasConnected) {
      isLoading = false;
      streamActive = false;
      streamEl = null;
    }
    updateHeader();
    updateInputState();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose will fire next
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectAttempt++;
  const delay = reconnectAttempt <= 1 ? 200 : reconnectAttempt <= 3 ? 500 : 1000;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function wsSend(data: Record<string, unknown>): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── Event handling ───────────────────────────────────────────

function handleEvent(event: ServerEvent): void {
  switch (event.type) {
    case 'connected':
      connStatus = 'connected';
      messages = event.state.messages;
      usage = event.state.usage;
      thinkingLevel = event.state.thinking;
      if (thinkingLevel !== 'off') lastEffortLevel = thinkingLevel;
      isLoading = event.state.isLoading;
      tasks = event.state.tasks ?? [];
      errorMsg = null;
      streamActive = false;
      streamEl = null;
      modelName = event.state.model;
      availableModels = event.state.availableModels ?? [];
      renderAllMessages();
      updateHeader();
      updateSidebar();
      updateInputState();
      updateSendButton(false);
      break;

    case 'text':
      isThinking = false;
      if (event.content) {
        streamText = event.content;
        updateStreamingDisplay();
      }
      break;

    case 'thinking':
      if (!isThinking && streamActive && streamEl) {
        appendThinkingIndicator();
      }
      isThinking = true;
      break;

    case 'tool_start':
      if (streamActive) {
        finalizeStreamingText();
      }
      showTool(event.name, event.summary);
      streamText = '';
      break;

    case 'tool_output':
      break;

    case 'tool_end':
      hideTool();
      break;

    case 'task_update': {
      const idx = tasks.findIndex((t) => t.id === event.task.id);
      if (idx >= 0) tasks[idx] = event.task;
      else tasks.push(event.task);
      updateHeader();
      updateSidebar();
      // Auto-remove completed/failed tasks after 30s
      if (event.task.status === 'completed' || event.task.status === 'failed') {
        const taskId = event.task.id;
        setTimeout(() => {
          tasks = tasks.filter((t) => t.id !== taskId);
          updateHeader();
          updateSidebar();
        }, 30_000);
      }
      break;
    }

    case 'message':
      if (event.message.role === 'assistant' && streamActive) {
        finalizeStreamEl(event.message.content, event.message.elapsed);
        messages.push(event.message);
        streamActive = false;
        streamText = '';
        streamEl = null;
      } else {
        messages.push(event.message);
        appendMessage(event.message);
      }
      isThinking = false;
      updateHeader();
      break;

    case 'system': {
      const sysMsg: DisplayMessage = {
        role: 'system',
        content: event.content,
        timestamp: new Date().toISOString(),
      };
      messages.push(sysMsg);
      appendMessage(sysMsg);
      break;
    }

    case 'usage':
      usage = event.usage;
      updateHeader();
      updateSidebar();
      break;

    case 'loading':
      isLoading = event.isLoading;
      if (event.isLoading && !streamActive) {
        streamActive = true;
        streamText = '';
        streamEl = createStreamingEl();
      }
      if (!event.isLoading) {
        streamActive = false;
        isThinking = false;
      }
      updateInputState();
      updateHeader();
      break;

    case 'error':
      errorMsg = event.message;
      updateErrorBar();
      break;

    case 'state':
      if (event.thinking) {
        if (event.thinking !== 'off') lastEffortLevel = event.thinking;
        thinkingLevel = event.thinking;
        updateSendButton(false);
      }
      if (event.model) {
        modelName = event.model;
      }
      updateHeader();
      updateSidebar();
      break;

    case 'host_state':
      mountsList = event.mounts;
      if (event.capabilities) capsList = event.capabilities;
      updateSidebar();
      break;

    case 'mount_request':
    case 'config_write_request':
      break;

    case 'pong':
      break;
  }
}

// ── DOM rendering ────────────────────────────────────────────

function hideEmptyState(): void {
  if ($emptyState) $emptyState.classList.add('hidden');
}

function showEmptyState(): void {
  if ($emptyState && messages.length === 0) $emptyState.classList.remove('hidden');
}

function renderAllMessages(): void {
  // Remove all children except #empty-state
  const children = Array.from($messages.children);
  for (const child of children) {
    if (child.id !== 'empty-state') child.remove();
  }
  streamEl = null;

  if (messages.length === 0) {
    showEmptyState();
  } else {
    hideEmptyState();
    for (const msg of messages) {
      appendMessage(msg, false);
    }
  }
  scrollToBottom();
}

function appendMessage(msg: DisplayMessage, animate = true): void {
  hideEmptyState();

  const el = document.createElement('div');
  el.className = `message ${msg.role}`;
  if (!animate) el.style.animation = 'none';

  const label = document.createElement('div');
  label.className = 'role-label';
  label.textContent = msg.role === 'assistant' ? 'agent' : msg.role;
  if (msg.elapsed !== undefined) {
    const elapsed = document.createElement('span');
    elapsed.className = 'elapsed';
    elapsed.textContent = `${msg.elapsed.toFixed(1)}s`;
    label.appendChild(elapsed);
  }
  el.appendChild(label);

  const content = document.createElement('div');
  content.className = 'message-content';
  if (msg.role === 'system') {
    content.textContent = msg.content;
  } else {
    content.innerHTML = renderMarkdown(msg.content);
  }
  el.appendChild(content);

  // Render image thumbnails if this user message had attached images
  const imgUrls = messageImageUrls.get(msg.content);
  if (imgUrls && msg.role === 'user') {
    const strip = document.createElement('div');
    strip.className = 'message-images';
    for (const url of imgUrls) {
      const img = document.createElement('img');
      img.src = url;
      img.className = 'message-image-thumb';
      strip.appendChild(img);
    }
    el.appendChild(strip);
    messageImageUrls.delete(msg.content);
  }

  $messages.appendChild(el);
  scrollToBottom();
}

function createStreamingEl(): HTMLElement {
  hideEmptyState();

  const el = document.createElement('div');
  el.className = 'message assistant streaming';

  const label = document.createElement('div');
  label.className = 'role-label';
  label.textContent = 'agent';
  el.appendChild(label);

  const content = document.createElement('div');
  content.className = 'message-content';
  el.appendChild(content);

  $messages.appendChild(el);
  scrollToBottom();
  return el;
}

function updateStreamingDisplay(): void {
  if (!streamEl) return;
  const content = streamEl.querySelector('.message-content');
  if (!content) return;
  content.textContent = streamText;
  scrollToBottom();
}

function finalizeStreamingText(): void {
  if (!streamEl || !streamText) return;
  const content = streamEl.querySelector('.message-content');
  if (content) {
    content.innerHTML = renderMarkdown(streamText);
  }
}

function finalizeStreamEl(fullContent: string, elapsed?: number): void {
  if (!streamEl) return;
  streamEl.classList.remove('streaming');

  const content = streamEl.querySelector('.message-content');
  if (content) {
    content.innerHTML = renderMarkdown(fullContent);
  }

  if (elapsed !== undefined) {
    const label = streamEl.querySelector('.role-label');
    if (label) {
      const elapsedEl = document.createElement('span');
      elapsedEl.className = 'elapsed';
      elapsedEl.textContent = `${elapsed.toFixed(1)}s`;
      label.appendChild(elapsedEl);
    }
  }
  scrollToBottom();
}

function appendThinkingIndicator(): void {
  if (!streamEl) return;
  const content = streamEl.querySelector('.message-content');
  if (!content) return;
  const indicator = document.createElement('div');
  indicator.className = 'thinking-indicator';
  indicator.innerHTML = '<div class="thinking-dots"><span></span><span></span><span></span></div> reasoning';
  content.appendChild(indicator);
  scrollToBottom();
}

function showTool(name: string, summary: string): void {
  $toolBar.classList.remove('hidden');
  $toolLabel.textContent = summary || name;
}

function hideTool(): void {
  $toolBar.classList.add('hidden');
  $toolLabel.textContent = '';
}

// ── Header / status ──────────────────────────────────────────

function updateHeader(): void {
  // Connection badge
  $connBadge.className = `badge ${connStatus}`;
  $connBadge.textContent = connStatus;

  // Running tasks
  const running = tasks.filter((t) => t.status === 'running').length;
  if (running > 0) {
    $taskBadge.classList.remove('hidden');
    $taskBadge.textContent = `${running} task${running > 1 ? 's' : ''}`;
  } else {
    $taskBadge.classList.add('hidden');
  }

  // Cost
  const cost = usage.cost ?? 0;
  if (cost > 0) {
    $costBadge.classList.remove('hidden');
    $costBadge.textContent = cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
  } else {
    $costBadge.classList.add('hidden');
  }

  // Context meter
  const ctxUsed = usage.contextTokens ?? 0;
  if (ctxUsed > 0) {
    $ctxMeter.classList.remove('hidden');
    const pct = Math.min(100, Math.round((ctxUsed / 200_000) * 100));
    $ctxFill.style.width = `${pct}%`;
    // Color the bar based on usage
    if (pct > 80) $ctxFill.style.background = 'var(--error)';
    else if (pct > 60) $ctxFill.style.background = 'var(--warning)';
    else $ctxFill.style.background = 'var(--accent)';

    const tokStr = ctxUsed >= 1_000_000
      ? (ctxUsed / 1_000_000).toFixed(1) + 'M'
      : ctxUsed >= 1_000
      ? Math.round(ctxUsed / 1_000) + 'k'
      : String(ctxUsed);
    $ctxLabel.textContent = `${tokStr}`;
  } else {
    $ctxMeter.classList.add('hidden');
  }
}

// ── Model picker ─────────────────────────────────────────────

/** Return a short display name for a model ID, e.g. "Opus 4.6". */
function modelDisplayName(id: string): string {
  // Match claude-{family}-{major}-{minor}(-{YYYYMMDD})? — e.g. claude-opus-4-6-20250514
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  // Fallback: strip "claude-" prefix and date suffix
  return id.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

function renderModelPicker(): void {
  $sbModelPicker.innerHTML = '';
  for (const mid of availableModels) {
    const item = document.createElement('button');
    item.className = 'sb-model-option' + (mid === modelName ? ' active' : '');
    item.textContent = modelDisplayName(mid);
    item.title = mid;
    item.addEventListener('click', () => {
      if (mid !== modelName) {
        wsSend({ type: 'message', content: `/model ${mid}` });
      }
      closeModelPicker();
    });
    $sbModelPicker.appendChild(item);
  }
}

function openModelPicker(): void {
  if (availableModels.length === 0) return;
  modelPickerOpen = true;
  renderModelPicker();
  $sbModelPicker.classList.remove('hidden');
  $sbModelBtn.classList.add('open');
}

function closeModelPicker(): void {
  modelPickerOpen = false;
  $sbModelPicker.classList.add('hidden');
  $sbModelBtn.classList.remove('open');
}

$sbModelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (modelPickerOpen) closeModelPicker();
  else openModelPicker();
});

// Close picker when clicking outside
document.addEventListener('click', (e) => {
  if (modelPickerOpen && !$sbModelBtn.contains(e.target as Node) && !$sbModelPicker.contains(e.target as Node)) {
    closeModelPicker();
  }
});

function updateSidebar(): void {
  // Model
  $sbModelValue.textContent = modelName ? modelDisplayName(modelName) : '--';

  // Reasoning toggle + effort pills
  const reasoningOn = thinkingLevel !== 'off';
  $sbReasoningToggle.textContent = reasoningOn ? 'ON' : 'OFF';
  $sbReasoningToggle.classList.toggle('on', reasoningOn);
  $sbEffortPills.classList.toggle('disabled', !reasoningOn);
  // Highlight the active effort pill
  const activeLevel = reasoningOn ? thinkingLevel : lastEffortLevel;
  for (const pill of $sbEffortPills.querySelectorAll('.sb-pill')) {
    (pill as HTMLElement).classList.toggle('active', (pill as HTMLElement).dataset.level === activeLevel);
  }

  // Context meter
  const ctxUsed = usage.contextTokens ?? 0;
  if (ctxUsed > 0) {
    const pct = Math.min(100, Math.round((ctxUsed / 200_000) * 100));
    $sbCtxFill.style.width = `${pct}%`;
    if (pct > 80) $sbCtxFill.style.background = 'var(--error)';
    else if (pct > 60) $sbCtxFill.style.background = 'var(--warning)';
    else $sbCtxFill.style.background = 'var(--accent)';

    const tokStr = ctxUsed >= 1_000_000
      ? (ctxUsed / 1_000_000).toFixed(1) + 'M'
      : ctxUsed >= 1_000
      ? Math.round(ctxUsed / 1_000) + 'k'
      : String(ctxUsed);
    $sbCtxLabel.textContent = tokStr;
    $sbCtxTokens.textContent = `${tokStr} / 200k`;
  } else {
    $sbCtxFill.style.width = '0%';
    $sbCtxLabel.textContent = '';
    $sbCtxTokens.textContent = '--';
  }

  // Cost
  const cost = usage.cost ?? 0;
  $sbCostValue.textContent = cost > 0
    ? (cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`)
    : '$0.00';

  // Mounts
  if (mountsList.length === 0) {
    $sbMountsList.textContent = 'none';
  } else {
    $sbMountsList.innerHTML = '';
    for (const m of mountsList) {
      const item = document.createElement('div');
      item.className = 'mount-item';

      const mode = document.createElement('span');
      mode.className = `mount-mode ${m.mode}`;
      mode.textContent = m.mode;
      item.appendChild(mode);

      const path = document.createElement('span');
      path.className = 'mount-path';
      path.textContent = m.hostPath.split('/').pop() || m.hostPath;
      path.title = m.hostPath;
      item.appendChild(path);

      $sbMountsList.appendChild(item);
    }
  }

  // Capabilities
  const capEntries = Object.entries(capsList);
  if (capEntries.length === 0) {
    $sbCapsList.textContent = '--';
  } else {
    $sbCapsList.innerHTML = '';
    for (const [cap, grant] of capEntries) {
      const item = document.createElement('div');
      item.className = 'cap-item';

      const badge = document.createElement('span');
      badge.className = `cap-grant ${grant}`;
      badge.textContent = grant === 'prompt' ? '?' : grant.slice(0, 3);
      badge.title = grant;
      item.appendChild(badge);

      const name = document.createElement('span');
      name.className = 'cap-name';
      // Shorten: "clipboard.read" → "clip.read", etc.
      name.textContent = cap.replace('clipboard', 'clip').replace('screen', 'scr').replace('audio', 'aud');
      name.title = cap;
      item.appendChild(name);

      $sbCapsList.appendChild(item);
    }
  }

  // Tasks
  $sbTasksSection.style.display = '';
  $sbTasksList.innerHTML = '';
  if (tasks.length === 0) {
    $sbTasksList.textContent = 'none';
  } else {
    // Show most recent first
    const sorted = [...tasks].reverse();
    for (const t of sorted) {
      const item = document.createElement('div');
      item.className = 'task-item';

      const status = document.createElement('span');
      status.className = `task-status ${t.status}`;
      status.textContent = t.status === 'running' ? '\u25B6' : t.status === 'completed' ? '\u2713' : '\u2717';
      status.title = t.status;
      item.appendChild(status);

      const desc = document.createElement('span');
      desc.className = 'task-desc';
      desc.textContent = t.description;
      desc.title = t.description;
      item.appendChild(desc);

      $sbTasksList.appendChild(item);
    }
  }
}

function updateErrorBar(): void {
  if (errorMsg) {
    $errorBar.classList.remove('hidden');
    $errorBar.textContent = errorMsg;
  } else {
    $errorBar.classList.add('hidden');
    $errorBar.textContent = '';
  }
}

function updateInputState(): void {
  $send.classList.toggle('hidden', isLoading);
  $cancel.classList.toggle('hidden', !isLoading);
  $input.placeholder = isLoading ? 'Agent is working\u2026' : 'Message aigent\u2026';
}

// ── Markdown rendering ───────────────────────────────────────

function renderMarkdown(text: string): string {
  try {
    return (marked.parse(text) as string).trim();
  } catch {
    return escapeHtml(text);
  }
}

// ── Utilities ────────────────────────────────────────────────

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function scrollToBottom(): void {
  requestAnimationFrame(() => {
    $messages.scrollTop = $messages.scrollHeight;
  });
}

// ── Command palette ──────────────────────────────────────────

function updatePalette(): void {
  const text = $input.value;
  if (!text.startsWith('/')) {
    paletteItems = [];
    paletteSelected = 0;
    $palette.classList.add('hidden');
    return;
  }

  const spaceIdx = text.indexOf(' ');
  const prefix = spaceIdx > 0 ? text.slice(0, spaceIdx) : text;

  if (spaceIdx > 0 && COMMANDS.some((c) => c.name === prefix)) {
    paletteItems = [];
    paletteSelected = 0;
    $palette.classList.add('hidden');
    return;
  }

  paletteItems = COMMANDS.filter((c) => c.name.startsWith(prefix.toLowerCase()));
  paletteSelected = Math.min(paletteSelected, Math.max(0, paletteItems.length - 1));

  if (paletteItems.length === 0) {
    $palette.classList.add('hidden');
    return;
  }

  $palette.classList.remove('hidden');
  renderPalette();
}

function renderPalette(): void {
  $palette.innerHTML = '';
  for (let i = 0; i < paletteItems.length; i++) {
    const item = paletteItems[i];
    const el = document.createElement('div');
    el.className = 'palette-item' + (i === paletteSelected ? ' selected' : '');

    const left = document.createElement('span');
    left.innerHTML = `<span class="cmd-name">${escapeHtml(item.name)}</span>` +
      (item.argHint ? ` <span class="cmd-args">${escapeHtml(item.argHint)}</span>` : '');
    el.appendChild(left);

    const desc = document.createElement('span');
    desc.className = 'cmd-desc';
    desc.textContent = item.desc;
    el.appendChild(desc);

    el.addEventListener('click', () => {
      paletteSelected = i;
      completePaletteSelection();
    });

    $palette.appendChild(el);
  }

  const selected = $palette.querySelector('.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function completePaletteSelection(): void {
  const item = paletteItems[paletteSelected];
  if (!item) return;
  $input.value = item.argHint ? item.name + ' ' : item.name;
  $input.focus();
  autoGrow();

  if (!item.argHint) {
    submitMessage();
  } else {
    updatePalette();
  }
}

// ── Input handling ───────────────────────────────────────────

function submitMessage(useThinkingOverride = false): void {
  const text = $input.value.trim();
  if (!text && pendingAttachments.length === 0) return;
  $input.value = '';
  paletteItems = [];
  paletteSelected = 0;
  $palette.classList.add('hidden');
  autoGrow();
  const msg: Record<string, unknown> = { type: 'message', content: text };
  if (pendingAttachments.length > 0) {
    msg.attachments = pendingAttachments.map(a => ({ name: a.name, mediaType: a.mediaType, data: a.data }));

    // Build display label
    const images = pendingAttachments.filter(a => IMAGE_TYPES.includes(a.mediaType));
    const files = pendingAttachments.filter(a => !IMAGE_TYPES.includes(a.mediaType));
    const labels: string[] = [];
    if (images.length) labels.push(`${images.length} image${images.length > 1 ? 's' : ''}`);
    if (files.length) labels.push(`${files.length} file${files.length > 1 ? 's' : ''}`);
    const label = `[${labels.join(', ')}]`;
    const displayText = text ? `${label} ${text}` : label;

    // Stash image dataUrls for rendering in the chat bubble
    const imgUrls = pendingAttachments.filter(a => a.dataUrl).map(a => a.dataUrl!);
    if (imgUrls.length > 0) {
      messageImageUrls.set(displayText, imgUrls);
    }

    pendingAttachments = [];
    renderAttachmentPreview();
  }
  if (useThinkingOverride) {
    // Flip: if thinking is on, override to off; if off, override to high
    msg.thinkingOverride = thinkingLevel === 'off' ? 'high' : 'off';
  }
  wsSend(msg);
}

function autoGrow(): void {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
}

$input.addEventListener('keydown', (e) => {
  // Palette navigation
  if (paletteItems.length > 0) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      paletteSelected = Math.max(0, paletteSelected - 1);
      renderPalette();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      paletteSelected = Math.min(paletteItems.length - 1, paletteSelected + 1);
      renderPalette();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      completePaletteSelection();
      return;
    }
    if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      submitMessage(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const trimmed = $input.value.trim();
      if (!COMMANDS.some((c) => c.name === trimmed)) {
        const item = paletteItems[paletteSelected];
        if (item) {
          $input.value = item.argHint ? item.name + ' ' : item.name;
          if (!item.argHint) {
            submitMessage();
          } else {
            autoGrow();
            updatePalette();
          }
          return;
        }
      }
      submitMessage();
      return;
    }
  }

  // Ctrl+Enter = send with thinking override (flip current level)
  if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    submitMessage(true);
    return;
  }

  // Normal Enter to send, Shift+Enter for newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submitMessage();
  }

  if (e.key === 'Escape') {
    if (paletteItems.length > 0) {
      paletteItems = [];
      paletteSelected = 0;
      $palette.classList.add('hidden');
    } else if (isLoading) {
      wsSend({ type: 'cancel' });
    } else {
      $input.value = '';
      autoGrow();
    }
  }
});

$input.addEventListener('input', () => {
  autoGrow();
  updatePalette();
});

// ── Paste & drag-drop image handling ────────────────────────

$input.addEventListener('paste', (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    let mime = file.type;
    if (!mime) mime = guessMimeFromExtension(file.name) ?? '';
    if (isAllowedType(mime)) {
      e.preventDefault();
      addFile(file);
    }
  }
});

const $inputArea = $('input-area');

$inputArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();
  $inputArea.classList.add('drag-over');
});

$inputArea.addEventListener('dragleave', (e) => {
  e.preventDefault();
  $inputArea.classList.remove('drag-over');
});

$inputArea.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  $inputArea.classList.remove('drag-over');
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const file of files) {
    addFile(file);
  }
});

$send.addEventListener('click', () => submitMessage());

// ── Attach button ────────────────────────────────────────────

const $attach = $('attach') as HTMLButtonElement;
const $fileInput = $('file-input') as HTMLInputElement;

$attach.addEventListener('click', () => $fileInput.click());

$fileInput.addEventListener('change', () => {
  const files = $fileInput.files;
  if (!files) return;
  for (const file of files) {
    addFile(file);
  }
  $fileInput.value = ''; // reset so same file can be re-selected
});

$cancel.addEventListener('click', () => {
  wsSend({ type: 'cancel' });
});

// ── Microphone / STT ─────────────────────────────────────────

const $mic = $('mic') as HTMLButtonElement;
const $micIconMic = $mic.querySelector('.icon-mic') as SVGElement;
const $micIconStop = $mic.querySelector('.icon-stop') as SVGElement;
const $micIconSpinner = $mic.querySelector('.icon-spinner') as SVGElement;

let micRecording = false;
let micAudioCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let micSamples: Float32Array[] = [];
let micSource: MediaStreamAudioSourceNode | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let micChunkTimer: ReturnType<typeof setInterval> | null = null;
let micPreviewEl: HTMLElement | null = null;
let micLastText = '';
let micReqSeq = 0;          // increments on each outgoing request
let micDisplayedSeq = 0;   // seq of the last response we actually showed

// Max samples to send per live chunk (8 s at 16 kHz keeps latency bounded)
const MIC_WINDOW_SAMPLES = 16000 * 8;

function encodeWav(samples: Float32Array[], sampleRate: number): ArrayBuffer {
  let totalLen = 0;
  for (const s of samples) totalLen += s.length;
  const pcm = new Float32Array(totalLen);
  let offset = 0;
  for (const s of samples) { pcm.set(s, offset); offset += s.length; }

  // Float32 → Int16
  const pcm16 = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]!));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  const dataLen = pcm16.byteLength;
  const buf = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  str(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);          // subchunk1 size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  str(36, 'data');
  view.setUint32(40, dataLen, true);
  new Int16Array(buf, 44).set(pcm16);
  return buf;
}

async function sendLiveChunk(): Promise<void> {
  if (micSamples.length === 0) return;

  // Snapshot the sequence number for this request so a stale slow response
  // doesn't overwrite a newer one.
  const seq = ++micReqSeq;

  // Build a sliding window over the last MIC_WINDOW_SAMPLES samples
  let totalLen = 0;
  for (const s of micSamples) totalLen += s.length;

  let window: Float32Array[];
  if (totalLen <= MIC_WINDOW_SAMPLES) {
    window = micSamples;
  } else {
    window = [];
    let remaining = MIC_WINDOW_SAMPLES;
    for (let i = micSamples.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = micSamples[i]!;
      if (chunk.length <= remaining) {
        window.unshift(chunk);
        remaining -= chunk.length;
      } else {
        window.unshift(chunk.slice(chunk.length - remaining));
        remaining = 0;
      }
    }
  }

  try {
    const resp = await fetch('/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: encodeWav(window, 16000),
    });
    // Accept any response newer than the last one we displayed — don't
    // require it to be the absolute latest in flight.
    if (resp.ok && seq > micDisplayedSeq) {
      const { text } = await resp.json() as { text?: string };
      if (text) {
        micLastText = text;
        micDisplayedSeq = seq;
        if (micPreviewEl) micPreviewEl.textContent = text;
      }
    }
  } catch {
    // STT not reachable yet — silently wait
  }
}

function micSetState(state: 'idle' | 'recording' | 'transcribing'): void {
  $micIconMic.classList.toggle('hidden', state !== 'idle');
  $micIconStop.classList.toggle('hidden', state !== 'recording');
  $micIconSpinner.classList.toggle('hidden', state !== 'transcribing');
  $mic.classList.toggle('recording', state === 'recording');
  $mic.classList.toggle('transcribing', state === 'transcribing');
}

async function startMic(): Promise<void> {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    micAudioCtx = new AudioContext({ sampleRate: 16000 });
    micSource = micAudioCtx.createMediaStreamSource(micStream);
    // ScriptProcessor is deprecated but works everywhere cross-browser; bufferSize must be power of 2
    micProcessor = micAudioCtx.createScriptProcessor(4096, 1, 1);
    micSamples = [];
    micLastText = '';
    micReqSeq = 0;
    micDisplayedSeq = 0;
    micProcessor.onaudioprocess = (e) => {
      micSamples.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    micSource.connect(micProcessor);
    micProcessor.connect(micAudioCtx.destination);

    // Live preview element shown above the input row
    micPreviewEl = document.createElement('div');
    micPreviewEl.className = 'stt-preview';
    micPreviewEl.textContent = 'Listening\u2026';
    const $inputRow = $('input-row');
    $inputRow.parentNode!.insertBefore(micPreviewEl, $inputRow);

    // Send first chunk after a short delay (let audio accumulate), then every 2 s.
    // Requests run concurrently; the seq counter ensures only the latest wins.
    setTimeout(() => { void sendLiveChunk(); }, 800);
    micChunkTimer = setInterval(() => { void sendLiveChunk(); }, 2000);

    micRecording = true;
    micSetState('recording');
  } catch {
    // Permission denied or no mic
  }
}

async function stopMic(): Promise<void> {
  if (!micRecording) return;
  micRecording = false;

  // Stop live chunk timer
  if (micChunkTimer !== null) { clearInterval(micChunkTimer); micChunkTimer = null; }

  micSetState('transcribing');

  micSource?.disconnect();
  micProcessor?.disconnect();
  micStream?.getTracks().forEach(t => t.stop());
  await micAudioCtx?.close();

  const samples = micSamples;
  micSamples = [];
  micSource = null;
  micProcessor = null;
  micStream = null;
  micAudioCtx = null;

  // Remove live preview
  if (micPreviewEl) { micPreviewEl.remove(); micPreviewEl = null; }

  if (samples.length === 0) { micSetState('idle'); return; }

  let finalText = micLastText;
  try {
    const resp = await fetch('/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: encodeWav(samples, 16000),
    });
    if (resp.ok) {
      const { text } = await resp.json() as { text?: string };
      if (text) finalText = text;
    }
  } catch {
    // STT service not running — use last live chunk result
  }

  if (finalText) {
    const cur = $input.value;
    $input.value = cur ? cur + ' ' + finalText : finalText;
    autoGrow();
    $input.focus();
  }
  micSetState('idle');
}

$mic.addEventListener('click', () => {
  if (micRecording) stopMic();
  else startMic();
});

// ── Ctrl key tracking for thinking-override visual feedback ──

const $iconArrow = $send.querySelector('.icon-arrow') as SVGElement;
const $iconBrain = $send.querySelector('.icon-brain') as SVGElement;
const $hintCtrl = document.getElementById('hint-ctrl');

function updateSendButton(ctrlHeld: boolean): void {
  // Show brain when reasoning will be used, arrow when it won't
  // Ctrl flips the current state for one-shot override
  const currentlyOn = thinkingLevel !== 'off';
  const willThink = ctrlHeld ? !currentlyOn : currentlyOn;

  if (willThink) {
    $iconArrow.classList.add('hidden');
    $iconBrain.classList.remove('hidden');
  } else {
    $iconBrain.classList.add('hidden');
    $iconArrow.classList.remove('hidden');
  }

  // Purple tint only when Ctrl is held (override mode)
  $send.classList.toggle('thinking-override', ctrlHeld);

  // Update hint text
  if ($hintCtrl) {
    $hintCtrl.textContent = currentlyOn ? 'quick' : 'think';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Control') updateSendButton(true);
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control') updateSendButton(false);
});
// Reset if window loses focus while Ctrl is held
window.addEventListener('blur', () => updateSendButton(false));

// ── Sidebar reasoning controls ───────────────────────────────

$sbReasoningToggle.addEventListener('click', () => {
  const cmd = thinkingLevel === 'off' ? '/reasoning on' : '/reasoning off';
  wsSend({ type: 'message', content: cmd });
});

$sbEffortPills.addEventListener('click', (e) => {
  const pill = (e.target as HTMLElement).closest('.sb-pill') as HTMLElement | null;
  if (!pill || pill.classList.contains('active')) return;
  const level = pill.dataset.level;
  if (level) {
    wsSend({ type: 'message', content: `/effort ${level}` });
  }
});

// ── Initialize ───────────────────────────────────────────────

updateHeader();
updateSidebar();
updateInputState();
connect();
$input.focus();
