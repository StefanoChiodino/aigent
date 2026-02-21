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
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  delivery?: 'agent-review' | 'user-pull';
  result?: string;
}

interface ServerState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  thinking: string;
  concise: boolean;
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
  | { type: 'state'; thinking?: string; profile?: string; sessionId?: string; model?: string; concise?: boolean; availableModels?: string[] }
  | { type: 'task_update'; task: BackgroundTaskInfo }
  | { type: 'mount_request'; id: string; path: string; mode: string; reason?: string }
  | { type: 'config_write_request'; id: string; file: string; content: string; reason: string }
  | { type: 'patch_request'; id: string; diff: string; reason: string }
  | { type: 'screenshot_request'; id: string }
  | { type: 'screen_share_request'; id: string }
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
  { name: '/concise',   desc: 'Concise/voice mode',        argHint: 'on|off' },
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
  { name: '/approve',        desc: 'Approve config write' },
  { name: '/reject',         desc: 'Reject config write' },
  { name: '/preview',        desc: 'Preview config write' },
  { name: '/approve-patch',  desc: 'Approve patch request' },
  { name: '/reject-patch',   desc: 'Reject patch request' },
];

// ── Configure marked ─────────────────────────────────────────

marked.setOptions({
  breaks: true,
  gfm: true,
});

// ── Settings ─────────────────────────────────────────────────

type SettingType = 'toggle' | 'slider' | 'number' | 'text' | 'select' | 'password';

interface SettingDef {
  key: string;        // env var name (e.g. 'AIGENT_MODEL') or client key
  label: string;
  desc?: string;
  group: string;
  type: SettingType;
  default: boolean | number | string;
  // slider / number
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  // select
  options?: { value: string; label: string }[];
  // 'server' = stored in .env on host, requires restart to take effect
  // 'client' = stored in localStorage, takes effect immediately
  scope: 'server' | 'client';
  restartRequired?: boolean; // only meaningful for scope='server'
  placeholder?: string;
}

const SETTINGS_SCHEMA: SettingDef[] = [
  // ── Provider ─────────────────────────────────────────────
  {
    key: 'AIGENT_PROVIDER',
    label: 'Provider',
    desc: 'LLM provider. Auto-detected from available API keys if omitted.',
    group: 'Provider',
    type: 'select',
    default: '',
    options: [
      { value: '', label: 'Auto-detect' },
      { value: 'anthropic', label: 'Anthropic' },
      { value: 'openai', label: 'OpenAI / compatible' },
    ],
    scope: 'client',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    desc: 'sk-ant-... — stored in .env, never in settings.json.',
    group: 'Provider',
    type: 'password',
    default: '',
    placeholder: 'sk-ant-...',
    scope: 'server',
  },
  {
    key: 'AIGENT_BASE_URL',
    label: 'OpenAI base URL',
    desc: 'Base URL for OpenAI-compatible endpoint (e.g. http://127.0.0.1:1234/v1).',
    group: 'Provider',
    type: 'text',
    default: '',
    placeholder: 'http://127.0.0.1:1234/v1',
    scope: 'client',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    desc: 'Used when provider is OpenAI. Stored in .env, never in settings.json.',
    group: 'Provider',
    type: 'password',
    default: '',
    placeholder: 'sk-... or not-needed',
    scope: 'server',
  },
  // ── Model ────────────────────────────────────────────────
  {
    key: 'AIGENT_MODEL',
    label: 'Default model',
    desc: 'Model used at startup. Can be changed live from the sidebar.',
    group: 'Model',
    type: 'text',
    default: 'claude-opus-4-6',
    placeholder: 'claude-opus-4-6',
    scope: 'client',
  },
  // ── Tools ────────────────────────────────────────────────
  {
    key: 'AIGENT_NO_TOOLS',
    label: 'Disable all tools',
    desc: 'Send no tool definitions to the model. Useful for local models without function-calling support.',
    group: 'Tools',
    type: 'toggle',
    default: false,
    scope: 'client',
  },
  {
    key: 'AIGENT_TOOLS_ALLOWLIST',
    label: 'Tool allowlist',
    desc: 'Comma-separated list of tools to enable. Leave blank to enable all.',
    group: 'Tools',
    type: 'text',
    default: '',
    placeholder: 'exec,read_file,write_file',
    scope: 'client',
  },
  // ── Prompt ───────────────────────────────────────────────
  {
    key: 'AIGENT_SLIM_PROMPT',
    label: 'Slim prompt',
    desc: 'Omit MEMORY.md from the system prompt to save tokens.',
    group: 'Prompt',
    type: 'toggle',
    default: false,
    scope: 'client',
  },
  {
    key: 'AIGENT_FULL_LOGS',
    label: 'Full session logs in prompt',
    desc: 'Include complete recent session logs (not just an index) in the system prompt.',
    group: 'Prompt',
    type: 'toggle',
    default: false,
    scope: 'client',
  },
  // ── Services ─────────────────────────────────────────────
  {
    key: 'AIGENT_WEB_PORT',
    label: 'Web UI port',
    desc: 'Port the web server listens on.',
    group: 'Services',
    type: 'number',
    default: 3141,
    min: 1024,
    max: 65535,
    scope: 'client',
  },
  {
    key: 'AIGENT_STT_URL',
    label: 'STT service URL',
    desc: 'Speech-to-text service endpoint.',
    group: 'Services',
    type: 'text',
    default: 'http://127.0.0.1:8765',
    placeholder: 'http://127.0.0.1:8765',
    scope: 'client',
  },
  {
    key: 'AIGENT_TTS_URL',
    label: 'TTS service URL',
    desc: 'Text-to-speech service endpoint.',
    group: 'Services',
    type: 'text',
    default: 'http://127.0.0.1:8766',
    placeholder: 'http://127.0.0.1:8766',
    scope: 'client',
  },
  // ── Microphone / VAD ─────────────────────────────────────
  {
    key: 'mic_silence_threshold',
    label: 'Silence threshold',
    desc: 'RMS level below which audio is treated as silence. Lower = more sensitive.',
    group: 'Microphone',
    type: 'number',
    default: 0.015,
    min: 0.001,
    max: 0.2,
    step: 0.001,
    scope: 'client',
  },
  {
    key: 'mic_loud_frames',
    label: 'Speech onset frames',
    desc: 'Consecutive loud frames required before speech is considered active. Higher = less false triggers.',
    group: 'Microphone',
    type: 'number',
    default: 2,
    min: 1,
    max: 10,
    step: 1,
    unit: ' frames',
    scope: 'client',
  },
  {
    key: 'mic_silence_tail_ms',
    label: 'Silence tail',
    desc: 'How long to keep accumulating audio after speech ends (avoids clipping word endings).',
    group: 'Microphone',
    type: 'number',
    default: 500,
    min: 100,
    max: 2000,
    step: 50,
    unit: ' ms',
    scope: 'client',
  },
  {
    key: 'mic_auto_send',
    label: 'Auto-send on silence',
    desc: 'In always-on mode: automatically submit after silence is detected.',
    group: 'Microphone',
    type: 'toggle',
    default: false,
    scope: 'client',
  },
  {
    key: 'mic_auto_send_ms',
    label: 'Auto-send silence duration',
    desc: 'How long silence must persist before auto-sending (only used when auto-send is on).',
    group: 'Microphone',
    type: 'number',
    default: 1500,
    min: 300,
    max: 5000,
    step: 100,
    unit: ' ms',
    scope: 'client',
  },
];

// serverSettings holds the current values of server-scoped settings as reported
// by the gatekeeper (sent on connection). Pending edits are tracked separately
// and flushed when the user saves.
type SettingsValues = Record<string, boolean | number | string>;

let serverSettings: SettingsValues = {};
let serverSettingsPending: SettingsValues = {}; // unsaved edits

// Load/save server settings from localStorage as a local cache (shown until server sends real values)
function loadServerSettingsCache(): SettingsValues {
  try {
    const stored = localStorage.getItem('aigent-server-settings-cache');
    if (stored) return JSON.parse(stored) as SettingsValues;
  } catch { /* ignore */ }
  return {};
}

function saveServerSettingsCache(values: SettingsValues): void {
  localStorage.setItem('aigent-server-settings-cache', JSON.stringify(values));
}

serverSettings = loadServerSettingsCache();

// ── Client settings (persisted to workspace/config/settings.json on the host) ─
// localStorage is used as a fast-read cache; the server is the source of truth.
// On WebSocket connect the server sends a 'client_settings' event which overwrites
// the cache. Changes are written immediately to both cache and server.

const CLIENT_SETTINGS_LS_KEY = 'aigent-client-settings';

function loadClientSettingsCache(): Record<string, boolean | number | string> {
  try {
    const raw = localStorage.getItem(CLIENT_SETTINGS_LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean | number | string>;
    // One-time migration from old per-key format (aigent-client-<key>)
    const migrated: Record<string, boolean | number | string> = {};
    for (const def of SETTINGS_SCHEMA.filter(d => d.scope === 'client')) {
      const old = localStorage.getItem(`aigent-client-${def.key}`);
      if (old !== null) {
        migrated[def.key] = def.type === 'toggle' ? old === 'true'
          : def.type === 'number' ? (Number(old) || def.default as number)
          : old;
        localStorage.removeItem(`aigent-client-${def.key}`);
      }
    }
    return migrated;
  } catch { /* ignore */ }
  return {};
}

let clientSettings: Record<string, boolean | number | string> = loadClientSettingsCache();

function saveClientSettingsCache(): void {
  localStorage.setItem(CLIENT_SETTINGS_LS_KEY, JSON.stringify(clientSettings));
}

function getClientSetting(key: string): boolean | number | string {
  const def = SETTINGS_SCHEMA.find(d => d.key === key && d.scope === 'client');
  if (!def) return '';
  if (key in clientSettings) return clientSettings[key]!;
  return def.default;
}

function setClientSetting(key: string, value: boolean | number | string): void {
  clientSettings[key] = value;
  saveClientSettingsCache();
  // Persist to server JSON file and show toast on success
  fetch('/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [key]: value }),
  }).then(() => { showSettingsToast(); }).catch(() => { /* localStorage cache still updated */ });
}

// ── State ────────────────────────────────────────────────────

let messages: DisplayMessage[] = [];
let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let thinkingLevel = 'high';
let lastEffortLevel = 'high'; // remembered when toggling off/on
let conciseMode = false;
let isLoading = false;
let isThinking = false;
let tasks: BackgroundTaskInfo[] = [];
let connStatus: 'connecting' | 'connected' | 'reconnecting' = 'connecting';
let errorMsg: string | null = null;
let turnStartCtx = 0; // contextTokens at start of current turn, for delta display
let modelName = '';
let availableModels: string[] = [];
let mountsList: { hostPath: string; containerPath: string; mode: 'ro' | 'rw'; expiresAt?: number; durationMinutes?: number }[] = [];
let capsList: Record<string, string> = {};
let modelPickerOpen = false;

// Permission request queue
interface DiffFile {
  name: string;    // display filename (basename)
  path: string;    // full container path
  content: string; // the file's portion of the diff
}

interface PermRequest {
  type: 'mount' | 'config_write' | 'patch';
  id: string;
  title: string;
  detail: string;
  approveCmd: string;
  denyCmd: string;
  durationMinutes?: number;
  diff?: string;
  diffFiles?: DiffFile[]; // parsed per-file sections for tab navigation
}

let permQueue: PermRequest[] = [];
let permShowing = false;

// Streaming state
let streamActive = false;
let streamText = '';
let streamEl: HTMLElement | null = null;
let streamTtsBtn: HTMLElement | null = null;

// Inline trace state (thinking + tool blocks embedded in message)
let streamThinkingText = '';
let streamThinkingEl: HTMLElement | null = null;
let currentToolEl: HTMLElement | null = null;
let currentToolOutput = '';

// TTS state
let ttsAudio: HTMLAudioElement | null = null;
let ttsSpeakingBtn: HTMLElement | null = null;
let ttsAbortCtrl: AbortController | null = null;
let ttsAutoSpeak = localStorage.getItem('tts-auto-speak') === 'true';
let ttsRatePct = Number(localStorage.getItem('tts-rate-pct') ?? '25'); // integer, e.g. 25 → "+25%"
// Streaming TTS queue (for auto-speak during streaming)
let ttsChunkQueue: Array<Promise<string>> = [];
let ttsChunkPlaying = false;
let ttsStreamLastLen = 0;
let ttsStreamFetchCtrls: AbortController[] = [];
// In concise mode: tracks whether we've already spoken the <speak> block for the current message
let speakBlockSpoken = false;

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

// Permission modal DOM refs
const $permOverlay = $('perm-overlay');
const $permIcon = $('perm-card-icon');
const $permTitle = $('perm-card-title');
const $permDetail = $('perm-card-detail');
const $permDuration = $('perm-card-duration');
const $permDiff = $('perm-card-diff');
const $patchViewer = $('patch-viewer');
const $patchFileList = $('patch-file-list');
const $permApproveBtn = $('perm-approve-btn') as HTMLButtonElement;
const $permDenyBtn = $('perm-deny-btn') as HTMLButtonElement;

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
const $sbTtsToggle = $('sb-tts-toggle') as HTMLButtonElement;
const $sbTtsRate = $('sb-tts-rate') as HTMLInputElement;
const $sbTtsRateLabel = $('sb-tts-rate-label');
const $sbConciseToggle = $('sb-concise-toggle') as HTMLButtonElement;

// Settings modal DOM refs
const $settingsOverlay = $('settings-overlay');
const $settingsNav = $('settings-nav');
const $settingsBody = $('settings-body');
const $settingsBtn = $('settings-btn') as HTMLButtonElement;
const $settingsClose = $('settings-close') as HTMLButtonElement;
const $settingsToast = $('settings-toast');

let settingsToastTimer: ReturnType<typeof setTimeout> | null = null;
function showSettingsToast(): void {
  $settingsToast.classList.remove('hidden', 'fade-out');
  if (settingsToastTimer !== null) clearTimeout(settingsToastTimer);
  settingsToastTimer = setTimeout(() => {
    $settingsToast.classList.add('fade-out');
    settingsToastTimer = setTimeout(() => $settingsToast.classList.add('hidden'), 400);
  }, 1400);
}

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
      streamTtsBtn = null;
      streamThinkingText = '';
      streamThinkingEl = null;
      currentToolEl = null;
      currentToolOutput = '';
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
      conciseMode = event.state.concise ?? false;
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
      if (isThinking) finalizeThinkingBlock();
      isThinking = false;
      if (event.content) {
        streamText = event.content;
        updateStreamingDisplay();
        ttsFlushStream();
      }
      break;

    case 'thinking':
      if (!isThinking && streamActive && streamEl) {
        appendThinkingToStream();
      }
      isThinking = true;
      streamThinkingText += event.content;
      if (streamThinkingEl) {
        const thinkBody = streamThinkingEl.querySelector<HTMLElement>('.thinking-body');
        if (thinkBody) thinkBody.textContent = streamThinkingText;
      }
      break;

    case 'tool_start':
      if (isThinking) { finalizeThinkingBlock(); isThinking = false; }
      if (streamActive) {
        finalizeStreamingText();
        ttsFlushStream(true);
      }
      showTool(event.name, event.summary);
      if (streamEl) appendToolToStream(event.name, event.summary, event.input);
      streamText = '';
      ttsStreamLastLen = 0;
      currentToolOutput = '';
      break;

    case 'tool_output':
      currentToolOutput += event.content;
      break;

    case 'tool_end':
      hideTool();
      if (currentToolEl) {
        finalizeToolBlock(currentToolEl, currentToolOutput);
        currentToolEl = null;
        currentToolOutput = '';
      }
      break;

    case 'task_update': {
      const idx = tasks.findIndex((t) => t.id === event.task.id);
      if (idx >= 0) tasks[idx] = event.task;
      else tasks.push(event.task);
      updateHeader();
      updateSidebar();
      // Auto-remove completed/failed tasks after 30s
      if (event.task.status === 'completed' || event.task.status === 'failed' || event.task.status === 'cancelled') {
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
        // Finalize any in-progress traces
        if (isThinking) finalizeThinkingBlock();
        if (currentToolEl) { finalizeToolBlock(currentToolEl, currentToolOutput); currentToolEl = null; currentToolOutput = ''; }
        if (ttsAutoSpeak) {
          if (speakBlockSpoken) {
            // Already spoken the <speak> block during streaming — nothing more to do
          } else {
            const speakContent = extractSpeakContent(event.message.content);
            if (speakContent) {
              // <speak> block arrived but wasn't detected mid-stream (e.g. very fast response)
              speakText(speakContent);
            } else {
              // Normal mode: flush any remaining unspoken sentence fragment
              ttsEnqueueChunk(event.message.content.slice(ttsStreamLastLen));
              ttsStreamLastLen = 0;
            }
          }
        }
        finalizeStreamEl(event.message.content, event.message.elapsed);
        messages.push(event.message);
        streamActive = false;
        streamText = '';
        streamEl = null;
        if (!ttsChunkPlaying) streamTtsBtn = null;
      } else {
        messages.push(event.message);
        appendMessage(event.message);
        if (ttsAutoSpeak && event.message.role === 'assistant') {
          const speakContent = extractSpeakContent(event.message.content);
          const btn = $messages.querySelector<HTMLElement>('.message:last-child .tts-btn');
          speakText(speakContent ?? event.message.content, btn ?? undefined);
        }
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
        ttsStopStream();
        streamActive = true;
        streamText = '';
        streamThinkingText = '';
        streamThinkingEl = null;
        currentToolEl = null;
        currentToolOutput = '';
        speakBlockSpoken = false;
        turnStartCtx = usage.contextTokens ?? 0;
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
      if (event.concise !== undefined) {
        conciseMode = event.concise;
      }
      if (event.availableModels) {
        availableModels = event.availableModels;
        renderModelPicker();
      }
      updateHeader();
      updateSidebar();
      break;

    case 'host_state':
      mountsList = event.mounts;
      if (event.capabilities) capsList = event.capabilities;
      updateSidebar();
      break;

    case 'client_settings':
      // Server is source of truth — merge into local cache and persist.
      clientSettings = { ...clientSettings, ...event.settings };
      saveClientSettingsCache();
      break;

    case 'mount_request': {
      const detail = `${event.path}${event.reason ? `\n${event.reason}` : ''}`;
      enqueuePermRequest({
        type: 'mount',
        id: event.id,
        title: `Mount Request (${event.mode})`,
        detail,
        approveCmd: `/grant ${event.id}`,
        denyCmd: `/deny ${event.id}`,
        ...(event.durationMinutes !== undefined ? { durationMinutes: event.durationMinutes } : {}),
      });
      break;
    }

    case 'config_write_request': {
      const detail = `File: ${event.file}\nReason: ${event.reason}`;
      enqueuePermRequest({
        type: 'config_write',
        id: event.id,
        title: 'Config Write Request',
        detail,
        approveCmd: `/approve ${event.id}`,
        denyCmd: `/reject ${event.id}`,
      });
      break;
    }

    case 'patch_request': {
      const diffFiles = parseDiffIntoFiles(event.diff);
      const fileCount = diffFiles.length;
      const title = fileCount === 1
        ? `Patch: ${diffFiles[0]!.name}`
        : `Patch: ${fileCount} files`;
      enqueuePermRequest({
        type: 'patch',
        id: event.id,
        title,
        detail: event.reason,
        diff: event.diff,
        diffFiles,
        approveCmd: `/approve-patch ${event.id}`,
        denyCmd: `/reject-patch ${event.id}`,
      });
      break;
    }

    case 'screenshot_request': {
      const { id } = event;
      if (!screenStream || !screenVideo || screenVideo.videoWidth === 0 || screenVideo.videoHeight === 0) {
        wsSend({ type: 'screenshot_response', id, ok: false, message: 'Screen sharing not active. Click the monitor icon in the input bar to start sharing.' });
        break;
      }
      const canvas = document.createElement('canvas');
      canvas.width = screenVideo.videoWidth;
      canvas.height = screenVideo.videoHeight;
      canvas.getContext('2d')!.drawImage(screenVideo, 0, 0);
      const base64 = canvas.toDataURL('image/png').split(',')[1];
      wsSend({ type: 'screenshot_response', id, ok: true, data: base64, mediaType: 'image/png', message: 'Screenshot captured' });
      break;
    }

    case 'screen_share_request': {
      const { id } = event;
      void (async () => {
        try {
          if (!screenStream || !screenVideo) {
            // Start sharing — this opens the OS picker
            screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
            screenVideo = document.createElement('video');
            screenVideo.srcObject = screenStream;
            screenVideo.muted = true;
            await new Promise<void>(resolve => { screenVideo!.onloadedmetadata = () => resolve(); });
            await screenVideo.play();
            await new Promise<void>(resolve => {
              if (screenVideo!.readyState >= 3) resolve();
              else screenVideo!.oncanplay = () => resolve();
            });
            screenStream.getVideoTracks()[0].addEventListener('ended', () => {
              screenStream = null;
              screenVideo = null;
              setScreenCapState(false);
            });
            setScreenCapState(true);
          }
          wsSend({ type: 'screen_share_response', id, ok: true, message: 'Screen sharing started' });
        } catch {
          wsSend({ type: 'screen_share_response', id, ok: false, message: 'Screen sharing cancelled or denied' });
        }
      })();
      break;
    }

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
  streamTtsBtn = null;

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

// ── TTS (text-to-speech) ─────────────────────────────────────

function stripMarkdownForTTS(text: string): string {
  // Remove fenced code blocks entirely
  text = text.replace(/```[\s\S]*?```/g, ' code block. ');
  // Remove inline code — keep content
  text = text.replace(/`([^`]+)`/g, '$1');
  // Remove heading markers
  text = text.replace(/^#+\s+/gm, '');
  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}$/gm, '');
  // Remove bold+italic, bold, italic — keep the text
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '$1');
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/\*(.+?)\*/g, '$1');
  text = text.replace(/___(.+?)___/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');
  text = text.replace(/_(.+?)_/g, '$1');
  // Remove images
  text = text.replace(/!\[.*?\]\([^)]+\)/g, '');
  // Remove links — keep link text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  // Collapse excessive blank lines
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Extract content inside <speak>...</speak>, or null if absent. */
function extractSpeakContent(text: string): string | null {
  const m = text.match(/<speak>([\s\S]*?)<\/speak>/);
  return m ? m[1].trim() : null;
}

/** Remove <speak>...</speak> block from text (for display). */
function stripSpeakTag(text: string): string {
  return text.replace(/<speak>[\s\S]*?<\/speak>/g, '').trimEnd();
}

function ttsResetBtn(btn: HTMLElement): void {
  btn.classList.remove('speaking');
  btn.title = 'Speak';
  (btn.querySelector('.icon-speak') as SVGElement | null)?.classList.remove('hidden');
  (btn.querySelector('.icon-stop-tts') as SVGElement | null)?.classList.add('hidden');
}

function ttsActivateBtn(btn: HTMLElement): void {
  btn.classList.add('speaking');
  btn.title = 'Stop';
  (btn.querySelector('.icon-speak') as SVGElement | null)?.classList.add('hidden');
  (btn.querySelector('.icon-stop-tts') as SVGElement | null)?.classList.remove('hidden');
}

function speakText(text: string, btn?: HTMLElement): void {
  // Toggle off if clicking the same button while it's playing (or loading)
  if (btn && ttsSpeakingBtn === btn) {
    ttsAbortCtrl?.abort();
    ttsAbortCtrl = null;
    ttsAudio?.pause();
    ttsAudio = null;
    ttsResetBtn(btn);
    ttsSpeakingBtn = null;
    return;
  }

  // Cancel any in-flight request and stop any currently playing audio (incl. stream TTS)
  ttsStopStream();
  ttsAbortCtrl?.abort();
  ttsAbortCtrl = null;
  if (ttsAudio) {
    ttsAudio.pause();
    ttsAudio = null;
  }
  if (ttsSpeakingBtn) {
    ttsResetBtn(ttsSpeakingBtn);
    ttsSpeakingBtn = null;
  }

  ttsSpeakingBtn = btn ?? null;
  const ctrl = new AbortController();
  ttsAbortCtrl = ctrl;
  if (btn) ttsActivateBtn(btn);

  const stripped = stripMarkdownForTTS(text);
  const rateStr = ttsRatePct >= 0 ? `+${ttsRatePct}%` : `${ttsRatePct}%`;
  fetch(`/tts?rate=${encodeURIComponent(rateStr)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: stripped,
    signal: ctrl.signal,
  }).then(async (resp) => {
    if (!resp.ok) throw new Error('TTS unavailable');
    const blob = await resp.blob();
    const blobUrl = URL.createObjectURL(blob);
    // Discard if a newer request has taken over
    if (ttsAbortCtrl !== ctrl) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    const audio = new Audio(blobUrl);
    ttsAudio = audio;
    audio.onended = () => {
      URL.revokeObjectURL(blobUrl);
      ttsAudio = null;
      if (ttsAbortCtrl === ctrl) ttsAbortCtrl = null;
      if (ttsSpeakingBtn === btn) {
        if (btn) ttsResetBtn(btn);
        ttsSpeakingBtn = null;
      }
    };
    void audio.play();
  }).catch((err: unknown) => {
    if (err instanceof Error && err.name === 'AbortError') return;
    if (ttsAbortCtrl === ctrl) ttsAbortCtrl = null;
    if (ttsSpeakingBtn === btn) {
      if (btn) ttsResetBtn(btn);
      ttsSpeakingBtn = null;
    }
  });
}

// ── Streaming TTS helpers ─────────────────────────────────────

function ttsStopStream(): void {
  for (const ctrl of ttsStreamFetchCtrls) ctrl.abort();
  ttsStreamFetchCtrls = [];
  ttsChunkQueue = [];
  ttsChunkPlaying = false;
  ttsStreamLastLen = 0;
  if (ttsAudio) { ttsAudio.pause(); ttsAudio = null; }
  if (streamTtsBtn) { streamTtsBtn.remove(); streamTtsBtn = null; }
  updateInputState();
}

function ttsStopAll(): void {
  ttsStopStream();
  ttsAbortCtrl?.abort();
  ttsAbortCtrl = null;
  if (ttsSpeakingBtn) { ttsResetBtn(ttsSpeakingBtn); ttsSpeakingBtn = null; }
}

function ttsEnqueueChunk(text: string): void {
  const stripped = stripMarkdownForTTS(text);
  if (!stripped.trim()) return;
  const ctrl = new AbortController();
  ttsStreamFetchCtrls.push(ctrl);
  const rateStr = ttsRatePct >= 0 ? `+${ttsRatePct}%` : `${ttsRatePct}%`;
  const p = fetch(`/tts?rate=${encodeURIComponent(rateStr)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: stripped,
    signal: ctrl.signal,
  }).then(async (r) => {
    if (!r.ok) throw new Error('tts error');
    return URL.createObjectURL(await r.blob());
  });
  ttsChunkQueue.push(p);
  if (!ttsChunkPlaying) void ttsDrainQueue();
}

async function ttsDrainQueue(): Promise<void> {
  ttsChunkPlaying = true;
  updateInputState();
  if (streamTtsBtn) streamTtsBtn.classList.remove('hidden');
  while (ttsChunkQueue.length > 0) {
    const p = ttsChunkQueue.shift()!;
    let blobUrl: string;
    try {
      blobUrl = await p;
    } catch {
      continue; // fetch aborted or failed
    }
    if (!ttsChunkPlaying) { URL.revokeObjectURL(blobUrl); break; }
    await new Promise<void>((resolve) => {
      const audio = new Audio(blobUrl);
      ttsAudio = audio;
      const cleanup = () => { URL.revokeObjectURL(blobUrl); ttsAudio = null; resolve(); };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      void audio.play().catch(cleanup);
    });
    if (!ttsChunkPlaying) break;
  }
  ttsChunkPlaying = false;
  updateInputState();
  if (streamTtsBtn) { streamTtsBtn.remove(); streamTtsBtn = null; }
}

// Detect sentence boundaries in newly streamed text and enqueue each sentence.
// Pass final=true at stream end to flush any remaining text without a boundary.
function ttsFlushStream(final = false): void {
  if (!ttsAutoSpeak) return;
  // In concise mode, speak the <speak> block as soon as it's complete in the stream, then stop.
  // The <speak> block is output first, so this fires early while the rest of the response loads.
  if (conciseMode) {
    if (!speakBlockSpoken) {
      const speakContent = extractSpeakContent(streamText);
      if (speakContent) {
        speakBlockSpoken = true;
        speakText(speakContent);
      }
    }
    return;
  }
  const unspoken = streamText.slice(ttsStreamLastLen);
  if (!unspoken) return;

  if (final) {
    ttsEnqueueChunk(unspoken);
    ttsStreamLastLen = streamText.length;
    return;
  }

  // Match sentence-ending punctuation followed by whitespace, or a blank line
  const re = /[.!?]['"»]?\s+|\n\n/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(unspoken)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd > 0) {
    ttsEnqueueChunk(unspoken.slice(0, lastEnd));
    ttsStreamLastLen += lastEnd;
  }
}

function createTTSBtn(text: string): HTMLElement {
  const btn = document.createElement('button');
  btn.className = 'tts-btn';
  btn.title = 'Speak';
  // Speaker icon
  btn.innerHTML = `<svg class="icon-speak" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><svg class="icon-stop-tts hidden" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    speakText(text, btn);
  });
  return btn;
}

/** Creates a small icon button that shows the <speak> summary on hover. */
function createSpeakPreviewBtn(speakContent: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'speak-preview';
  wrap.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const tooltip = document.createElement('div');
  tooltip.className = 'speak-preview-tooltip';
  tooltip.textContent = speakContent;
  wrap.appendChild(tooltip);
  return wrap;
}

function appendMessage(msg: DisplayMessage, animate = true): void {
  hideEmptyState();

  // Group consecutive system messages into one box
  if (msg.role === 'system') {
    const lastChild = $messages.lastElementChild;
    if (lastChild?.classList.contains('message') && lastChild.classList.contains('system')) {
      const existingContent = lastChild.querySelector('.message-content');
      if (existingContent) {
        const sep = document.createElement('div');
        sep.className = 'system-separator';
        existingContent.appendChild(sep);
        const line = document.createElement('div');
        line.textContent = msg.content;
        existingContent.appendChild(line);
        scrollToBottom();
        return;
      }
    }
  }

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
  if (msg.role === 'assistant') {
    const speakContent = extractSpeakContent(msg.content);
    label.appendChild(createTTSBtn(speakContent ?? msg.content));
    if (speakContent) label.appendChild(createSpeakPreviewBtn(speakContent));
  }
  el.appendChild(label);

  const content = document.createElement('div');
  content.className = 'message-content';
  if (msg.role === 'system') {
    content.textContent = msg.content;
  } else {
    content.innerHTML = renderMarkdown(stripSpeakTag(msg.content));
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

  const stopBtn = document.createElement('button');
  stopBtn.className = 'tts-btn hidden speaking';
  stopBtn.title = 'Stop speaking';
  stopBtn.innerHTML = `<svg class="icon-speak hidden" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg><svg class="icon-stop-tts" width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ttsStopStream();
  });
  streamTtsBtn = stopBtn;
  label.appendChild(stopBtn);

  el.appendChild(label);

  const traces = document.createElement('div');
  traces.className = 'message-traces';
  const tracesInner = document.createElement('div');
  tracesInner.className = 'traces-inner';
  traces.appendChild(tracesInner);
  el.appendChild(traces);

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
  content.textContent = stripSpeakTag(streamText);
  scrollToBottom();
}

function finalizeStreamingText(): void {
  if (!streamEl || !streamText) return;
  const content = streamEl.querySelector('.message-content');
  if (content) {
    content.innerHTML = renderMarkdown(stripSpeakTag(streamText));
  }
}

function finalizeStreamEl(fullContent: string, elapsed?: number): void {
  if (!streamEl) return;
  streamEl.classList.remove('streaming');

  const content = streamEl.querySelector('.message-content');
  if (content) {
    content.innerHTML = renderMarkdown(stripSpeakTag(fullContent));
  }

  // Collapse traces: add summary toggle if there are any trace blocks
  const traces = streamEl.querySelector<HTMLElement>('.message-traces');
  const inner = traces?.querySelector<HTMLElement>('.traces-inner');
  if (traces && inner && inner.children.length > 0) {
    const toolBlocks = inner.querySelectorAll('.tool-block').length;
    const taskBlocks = inner.querySelectorAll('.task-block').length;
    const hasThinking = inner.querySelector('.thinking-block') !== null;
    const parts: string[] = [];
    if (hasThinking) parts.push('💭 reasoned');
    if (toolBlocks > 0) parts.push(`🛠️ ${toolBlocks} tool${toolBlocks > 1 ? 's' : ''}`);
    if (taskBlocks > 0) parts.push(`🤖 ${taskBlocks} task${taskBlocks > 1 ? 's' : ''}`);
    // Context delta: how much did context grow this turn?
    const endCtx = usage.contextTokens ?? 0;
    if (endCtx > 0 && turnStartCtx >= 0) {
      const delta = endCtx - turnStartCtx;
      const sign = delta >= 0 ? '+' : '';
      const deltaK = Math.abs(delta) >= 1000 ? `${sign}${(delta / 1000).toFixed(1)}k` : `${sign}${delta}`;
      parts.push(`${deltaK} ctx`);
    }
    const summaryLabel = parts.join(' · ');

    const summary = document.createElement('button');
    summary.className = 'traces-summary';
    summary.innerHTML = `<span class="traces-summary-label">${summaryLabel}</span><span class="traces-summary-chevron">▸</span>`;
    summary.addEventListener('click', () => {
      traces.classList.toggle('expanded');
    });
    traces.insertBefore(summary, inner);
    traces.classList.add('collapsible');
  }

  const labelEl = streamEl.querySelector('.role-label');
  if (labelEl) {
    // Remove the temporary streaming stop button only when TTS isn't playing.
    // If TTS is still playing, keep it visible — ttsDrainQueue will remove it when done.
    if (!ttsChunkPlaying) {
      streamTtsBtn?.remove();
      streamTtsBtn = null;
    }
    if (elapsed !== undefined) {
      const elapsedEl = document.createElement('span');
      elapsedEl.className = 'elapsed';
      elapsedEl.textContent = `${elapsed.toFixed(1)}s`;
      labelEl.appendChild(elapsedEl);
    }
    const speakContent = extractSpeakContent(fullContent);
    labelEl.appendChild(createTTSBtn(speakContent ?? fullContent));
    if (speakContent) labelEl.appendChild(createSpeakPreviewBtn(speakContent));
  }
  scrollToBottom();
}

function appendThinkingToStream(): void {
  if (!streamEl) return;
  const traces = streamEl.querySelector<HTMLElement>('.message-traces');
  if (!traces) return;
  const inner = traces.querySelector<HTMLElement>('.traces-inner') ?? traces;
  const block = document.createElement('div');
  block.className = 'thinking-block running';
  const toggle = document.createElement('button');
  toggle.className = 'thinking-toggle';
  toggle.innerHTML = '<span class="thinking-anim"><span></span><span></span><span></span></span>Reasoning…';
  const body = document.createElement('div');
  body.className = 'thinking-body hidden';
  toggle.addEventListener('click', () => {
    body.classList.toggle('hidden');
    block.classList.toggle('expanded');
  });
  block.appendChild(toggle);
  block.appendChild(body);
  inner.appendChild(block);
  streamThinkingEl = block;
  scrollToBottom();
}

function finalizeThinkingBlock(): void {
  if (!streamThinkingEl) return;
  streamThinkingEl.classList.remove('running');
  streamThinkingEl.classList.add('done');
  const toggle = streamThinkingEl.querySelector<HTMLElement>('.thinking-toggle');
  if (toggle) {
    toggle.innerHTML = '💭 Reasoned <span class="trace-expand-hint">▸</span>';
  }
  streamThinkingEl = null;
  streamThinkingText = '';
}

function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('view') || n.includes('cat')) return '📄';
  if (n.includes('write') || n.includes('create') || n.includes('save')) return '✏️';
  if (n.includes('edit') || n.includes('patch') || n.includes('replace')) return '🔧';
  if (n.includes('exec') || n.includes('run') || n.includes('bash') || n.includes('shell')) return '⚡';
  if (n.includes('search') || n.includes('grep') || n.includes('find') || n.includes('glob')) return '🔍';
  if (n.includes('fetch') || n.includes('http') || n.includes('web') || n.includes('url')) return '🌐';
  if (n.includes('list') || n.includes('ls') || n.includes('dir')) return '📂';
  if (n.includes('delete') || n.includes('remove') || n.includes('rm')) return '🗑️';
  if (n.includes('move') || n.includes('rename') || n.includes('mv')) return '📦';
  if (n.includes('git')) return '🔀';
  if (n.includes('agent') || n.includes('task') || n.includes('spawn')) return '🤖';
  if (n.includes('think') || n.includes('reason')) return '💭';
  return '🛠️';
}

function prettyToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function appendToolToStream(name: string, summary: string, inputStr: string): void {
  if (!streamEl) return;
  const traces = streamEl.querySelector<HTMLElement>('.message-traces');
  if (!traces) return;

  // During streaming append to .traces-inner if it exists, otherwise directly to traces
  const inner = traces.querySelector<HTMLElement>('.traces-inner') ?? traces;

  const isTask = name === 'dispatch_task';
  const block = document.createElement('div');
  block.className = isTask ? 'task-block running' : 'tool-block running';

  const header = document.createElement('button');
  header.className = 'tool-header';

  const iconEl = document.createElement('span');
  iconEl.className = 'tool-icon';
  iconEl.textContent = toolIcon(name);

  const statusIcon = document.createElement('span');
  statusIcon.className = 'tool-status-icon';
  statusIcon.innerHTML = '<span class="tool-mini-spinner"></span>';

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = prettyToolName(name);

  header.appendChild(iconEl);
  header.appendChild(statusIcon);
  header.appendChild(nameEl);

  if (summary && summary !== name) {
    const summaryEl = document.createElement('span');
    summaryEl.className = 'tool-summary';
    summaryEl.textContent = summary;
    header.appendChild(summaryEl);
  }

  const expandHint = document.createElement('span');
  expandHint.className = 'trace-expand-hint';
  expandHint.textContent = '▸';
  header.appendChild(expandHint);

  const body = document.createElement('div');
  body.className = 'tool-body hidden';

  if (inputStr) {
    const inputPre = document.createElement('pre');
    inputPre.className = 'tool-input';
    try { inputPre.textContent = JSON.stringify(JSON.parse(inputStr), null, 2); }
    catch { inputPre.textContent = inputStr; }
    body.appendChild(inputPre);
  }

  header.addEventListener('click', () => {
    body.classList.toggle('hidden');
    block.classList.toggle('expanded');
  });

  block.appendChild(header);
  block.appendChild(body);
  inner.appendChild(block);
  currentToolEl = block;
  scrollToBottom();
}

function finalizeToolBlock(block: HTMLElement, output: string): void {
  block.classList.remove('running');
  block.classList.add('done');
  const statusIcon = block.querySelector('.tool-status-icon');
  if (statusIcon) statusIcon.innerHTML = '<span class="tool-checkmark">\u2713</span>';
  if (output.trim()) {
    const body = block.querySelector<HTMLElement>('.tool-body');
    if (body) {
      const outputPre = document.createElement('pre');
      outputPre.className = 'tool-output';
      outputPre.textContent = output.length > 2000 ? output.slice(0, 2000) + '\n\u2026 (truncated)' : output;
      body.appendChild(outputPre);
    }
  }
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
  renderMounts();

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

  // TTS auto-speak toggle
  $sbTtsToggle.textContent = ttsAutoSpeak ? 'ON' : 'OFF';
  $sbTtsToggle.classList.toggle('on', ttsAutoSpeak);

  // Concise mode toggle
  $sbConciseToggle.textContent = conciseMode ? 'ON' : 'OFF';
  $sbConciseToggle.classList.toggle('on', conciseMode);

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
      const isUserPullDone = t.delivery === 'user-pull' && (t.status === 'completed' || t.status === 'failed') && t.result;
      item.className = 'task-item' + (isUserPullDone ? ' task-item-pull' : '');
      if (isUserPullDone) item.title = 'Click to view result';

      const status = document.createElement('span');
      status.className = `task-status ${t.status}`;
      status.textContent = t.status === 'running' ? '\u25B6' : t.status === 'completed' ? '\u2713' : t.status === 'cancelled' ? '\u2014' : '\u2717';
      status.title = t.status;
      item.appendChild(status);

      const desc = document.createElement('span');
      desc.className = 'task-desc';
      desc.textContent = t.description;
      desc.title = t.description;
      item.appendChild(desc);

      // Per-task usage: model + tokens + cost (shown after completion)
      if (t.model || t.inputTokens !== undefined || t.cost !== undefined) {
        const meta = document.createElement('div');
        meta.className = 'task-meta';

        const parts: string[] = [];
        if (t.model) parts.push(modelDisplayName(t.model));
        if (t.inputTokens !== undefined || t.outputTokens !== undefined) {
          const tok = ((t.inputTokens ?? 0) + (t.outputTokens ?? 0)).toLocaleString();
          parts.push(`${tok} tok`);
        }
        if (t.cost !== undefined && t.cost > 0) {
          parts.push(t.cost < 0.01 ? `$${t.cost.toFixed(3)}` : `$${t.cost.toFixed(2)}`);
        }

        meta.textContent = parts.join(' · ');
        item.appendChild(meta);
      }

      if (isUserPullDone) {
        item.addEventListener('click', () => openTaskResultPanel(t));
      }

      $sbTasksList.appendChild(item);
    }
  }
}

// ── Task result panel (user-pull) ────────────────────────────

let $taskPanel: HTMLElement | null = null;

function ensureTaskPanel(): HTMLElement {
  if ($taskPanel) return $taskPanel;
  const panel = document.createElement('div');
  panel.id = 'task-result-panel';
  panel.className = 'task-result-panel hidden';
  panel.innerHTML = `
    <div class="task-result-header">
      <span class="task-result-title"></span>
      <button class="task-result-close" title="Close">\u2715</button>
    </div>
    <pre class="task-result-body"></pre>
    <div class="task-result-footer">
      <button class="task-result-discuss">Discuss with agent</button>
    </div>
  `;
  document.body.appendChild(panel);
  $taskPanel = panel;

  panel.querySelector('.task-result-close')!.addEventListener('click', closeTaskResultPanel);
  return panel;
}

function openTaskResultPanel(t: BackgroundTaskInfo): void {
  const panel = ensureTaskPanel();
  panel.querySelector<HTMLElement>('.task-result-title')!.textContent = t.description;
  panel.querySelector<HTMLElement>('.task-result-body')!.textContent = t.result ?? '';

  const discuss = panel.querySelector<HTMLButtonElement>('.task-result-discuss')!;
  discuss.onclick = () => {
    closeTaskResultPanel();
    const prompt = [
      `Let's discuss the result of the background task: "${t.description}"`,
      '',
      t.result ?? '',
    ].join('\n');
    wsSend({ type: 'message', content: prompt });
  };

  panel.classList.remove('hidden');
}

function closeTaskResultPanel(): void {
  $taskPanel?.classList.add('hidden');
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
  const showCancel = isLoading || ttsChunkPlaying;
  $send.classList.toggle('hidden', showCancel);
  $cancel.classList.toggle('hidden', !showCancel);
  document.body.toggleAttribute('data-working', isLoading);
  if (micRecording) {
    $input.placeholder = 'Listening\u2026';
  } else {
    $input.placeholder = isLoading ? 'Agent is working\u2026' : 'Message aigent\u2026';
  }
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

// ── Mount timer helpers ───────────────────────────────────────

function fmtRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const secs = Math.round(ms / 1000);
  if (secs <= 60) return `${secs} sec`;
  const mins = ms / 60_000;
  const rounded = Math.round(mins * 2) / 2; // 0.5 min precision
  return `${rounded} min`;
}

function renderMounts(): void {
  if (mountsList.length === 0) {
    $sbMountsList.textContent = 'none';
    return;
  }
  $sbMountsList.innerHTML = '';
  for (const m of mountsList) {
    const item = document.createElement('div');
    item.className = 'mount-item';

    const row = document.createElement('div');
    row.className = 'mount-item-row';

    const mode = document.createElement('span');
    mode.className = `mount-mode ${m.mode}`;
    mode.textContent = m.mode;
    row.appendChild(mode);

    const path = document.createElement('span');
    path.className = 'mount-path';
    path.title = m.hostPath;
    const parts = m.hostPath.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length >= 2) {
      const parent = document.createElement('span');
      parent.className = 'mount-path-parent';
      parent.textContent = parts[parts.length - 2] + '/';
      const name = document.createElement('span');
      name.textContent = parts[parts.length - 1]!;
      path.appendChild(parent);
      path.appendChild(name);
    } else {
      path.textContent = m.hostPath;
    }
    row.appendChild(path);

    if (m.expiresAt) {
      const remaining = m.expiresAt - Date.now();
      const badge = document.createElement('span');
      badge.className = 'mount-expiry-badge';
      badge.textContent = fmtRemaining(remaining);
      badge.title = `Expires at ${new Date(m.expiresAt).toLocaleTimeString()}`;
      row.appendChild(badge);
    }

    item.appendChild(row);

    if (m.expiresAt && m.durationMinutes) {
      const totalMs = m.durationMinutes * 60_000;
      const remaining = Math.max(0, m.expiresAt - Date.now());
      const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));

      const bar = document.createElement('div');
      bar.className = 'mount-timer-bar';
      bar.setAttribute('data-expires-at', String(m.expiresAt));
      bar.setAttribute('data-duration-ms', String(totalMs));

      const fill = document.createElement('div');
      fill.className = 'mount-timer-fill';
      fill.style.width = `${pct}%`;
      bar.appendChild(fill);
      item.appendChild(bar);
    }

    $sbMountsList.appendChild(item);
  }
}

// Refresh expiry countdowns every 5 seconds without a full sidebar re-render
setInterval(() => {
  const now = Date.now();
  const badges = $sbMountsList.querySelectorAll<HTMLElement>('.mount-expiry-badge');
  const bars = $sbMountsList.querySelectorAll<HTMLElement>('.mount-timer-bar');

  badges.forEach((badge) => {
    const item = badge.closest('.mount-item');
    const bar = item?.querySelector<HTMLElement>('.mount-timer-bar');
    const expiresAt = bar ? Number(bar.getAttribute('data-expires-at')) : 0;
    if (!expiresAt) return;
    const remaining = expiresAt - now;
    badge.textContent = fmtRemaining(remaining);
  });

  bars.forEach((bar) => {
    const expiresAt = Number(bar.getAttribute('data-expires-at'));
    const totalMs = Number(bar.getAttribute('data-duration-ms'));
    if (!expiresAt || !totalMs) return;
    const remaining = Math.max(0, expiresAt - now);
    const pct = Math.max(0, Math.min(100, (remaining / totalMs) * 100));
    const fill = bar.querySelector<HTMLElement>('.mount-timer-fill');
    if (fill) fill.style.width = `${pct}%`;
  });
}, 5_000);

// ── Permission request modal ─────────────────────────────────

function playMicSound(type: 'start' | 'stop'): void {
  try {
    const ctx = new AudioContext();
    const freqs = type === 'start' ? [880, 1320] : [1320, 880];
    freqs.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.1;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.15, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.start(t);
      osc.stop(t + 0.12);
    });
    setTimeout(() => void ctx.close(), 500);
  } catch {
    // Audio unavailable
  }
}

function playPermissionSound(): void {
  try {
    const ctx = new AudioContext();
    ([523.25, 659.25, 783.99] as number[]).forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.22);
    });
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    // Audio unavailable
  }
}

function sendPermNotification(req: PermRequest): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!document.hidden) return; // Tab is focused — modal is already visible
  const n = new Notification('aigent: Permission Request', {
    body: `${req.title}: ${req.detail.split('\n')[0]}`,
    requireInteraction: true,
  });
  n.onclick = () => { window.focus(); n.close(); };
}

// ── Diff parsing helpers ─────────────────────────────────────

/** Split a unified diff into per-file sections for tab navigation. */
function parseDiffIntoFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  // Split on "--- a/" boundaries (each file section starts here)
  const sections = diff.split(/(?=^--- a\/)/m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const pathMatch = section.match(/^\+\+\+ b\/(.+)$/m);
    if (!pathMatch) continue;
    const path = pathMatch[1]!.trim();
    const name = path.split('/').pop() ?? path;
    files.push({ name, path, content: section });
  }
  return files.length > 0 ? files : [{ name: 'patch', path: '', content: diff }];
}

/** Render a diff string as a VS Code / GitHub-style table with line numbers. */
function renderDiffContent(container: HTMLElement, diffText: string): void {
  container.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'diff-table';

  let oldLine = 0;
  let newLine = 0;

  for (const line of diffText.split('\n')) {
    // Skip trailing empty line from the final split
    if (line === '' && diffText.endsWith('\n') && line === diffText.split('\n').at(-1)) continue;

    const tr = document.createElement('tr');

    if (line.startsWith('@@')) {
      // Hunk header — parse @@ -old,count +new,count @@
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) { oldLine = parseInt(m[1]!, 10) - 1; newLine = parseInt(m[2]!, 10) - 1; }
      tr.className = 'diff-hunk';
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = line;
      tr.appendChild(td);
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      tr.className = 'diff-header';
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = line;
      tr.appendChild(td);
    } else if (line.startsWith('-')) {
      oldLine++;
      tr.className = 'diff-remove';
      appendDiffCells(tr, String(oldLine), '', '-', line.slice(1));
    } else if (line.startsWith('+')) {
      newLine++;
      tr.className = 'diff-add';
      appendDiffCells(tr, '', String(newLine), '+', line.slice(1));
    } else {
      // Context line
      oldLine++;
      newLine++;
      appendDiffCells(tr, String(oldLine), String(newLine), '', line.slice(1));
    }

    table.appendChild(tr);
  }

  container.appendChild(table);
}

function appendDiffCells(tr: HTMLTableRowElement, oldN: string, newN: string, marker: string, code: string): void {
  const tdOld = document.createElement('td');
  tdOld.className = 'diff-ln diff-ln-old';
  tdOld.textContent = oldN;

  const tdNew = document.createElement('td');
  tdNew.className = 'diff-ln diff-ln-new';
  tdNew.textContent = newN;

  const tdMark = document.createElement('td');
  tdMark.className = 'diff-mark';
  tdMark.textContent = marker;

  const tdCode = document.createElement('td');
  tdCode.className = 'diff-code';
  tdCode.textContent = code;

  tr.appendChild(tdOld);
  tr.appendChild(tdNew);
  tr.appendChild(tdMark);
  tr.appendChild(tdCode);
}

let activeDiffFileIdx = 0;

function showDiffFile(req: PermRequest, idx: number): void {
  activeDiffFileIdx = idx;
  const files = req.diffFiles ?? [];

  // Update file list active state
  const items = $patchFileList.querySelectorAll('.patch-file-item');
  items.forEach((t, i) => t.classList.toggle('active', i === idx));

  // Render the selected file's diff content
  const fileContent = files[idx]?.content ?? req.diff ?? '';
  renderDiffContent($permDiff, fileContent);
}

function showNextPermRequest(): void {
  const req = permQueue[0];
  if (!req) {
    permShowing = false;
    $permOverlay.classList.remove('patch-mode');
    $permOverlay.classList.add('hidden');
    $patchViewer.classList.add('hidden');
    return;
  }
  permShowing = true;
  // Hide tool bar and clear its label — the perm overlay takes over
  hideTool();
  $permIcon.textContent = req.type === 'mount' ? '📂' : req.type === 'patch' ? '🩹' : '✏️';
  $permTitle.textContent = req.title;

  // Show each line of detail as its own row
  const lines = req.detail.split('\n').filter(Boolean);
  $permDetail.innerHTML = '';
  for (const line of lines) {
    const row = document.createElement('div');
    row.textContent = line;
    $permDetail.appendChild(row);
  }

  // Patch mode: full-page modal with file list sidebar + diff viewer
  if (req.type === 'patch') {
    $permOverlay.classList.add('patch-mode');

    const files = req.diffFiles ?? [];
    $patchFileList.innerHTML = '';

    files.forEach((f, i) => {
      const item = document.createElement('button');
      item.className = 'patch-file-item';
      item.title = f.path;

      const slashIdx = f.path.lastIndexOf('/');
      if (slashIdx !== -1) {
        const dir = document.createElement('div');
        dir.className = 'patch-file-dir';
        dir.textContent = f.path.slice(0, slashIdx + 1);
        const name = document.createElement('div');
        name.className = 'patch-file-name';
        name.textContent = f.path.slice(slashIdx + 1);
        item.appendChild(dir);
        item.appendChild(name);
      } else {
        const name = document.createElement('div');
        name.className = 'patch-file-name';
        name.textContent = f.path || f.name;
        item.appendChild(name);
      }

      item.addEventListener('click', () => showDiffFile(req, i));
      $patchFileList.appendChild(item);
    });

    // Show sidebar only when there are multiple files
    $patchFileList.classList.toggle('hidden', files.length <= 1);

    activeDiffFileIdx = 0;
    showDiffFile(req, 0);
    $patchViewer.classList.remove('hidden');
  } else {
    $permOverlay.classList.remove('patch-mode');
    $patchViewer.classList.add('hidden');
  }

  // Duration badge — shown when agent specifies how long it needs access
  if (req.durationMinutes) {
    $permDuration.textContent = `⏱ ${req.durationMinutes} min (auto-expires)`;
    $permDuration.classList.remove('hidden');
  } else {
    $permDuration.classList.add('hidden');
  }

  $permOverlay.classList.remove('hidden');
}

function enqueuePermRequest(req: PermRequest): void {
  permQueue.push(req);
  if (!permShowing) showNextPermRequest();
  playPermissionSound();
  sendPermNotification(req);
}

function resolvePermRequest(approve: boolean): void {
  const req = permQueue.shift();
  if (!req) return;
  wsSend({ type: 'message', content: approve ? req.approveCmd : req.denyCmd });
  showNextPermRequest();
}

$permApproveBtn.addEventListener('click', () => resolvePermRequest(true));
$permDenyBtn.addEventListener('click', () => resolvePermRequest(false));

// Request browser notification permission on first user interaction
let notifPermRequested = false;
function requestNotifPermission(): void {
  if (notifPermRequested) return;
  notifPermRequested = true;
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}
document.addEventListener('click', requestNotifPermission, { once: true });
document.addEventListener('keydown', requestNotifPermission, { once: true });

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
  // Stop mic immediately without a final transcription pass — the text
  // already in the textarea is what the user wants to send, and any
  // in-flight STT responses must not write back after we clear the input.
  if (micRecording) abortMic();
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
  // Sticky voice mode: restart mic silently after submit (no sound, seamless loop)
  if (micSticky) setTimeout(() => { void startMic(true); }, 100);
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

  // While dictating, Enter stops mic and sends once transcription is done
  if (micRecording && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void stopMic().then(() => submitMessage());
    return;
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

// ── Screen capture ────────────────────────────────────────────

const $screenCap = $('screen-cap') as HTMLButtonElement;

let screenStream: MediaStream | null = null;
let screenVideo: HTMLVideoElement | null = null;

function setScreenCapState(active: boolean): void {
  $screenCap.classList.toggle('active', active);
  $screenCap.title = active ? 'Take screenshot' : 'Share screen & take screenshot';
}

// Every click = take one screenshot.
// First click starts the stream (picker shows once); subsequent clicks are instant.
async function takeScreenshot(): Promise<void> {
  if (pendingAttachments.length >= MAX_ATTACHMENTS) return;
  try {
    // Start stream if not already running
    if (!screenStream || !screenVideo) {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenVideo = document.createElement('video');
      screenVideo.srcObject = screenStream;
      screenVideo.muted = true;
      await new Promise<void>(resolve => { screenVideo!.onloadedmetadata = () => resolve(); });
      await screenVideo.play();
      // Wait for the first real frame — avoids black captures on slow displays
      await new Promise<void>(resolve => {
        if (screenVideo!.readyState >= 3) resolve();
        else screenVideo!.oncanplay = () => resolve();
      });
      // Handle browser's native "Stop sharing" bar
      screenStream.getVideoTracks()[0].addEventListener('ended', () => {
        screenStream = null;
        screenVideo = null;
        setScreenCapState(false);
      });
      setScreenCapState(true);
    }
    // Capture current frame
    const v = screenVideo;
    if (v.videoWidth === 0 || v.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')!.drawImage(v, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    pendingAttachments.push({
      id: `att_${++attachmentIdCounter}`,
      name: 'screenshot.png',
      mediaType: 'image/png',
      data: base64,
      dataUrl,
      size: Math.round(base64.length * 0.75),
    });
    renderAttachmentPreview();
  } catch (err) {
    const name = (err as Error).name;
    if (name !== 'NotAllowedError' && name !== 'AbortError') {
      errorMsg = 'Screen capture failed';
      updateErrorBar();
    }
  }
}

$screenCap.addEventListener('click', () => void takeScreenshot());

$cancel.addEventListener('click', () => {
  ttsStopAll();
  if (isLoading) wsSend({ type: 'cancel' });
});

// ── Microphone / STT ─────────────────────────────────────────

function micLog(...args: unknown[]): void {
  console.log(...args);
  void fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level: 'log', args }) }).catch(() => {});
}

const $mic = $('mic') as HTMLButtonElement;
const $micIconMic = $mic.querySelector('.icon-mic') as SVGElement;
const $micIconStop = $mic.querySelector('.icon-stop') as SVGElement;
const $micIconSpinner = $mic.querySelector('.icon-spinner') as SVGElement;
const $micSticky = $('mic-sticky') as HTMLButtonElement;
const $micClear = $('mic-clear') as HTMLButtonElement;
const $micCapped = $('mic-capped') as HTMLSpanElement;

let micRecording = false;
let micSticky = localStorage.getItem('mic-sticky') === 'true';
let micAudioCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let micSamples: Float32Array[] = [];
let micSource: MediaStreamAudioSourceNode | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let micChunkTimer: ReturnType<typeof setInterval> | null = null;
let micSilenceTimer: ReturnType<typeof setTimeout> | null = null;
let micLastText = '';
let micReqSeq = 0;          // increments on each outgoing request
let micDisplayedSeq = 0;   // seq of the last response we actually showed
let micBaseText = '';       // text in input before mic started
let vadLoudFrames = 0;      // consecutive loud frames counter for VAD hysteresis
let vadSpeaking = false;    // true while voice is detected (for mic pulse visual)
let micLastSpeechTime = 0;  // timestamp of last detected speech (for silence detection)
let micLiveAbortCtrls: AbortController[] = []; // abort controllers for in-flight live STT requests

// Max samples to send per live chunk (12 s at 16 kHz — more context improves Whisper accuracy)
const MIC_WINDOW_SAMPLES = 16000 * 12;

function micSilenceThreshold(): number { return getClientSetting('mic_silence_threshold') as number; }
function micLoudFrames(): number       { return getClientSetting('mic_loud_frames') as number; }
function micSilenceTailMs(): number    { return getClientSetting('mic_silence_tail_ms') as number; }
function micAutoSend(): boolean        { return getClientSetting('mic_auto_send') as boolean; }
function micAutoSendMs(): number       { return getClientSetting('mic_auto_send_ms') as number; }

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

  const seq = ++micReqSeq;
  micLog('[mic] sendLiveChunk seq=', seq, 'samples=', micSamples.length);

  // Build a sliding window over the last MIC_WINDOW_SAMPLES samples
  let totalLen = 0;
  for (const s of micSamples) totalLen += s.length;
  const windowCapped = totalLen > MIC_WINDOW_SAMPLES;

  let window: Float32Array[];
  if (!windowCapped) {
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

  const ctrl = new AbortController();
  // Timeout live chunks at 5 s — if STT is slower than that, skip rather than
  // pile up concurrent slow requests that resolve after recording ends.
  const liveTimeout = setTimeout(() => ctrl.abort(), 5000);
  micLiveAbortCtrls.push(ctrl);
  try {
    const resp = await fetch('/stt', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: encodeWav(window, 16000),
      signal: ctrl.signal,
    });
    // Accept any response newer than the last one we displayed — don't
    // require it to be the absolute latest in flight.
    if (resp.ok && seq > micDisplayedSeq) {
      const { text } = await resp.json() as { text?: string };
      micLog('[mic] chunk seq=', seq, 'text=', text, 'recording=', micRecording);
      if (text) {
        micLastText = text;
        micDisplayedSeq = seq;
        // Show the capped indicator (…) as a UI overlay when the audio window is
        // sliding — tells the user earlier speech exists but isn't in this preview.
        $micCapped.classList.toggle('hidden', !windowCapped);
        $input.value = micBaseText ? micBaseText + ' ' + text : text;
        autoGrow();
        micUpdateClearButton();
      }
    } else {
      micLog('[mic] chunk seq=', seq, 'skipped: resp.ok=', resp.ok, 'displayedSeq=', micDisplayedSeq);
    }
  } catch (err) {
    micLog('[mic] chunk seq=', seq, 'error:', err);
  } finally {
    clearTimeout(liveTimeout);
    const idx = micLiveAbortCtrls.indexOf(ctrl);
    if (idx !== -1) micLiveAbortCtrls.splice(idx, 1);
  }
}

function micSetState(state: 'idle' | 'recording' | 'transcribing'): void {
  $micIconMic.classList.toggle('hidden', state !== 'idle');
  $micIconStop.classList.toggle('hidden', state !== 'recording');
  $micIconSpinner.classList.toggle('hidden', state !== 'transcribing');
  $mic.classList.toggle('recording', state === 'recording');
  $mic.classList.toggle('transcribing', state === 'transcribing');
  if (state !== 'recording') $micClear.classList.add('hidden');
}

function micUpdateClearButton(): void {
  $micClear.classList.toggle('hidden', !micRecording || !micLastText);
}

function setMicSticky(on: boolean): void {
  micSticky = on;
  localStorage.setItem('mic-sticky', String(on));
  $micSticky.classList.toggle('active', on);
}

async function startMic(silent = false): Promise<void> {
  micLog('[mic] startMic called, silent=', silent, 'sticky=', micSticky, 'recording=', micRecording);
  ttsStopAll();
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
    micBaseText = $input.value.trim();
    micLiveAbortCtrls = [];
    micProcessor.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);

      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
      const rms = Math.sqrt(sum / data.length);

      // Only accumulate frames that contain speech — silent frames are skipped
      // entirely so the buffer stays compact and Whisper sees clean audio.
      // We keep a short tail after speech ends (vadSpeaking stays true briefly)
      // to avoid cutting off the end of words.
      const silenceThresh = micSilenceThreshold();
      const loudFramesNeeded = micLoudFrames();
      const silenceTail = micSilenceTailMs();
      if (rms > silenceThresh) {
        micSamples.push(new Float32Array(data));
        if (!vadSpeaking) micLog('[mic] speech detected rms=', rms.toFixed(4));
        micLastSpeechTime = Date.now();
        // Cancel any pending auto-send timer when speech resumes.
        if (micSilenceTimer !== null) { clearTimeout(micSilenceTimer); micSilenceTimer = null; }
        // Visual pulse: require a few consecutive loud frames to avoid flicker.
        vadLoudFrames++;
        if (vadLoudFrames >= loudFramesNeeded && !vadSpeaking) {
          vadSpeaking = true;
          $mic.classList.add('vad-active');
          if (micSticky) $micSticky.classList.add('vad-active');
        }
      } else {
        // Keep a short tail of silence after speech so words don't get clipped.
        if (vadSpeaking) micSamples.push(new Float32Array(data));
        vadLoudFrames = 0;
        if (vadSpeaking && Date.now() - micLastSpeechTime > silenceTail) {
          vadSpeaking = false;
          $mic.classList.remove('vad-active');
          $micSticky.classList.remove('vad-active');
        }
        // Auto-send on silence: in sticky mode, schedule a submit after the
        // configured silence duration. Only arm the timer once (when null).
        if (micSticky && micAutoSend() && micLastText && micSilenceTimer === null) {
          micSilenceTimer = setTimeout(() => {
            micSilenceTimer = null;
            if (micSticky && micRecording && micLastText) {
              micLog('[mic] auto-send triggered after silence');
              void stopMic(false).then(() => { submitMessage(); });
            }
          }, micAutoSendMs());
        }
      }

      // Barge-in: stop TTS when clear speech detected (higher threshold, more hysteresis).
      if ((ttsChunkPlaying || ttsAudio) && rms > 0.05) {
        ttsStopAll();
      }
    };
    micSource.connect(micProcessor);
    micProcessor.connect(micAudioCtx.destination);

    micLastSpeechTime = Date.now();

    // Send first chunk after a short delay (let audio accumulate), then every 1.2 s.
    // Requests run concurrently; the seq counter ensures only the latest wins.
    setTimeout(() => { void sendLiveChunk(); }, 800);
    micChunkTimer = setInterval(() => { void sendLiveChunk(); }, 1200);

    micRecording = true;
    micSetState('recording');
    updateInputState();
    $input.focus();
    if (!silent) playMicSound('start');
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'NotAllowedError') {
      errorMsg = 'Microphone access denied — please allow it in your browser settings.';
    } else {
      errorMsg = 'Microphone unavailable.';
    }
    updateErrorBar();
    if (micSticky) setMicSticky(false);
  }
}

async function stopMic(silent = false): Promise<void> {
  micLog('[mic] stopMic called, silent=', silent, 'sticky=', micSticky, 'lastText=', micLastText);
  if (!micRecording) return;
  micRecording = false;
  vadSpeaking = false;
  vadLoudFrames = 0;
  $mic.classList.remove('vad-active');
  $micSticky.classList.remove('vad-active');
  if (!silent) playMicSound('stop');

  // Stop timers and abort all in-flight live STT requests
  if (micChunkTimer !== null) { clearInterval(micChunkTimer); micChunkTimer = null; }
  if (micSilenceTimer !== null) { clearTimeout(micSilenceTimer); micSilenceTimer = null; }
  for (const c of micLiveAbortCtrls) c.abort();
  micLiveAbortCtrls = [];

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

  if (samples.length === 0) { micSetState('idle'); updateInputState(); return; }

  let finalText = micLastText;
  try {
    // No client-side timeout for the final call — the full recording may be long
    // and Whisper may need several seconds to process it. Live chunks use a 5 s cap
    // to stay responsive, but the final pass just waits as long as it takes.
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

  $micCapped.classList.add('hidden');
  if (finalText) {
    $input.value = micBaseText ? micBaseText + ' ' + finalText : finalText;
    autoGrow();
    $input.focus();
  } else {
    // No transcript — restore whatever was in the box before
    $input.value = micBaseText;
    autoGrow();
  }
  micLog('[mic] stopMic done, finalText=', finalText, 'sticky=', micSticky);
  micSetState('idle');
  updateInputState();
}


function abortMic(): void {
  if (!micRecording) return;
  micRecording = false;
  vadSpeaking = false;
  vadLoudFrames = 0;
  $mic.classList.remove('vad-active');
  $micSticky.classList.remove('vad-active');
  $micCapped.classList.add('hidden');
  if (micChunkTimer !== null) { clearInterval(micChunkTimer); micChunkTimer = null; }
  if (micSilenceTimer !== null) { clearTimeout(micSilenceTimer); micSilenceTimer = null; }
  // Abort and invalidate any in-flight live STT requests
  for (const c of micLiveAbortCtrls) c.abort();
  micLiveAbortCtrls = [];
  micDisplayedSeq = micReqSeq;
  micSource?.disconnect();
  micProcessor?.disconnect();
  micStream?.getTracks().forEach(t => t.stop());
  void micAudioCtx?.close();
  micSamples = [];
  micSource = null;
  micProcessor = null;
  micStream = null;
  micAudioCtx = null;
  micSetState('idle');
  updateInputState();
}

$mic.addEventListener('click', () => {
  if (micRecording) { setMicSticky(false); void stopMic(); }
  else void startMic();
  $input.focus();
});

$micSticky.addEventListener('click', () => {
  const wasSticky = micSticky;
  setMicSticky(!micSticky);
  if (micSticky && !micRecording) void startMic();       // turned on → start
  else if (wasSticky && !micSticky && micRecording) void stopMic(); // turned off → stop
  $input.focus();
});

$micClear.addEventListener('click', () => {
  // Reset the transcription buffer — keep mic recording, just wipe the preview text
  for (const c of micLiveAbortCtrls) c.abort();
  micLiveAbortCtrls = [];
  micSamples = [];
  micLastText = '';
  micReqSeq = 0;
  micDisplayedSeq = 0;
  $micCapped.classList.add('hidden');
  $input.value = micBaseText;
  autoGrow();
  micUpdateClearButton();
  $input.focus();
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
  // Ctrl+Shift+` = toggle always-on mic (sticky) mode
  // Use e.code to handle Shift changing the reported key (` → ~)
  if (e.code === 'Backquote' && e.ctrlKey && e.shiftKey) {
    e.preventDefault();
    const wasSticky = micSticky;
    setMicSticky(!micSticky);
    if (micSticky && !micRecording) void startMic();
    else if (wasSticky && !micSticky && micRecording) void stopMic();
    return;
  }
  // Ctrl+` = toggle mic (global)
  if (e.code === 'Backquote' && e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    if (micRecording) { setMicSticky(false); void stopMic(); }
    else void startMic();
    return;
  }
  // ` or M when input not focused = mic toggle (local shortcut)
  const inputFocused = document.activeElement === $input;
  if (!inputFocused && (e.code === 'Backquote' || e.key === 'm' || e.key === 'M')) {
    e.preventDefault();
    if (micRecording) { setMicSticky(false); void stopMic(); }
    else void startMic();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === 'Control') updateSendButton(false);
});
// Reset if window loses focus while Ctrl is held
window.addEventListener('blur', () => updateSendButton(false));

// ── Sidebar TTS controls ─────────────────────────────────────

$sbTtsToggle.addEventListener('click', () => {
  ttsAutoSpeak = !ttsAutoSpeak;
  localStorage.setItem('tts-auto-speak', String(ttsAutoSpeak));
  updateSidebar();
});

$sbTtsRate.addEventListener('input', () => {
  ttsRatePct = Number($sbTtsRate.value);
  localStorage.setItem('tts-rate-pct', String(ttsRatePct));
  $sbTtsRateLabel.textContent = ttsRatePct >= 0 ? `+${ttsRatePct}%` : `${ttsRatePct}%`;
});

// ── Sidebar concise toggle ────────────────────────────────────

$sbConciseToggle.addEventListener('click', () => {
  const cmd = conciseMode ? '/concise off' : '/concise on';
  wsSend({ type: 'message', content: cmd });
});

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

// ── Settings modal ───────────────────────────────────────────

function formatSettingValue(def: SettingDef, value: boolean | number | string): string {
  if (def.type === 'number') {
    return `${Number(value)}${def.unit ?? ''}`;
  }
  return String(value);
}

function getEffectiveValue(def: SettingDef): boolean | number | string {
  // Pending edit takes priority, then server-reported value, then default
  if (def.key in serverSettingsPending) return serverSettingsPending[def.key]!;
  if (def.key in serverSettings) return serverSettings[def.key]!;
  return def.default;
}

function buildControl(def: SettingDef, currentValue: boolean | number | string, onChange: (v: boolean | number | string) => void): HTMLElement {
  const ctrl = document.createElement('div');
  ctrl.className = 'settings-row-control';

  if (def.type === 'toggle') {
    const label = document.createElement('label');
    label.className = 'settings-toggle';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = currentValue as boolean;
    input.addEventListener('change', () => onChange(input.checked));
    const track = document.createElement('span');
    track.className = 'settings-toggle-track';
    label.appendChild(input);
    label.appendChild(track);
    ctrl.appendChild(label);

  } else if (def.type === 'select') {
    const sel = document.createElement('select');
    sel.className = 'settings-select';
    for (const opt of def.options ?? []) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === String(currentValue)) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => onChange(sel.value));
    ctrl.appendChild(sel);

  } else if (def.type === 'number') {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'settings-number';
    input.value = String(currentValue);
    if (def.min !== undefined) input.min = String(def.min);
    if (def.max !== undefined) input.max = String(def.max);
    if (def.step !== undefined) input.step = String(def.step);
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!isNaN(v)) onChange(v);
    });
    ctrl.appendChild(input);
    if (def.unit) {
      const unitSpan = document.createElement('span');
      unitSpan.textContent = def.unit;
      unitSpan.style.cssText = 'font-size:12px;color:var(--text-dim);margin-left:4px';
      ctrl.appendChild(unitSpan);
    }

  } else if (def.type === 'text' || def.type === 'password') {
    const input = document.createElement('input');
    input.type = def.type === 'password' ? 'password' : 'text';
    input.className = 'settings-text';
    input.value = String(currentValue === def.default && currentValue === '' ? '' : currentValue);
    if (def.placeholder) input.placeholder = def.placeholder;
    input.addEventListener('change', () => onChange(input.value));
    ctrl.appendChild(input);
  }

  return ctrl;
}

function renderSettingsModal(): void {
  $settingsNav.innerHTML = '';
  $settingsBody.innerHTML = '';
  serverSettingsPending = {}; // reset any stale pending state

  // Group defs by group name preserving order
  const groups: Map<string, SettingDef[]> = new Map();
  for (const def of SETTINGS_SCHEMA) {
    if (!groups.has(def.group)) groups.set(def.group, []);
    groups.get(def.group)!.push(def);
  }

  // Build a pane for each group (hidden by default)
  const panes: Map<string, HTMLElement> = new Map();
  for (const [groupName, defs] of groups) {
    const pane = document.createElement('div');
    pane.className = 'settings-group hidden';

    const labelEl = document.createElement('div');
    labelEl.className = 'settings-group-label';
    labelEl.textContent = groupName;
    pane.appendChild(labelEl);

    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'settings-row';

      const labelWrap = document.createElement('div');
      labelWrap.className = 'settings-row-label';
      const labelText = document.createElement('div');
      labelText.className = 'label-text';
      labelText.textContent = def.label;
      labelWrap.appendChild(labelText);
      if (def.desc) {
        const descEl = document.createElement('div');
        descEl.className = 'label-desc';
        descEl.textContent = def.desc;
        labelWrap.appendChild(descEl);
      }
      row.appendChild(labelWrap);

      const currentValue = def.scope === 'client' ? getClientSetting(def.key) : getEffectiveValue(def);
      const ctrl = buildControl(def, currentValue, (v) => {
        if (def.scope === 'client') {
          setClientSetting(def.key, v); // auto-saves + shows toast
        } else {
          // API keys: write directly to .env via /set-env command
          serverSettingsPending[def.key] = v;
          wsSend({ type: 'message', content: `/set-env ${JSON.stringify({ [def.key]: v })}` });
          Object.assign(serverSettings, { [def.key]: v });
          saveServerSettingsCache(serverSettings);
          serverSettingsPending = {};
          showSettingsToast();
        }
      });
      row.appendChild(ctrl);
      pane.appendChild(row);
    }

    panes.set(groupName, pane);
    $settingsBody.appendChild(pane);
  }

  // Build nav items and wire up group switching
  const groupNames = [...groups.keys()];
  let activeGroup = groupNames[0] ?? '';

  function showGroup(name: string): void {
    activeGroup = name;
    for (const [g, pane] of panes) {
      pane.classList.toggle('hidden', g !== name);
    }
    for (const btn of $settingsNav.querySelectorAll('.settings-nav-item')) {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.group === name);
    }
  }

  for (const name of groupNames) {
    const btn = document.createElement('button');
    btn.className = 'settings-nav-item';
    btn.textContent = name;
    btn.dataset.group = name;
    btn.addEventListener('click', () => showGroup(name));
    $settingsNav.appendChild(btn);
  }

  showGroup(activeGroup);
}

function openSettings(): void {
  renderSettingsModal();
  $settingsOverlay.classList.remove('hidden');
}

function closeSettings(): void {
  $settingsOverlay.classList.add('hidden');
}

$settingsBtn.addEventListener('click', openSettings);
$settingsClose.addEventListener('click', closeSettings);

$settingsOverlay.addEventListener('click', (e) => {
  if (e.target === $settingsOverlay) closeSettings();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$settingsOverlay.classList.contains('hidden')) {
    closeSettings();
  }
});

// ── Initialize ───────────────────────────────────────────────

// Restore persisted TTS slider state
$sbTtsRate.value = String(ttsRatePct);
$sbTtsRateLabel.textContent = ttsRatePct >= 0 ? `+${ttsRatePct}%` : `${ttsRatePct}%`;

// Restore sticky mic visual + start mic if it was active
if (micSticky) {
  $micSticky.classList.add('active');
  void startMic();
}

updateHeader();
updateSidebar();
updateInputState();
connect();
$input.focus();
