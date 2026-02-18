/**
 * AnsiTUI — Raw ANSI terminal UI with DECSTBM scroll regions.
 *
 * Replaces Ink-based rendering to eliminate re-render bleeding artifacts.
 * Uses hardware scroll regions (DECSTBM) to physically isolate the chat
 * area from the input box. Content in the scroll region CANNOT bleed
 * into the input box, and vice versa.
 *
 * Layout:
 *   Rows 1 to chatBot: Chat scroll region — messages + streaming scroll naturally
 *   Rows boxTop to end: Input box (dynamic height) — status, activity, input lines
 */

import chalk from 'chalk';
import type { AgentClient } from '../client.js';
import type {
  TokenUsage, BackgroundTaskInfo, DisplayMessage, ServerState,
} from '../protocol.js';
import type { ThinkingLevel } from '../agent.js';
import { renderMarkdown } from './Markdown.js';

// ── ANSI escape sequences ────────────────────────────────────────

const ESC = '\x1b';
const CSI = `${ESC}[`;

const moveTo = (r: number, c: number): string => `${CSI}${r};${c}H`;
const clearLine = `${CSI}2K`;
const showCursor = `${CSI}?25h`;
const hideCursor = `${CSI}?25l`;
const saveCursor = `${CSI}s`;
const restoreCursor = `${CSI}u`;
const setScrollRegion = (top: number, bot: number): string => `${CSI}${top};${bot}r`;
const resetScrollRegion = `${CSI}r`;
const clearScreen = `${CSI}2J${CSI}H`;

// Synchronized output (DEC 2026) — batch writes to prevent flicker
const syncStart = `${CSI}?2026h`;
const syncEnd = `${CSI}?2026l`;

// ── Utility functions ────────────────────────────────────────────

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z~]|\x1b\][^\x07]*\x07/g;

/** Visible length of a string (ignoring ANSI escape codes). */
function vis(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

/** Format token count for display. */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Render a context bar: ████░░░░ */
function ctxBar(used: number, total: number, w: number): string {
  const pct = Math.min(1, used / total);
  const filled = Math.round(pct * w);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(w - filled);
}

/** Hard-wrap text (ANSI-aware) to a maximum visible width. */
function hardWrap(text: string, width: number): string[] {
  const result: string[] = [];
  for (const line of text.split('\n')) {
    if (vis(line) <= width) { result.push(line); continue; }
    let cur = '', curVis = 0;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\x1b') {
        const m = line.slice(i).match(/^\x1b\[[0-9;?]*[A-Za-z~]/);
        if (m) { cur += m[0]; i += m[0].length - 1; continue; }
      }
      cur += line[i];
      curVis++;
      if (curVis >= width) { result.push(cur); cur = ''; curVis = 0; }
    }
    if (cur) result.push(cur);
  }
  return result;
}

function wordBoundL(t: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos - 1;
  while (i > 0 && /\s/.test(t[i]!)) i--;
  while (i > 0 && !/\s/.test(t[i - 1]!)) i--;
  return i;
}

function wordBoundR(t: string, pos: number): number {
  if (pos >= t.length) return t.length;
  let i = pos;
  while (i < t.length && !/\s/.test(t[i]!)) i++;
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i;
}

// ── Command registry (single source of truth) ───────────────

interface CommandDef {
  name: string;        // e.g., '/reset'
  desc: string;        // brief description shown in palette
  argHint?: string;    // e.g., '<path> [ro|rw]'
}

const COMMAND_REGISTRY: CommandDef[] = [
  { name: '/help',      desc: 'Show available commands' },
  { name: '/reset',     desc: 'Clear conversation' },
  { name: '/compact',   desc: 'Compact context' },
  { name: '/refresh',   desc: 'Reload workspace files' },
  { name: '/restart',   desc: 'Restart server' },
  { name: '/reasoning', desc: 'Toggle reasoning',          argHint: 'on|off' },
  { name: '/effort',    desc: 'Set effort level',          argHint: 'low|medium|high|max' },
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

// ── AnsiTUI ──────────────────────────────────────────────────────

export class AnsiTUI {
  private client: AgentClient;
  private rows = process.stdout.rows ?? 24;
  private cols = process.stdout.columns ?? 80;

  // Chat state
  private messages: { role: string; content: string; elapsed?: number | undefined }[] = [];

  // Input state
  private input = '';
  private cursor = 0;
  private inputVScroll = 0; // vertical scroll offset (first visible visual line)

  // Agent state
  private loading = false;
  private isThinking = false;
  private tools: { name: string; summary: string }[] = [];
  private tasks: BackgroundTaskInfo[] = [];
  private err: string | null = null;
  private usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private thinkLevel: ThinkingLevel = 'high';
  private connStatus: 'connecting' | 'connected' | 'reconnecting' = 'connecting';
  private everConnected = false;

  // Streaming in chat area
  private streamText = '';       // Full accumulated streaming text
  private streamFlushedTo = 0;   // How much has been written to the chat area
  private streamActive = false;  // Whether we're in an active streaming response

  // Spinner / elapsed timer (safe now — DECSTBM isolates the input box)
  private static SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private loadingStartedAt: number | null = null;

  // Rainbow border animation
  private borderPhase = 0;
  private borderTimer: ReturnType<typeof setInterval> | null = null;

  // Ctrl+C double-tap state
  private ctrlCArmed = false;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  // Command palette state
  private paletteItems: CommandDef[] = [];
  private paletteSelected = 0;
  private palettePrevCount = 0;

  // Bracket paste state
  private pasting = false;
  private pasteBuf = '';

  // Exit promise
  private exitResolve: (() => void) | null = null;

  /** Fixed number of visible input lines. Box height never changes between resizes,
   *  so the DECSTBM scroll region boundary is immutable and can never leak. */
  private static readonly INPUT_LINES = 1;

  /** Total height of the input box — CONSTANT between resizes. */
  private get boxHeight(): number { return 2 + AnsiTUI.INPUT_LINES; } // border + fixed input + border

  /** Usable character width for input text. */
  private get inputTextWidth(): number { return Math.max(10, this.cols - 6); } // "│ > " (4) + " │" (2)

  /** Bottom row of the chat scroll region. */
  private get chatBot(): number { return this.rows - this.boxHeight; }
  /** First row of the input box. */
  private get boxTop(): number { return this.chatBot + 1; }

  constructor(client: AgentClient) {
    this.client = client;
  }

  // ── Input visual line helpers ──────────────────────────────

  /** Split input into visual (wrapped) lines. */
  private getInputVisualLines(): string[] {
    const w = this.inputTextWidth;
    if (!this.input) return [''];
    const result: string[] = [];
    for (const line of this.input.split('\n')) {
      if (!line) { result.push(''); continue; }
      for (let i = 0; i < line.length; i += w) {
        result.push(line.slice(i, i + w));
      }
    }
    return result.length ? result : [''];
  }

  /** Map text cursor to { visualLine, column }. */
  private cursorToVisual(): { line: number; col: number } {
    const w = this.inputTextWidth;
    let pos = 0;
    let vLine = 0;
    for (const logical of this.input.split('\n')) {
      if (pos + logical.length >= this.cursor) {
        const offset = this.cursor - pos;
        return { line: vLine + Math.floor(offset / w), col: offset % w };
      }
      pos += logical.length + 1; // +1 for \n
      vLine += logical.length === 0 ? 1 : Math.ceil(logical.length / w) || 1;
    }
    return { line: vLine, col: 0 };
  }

  /** Map a visual { line, col } back to a text cursor position. */
  private visualToCursor(targetLine: number, targetCol: number): number {
    const w = this.inputTextWidth;
    let pos = 0;
    let vLine = 0;
    for (const logical of this.input.split('\n')) {
      const lineVisLines = logical.length === 0 ? 1 : Math.ceil(logical.length / w) || 1;
      if (targetLine < vLine + lineVisLines) {
        const row = targetLine - vLine;
        const offset = row * w + Math.min(targetCol, logical.length - row * w);
        return Math.min(pos + Math.max(0, offset), pos + logical.length);
      }
      pos += logical.length + 1;
      vLine += lineVisLines;
    }
    return this.input.length;
  }

  // ── Spinner ───────────────────────────────────────────────

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerFrame = 0;
    this.loadingStartedAt = Date.now();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % AnsiTUI.SPINNER.length;
      const running = this.tasks.filter((t) => t.status === 'running').length;
      const speed = 0.12 + running * 0.04;
      this.borderPhase += speed;
      this.drawBox();
      this.posCursor();
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.loadingStartedAt = null;
  }

  private get spin(): string {
    return AnsiTUI.SPINNER[this.spinnerFrame % AnsiTUI.SPINNER.length]!;
  }

  private get elapsed(): string {
    if (!this.loadingStartedAt) return '';
    const s = (Date.now() - this.loadingStartedAt) / 1000;
    return s < 10 ? s.toFixed(1) + 's' : Math.round(s) + 's';
  }

  // ── Rainbow border ──────────────────────────────────────────

  private startBorderAnim(): void {
    if (this.borderTimer) return;
    this.borderTimer = setInterval(() => {
      this.borderPhase += 0.03;
      // Only redraw if spinner isn't already doing it
      if (!this.spinnerTimer) { this.drawBox(); this.posCursor(); }
    }, 80);
  }

  private stopBorderAnim(): void {
    if (this.borderTimer) { clearInterval(this.borderTimer); this.borderTimer = null; }
  }

  /** Color a border string with a gradient wave — faster and warmer under load. */
  private rb(text: string, colStart: number): string {
    const running = this.tasks.filter((t) => t.status === 'running').length;
    const intensity = this.loading ? 1 + running : 0;

    // Idle: cool blue-cyan (220 center, ±30 sweep, 70% sat)
    // Active: shift toward purple/magenta, wider sweep, higher sat
    const centerHue = 220 + intensity * 20;   // 220 → 240 → 260 → …
    const sweep = 30 + intensity * 15;         // ±30 → ±45 → ±60 → …
    const sat = 70 + Math.min(intensity * 8, 25); // 70 → 78 → 86 → 95 cap

    let out = '';
    for (let i = 0; i < text.length; i++) {
      const hue = centerHue + sweep * Math.sin((colStart + i) * 0.08 + this.borderPhase);
      const [r, g, b] = AnsiTUI.hslToRgb(hue, sat, 65);
      out += chalk.rgb(r, g, b)(text[i]);
    }
    return out;
  }

  /** Convert HSL (h: 0-360, s: 0-100, l: 0-100) to RGB tuple. */
  private static hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const s1 = s / 100, l1 = l / 100;
    const c = (1 - Math.abs(2 * l1 - 1)) * s1;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l1 - c / 2;
    let r1 = 0, g1 = 0, b1 = 0;
    if (h < 60) { r1 = c; g1 = x; }
    else if (h < 120) { r1 = x; g1 = c; }
    else if (h < 180) { g1 = c; b1 = x; }
    else if (h < 240) { g1 = x; b1 = c; }
    else if (h < 300) { r1 = x; b1 = c; }
    else { r1 = c; b1 = x; }
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(): void {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(resetScrollRegion + clearScreen + hideCursor);
    process.stdout.write(setScrollRegion(1, this.chatBot));
    process.stdout.write(`${ESC}[?2004h`); // enable bracket paste
    process.stdout.write(`${CSI}>1u`);      // enable kitty keyboard protocol (Shift+Enter detection)
    this.drawBox();
    this.posCursor();
    process.stdout.write(showCursor);
    this.startBorderAnim();
    this.wireClient();
    this.wireStdin();
    process.stdout.on('resize', () => this.onResize());
    this.client.connect();
  }

  /** Returns a promise that resolves when the TUI exits. */
  waitForExit(): Promise<void> {
    return new Promise((resolve) => { this.exitResolve = resolve; });
  }

  private onResize(): void {
    this.rows = process.stdout.rows ?? 24;
    this.cols = process.stdout.columns ?? 80;
    process.stdout.write(resetScrollRegion + clearScreen);
    process.stdout.write(setScrollRegion(1, this.chatBot));
    this.replayChat();
    this.drawBox();
    this.posCursor();
  }

  // ── Client event wiring ────────────────────────────────────

  private wireClient(): void {
    const c = this.client;

    c.on('connected', (st: ServerState) => {
      this.everConnected = true;
      this.connStatus = 'connected';
      this.messages = st.messages.map((m) => ({
        role: m.role, content: m.content, elapsed: m.elapsed,
      }));
      this.usage = st.usage;
      this.thinkLevel = st.thinking;
      this.loading = st.isLoading;
      this.tasks = st.tasks ?? [];
      this.err = null;
      // Full redraw on connect/reconnect
      // Reset scroll region first — some terminals only clear within the active region
      process.stdout.write(resetScrollRegion);
      process.stdout.write(clearScreen);
      process.stdout.write(setScrollRegion(1, this.chatBot));
      this.replayChat();
      this.drawBox();
      this.posCursor();
    });

    c.on('disconnected', () => {
      this.connStatus = 'reconnecting';
      this.loading = false;
      
      this.tools = [];
      this.stopSpinner();
      this.refresh();
    });

    c.on('reconnecting', () => {
      this.connStatus = 'reconnecting';
      this.refresh();
    });

    c.on('message', (dm: DisplayMessage) => {
      if (dm.role === 'assistant' && this.streamActive) {
        // Already streamed to chat — flush any remaining partial line
        this.streamText = dm.content;
        this.flushStreamAll();
        if (dm.elapsed !== undefined) {
          this.writeChatLines([this.agentLine(chalk.gray.dim(`(${dm.elapsed.toFixed(1)}s)`))]);
        }
        this.messages.push({ role: dm.role, content: dm.content, elapsed: dm.elapsed });
        this.streamActive = false;
        this.streamText = '';
        this.streamFlushedTo = 0;
        
        this.tools = [];
        this.isThinking = false;
      } else {
        this.messages.push({ role: dm.role, content: dm.content, elapsed: dm.elapsed });
        if (dm.role === 'assistant') {
          
          this.tools = [];
          this.isThinking = false;
        }
        this.writeChat({ role: dm.role, content: dm.content, elapsed: dm.elapsed });
      }
      this.refresh();
    });

    c.on('system', (content: string) => {
      const msg = { role: 'system' as const, content };
      this.messages.push(msg);
      this.writeChat(msg);
      this.refresh();
    });

    c.on('text', (content: string) => {
      this.isThinking = false;
      if (content) {
        this.streamText = content;
        if (this.streamActive) this.flushStreamLines();
      }
      this.refresh();
    });

    c.on('thinking', () => {
      if (!this.isThinking && this.streamActive) {
        // Show reasoning indicator in chat area (once, when thinking starts)
        this.writeChatLines([this.agentLine(chalk.magenta.dim('reasoning\u2026'))]);
      }
      this.isThinking = true;
      this.refresh();
    });

    c.on('tool_start', (name: string, _input: string, summary: string) => {
      if (this.streamActive) {
        // Flush remaining text before the tool line
        this.flushStreamAll();
        this.writeChatLines([this.agentLine(chalk.gray('\u2699 ' + summary))]);
        // Reset stream state for the next text segment (new API call after tools)
        this.streamText = '';
        this.streamFlushedTo = 0;
      }
      this.tools.push({ name, summary });
      this.refresh();
    });

    c.on('tool_output', () => { /* not displayed inline */ });

    c.on('tool_end', () => {
      this.tools = [];
      
      this.refresh();
    });

    c.on('task_update', (task: BackgroundTaskInfo) => {
      const i = this.tasks.findIndex((t) => t.id === task.id);
      if (i >= 0) this.tasks[i] = task;
      else this.tasks.push(task);
      this.refresh();
    });

    c.on('usage', (u: TokenUsage) => { this.usage = u; this.refresh(); });

    c.on('loading', (l: boolean) => {
      if (l && !this.streamActive) {
        // Start of agent turn — write label to chat area
        this.streamActive = true;
        this.streamText = '';
        this.streamFlushedTo = 0;
        this.writeChatLines([' ' + chalk.magenta.dim('agent')]);
      }
      this.loading = l;
      if (!l) {
        
        this.tools = [];
        this.isThinking = false;
        this.streamActive = false;
      }
      if (l) this.startSpinner();
      else this.stopSpinner();
      this.refresh();
    });

    c.on('error', (msg: string) => { this.err = msg; this.refresh(); });

    c.on('state', (p: { thinking?: ThinkingLevel }) => {
      if (p.thinking) this.thinkLevel = p.thinking;
      this.refresh();
    });
  }

  /** Format an agent content line with the left-side pipe border. */
  private agentLine(l: string): string {
    return chalk.magenta.dim(' \u258E') + ' ' + l;
  }

  // ── Chat rendering (inside scroll region) ──────────────────

  private replayChat(): void {
    process.stdout.write(moveTo(1, 1));
    for (const m of this.messages) this.writeChat(m);
  }

  /** Clear palette remnants before scrolling the chat region.
   *  The palette is drawn on the bottom rows of the scroll region.
   *  If we scroll without clearing first, those rows bake into history. */
  private clearPaletteBeforeScroll(): void {
    if (this.palettePrevCount > 0) {
      this.clearPaletteArea(this.palettePrevCount);
      this.palettePrevCount = 0;
    }
  }

  /** Write a message at the bottom of the scroll region (scrolls up). */
  private writeChat(msg: { role: string; content: string; elapsed?: number | undefined }): void {
    this.clearPaletteBeforeScroll();
    process.stdout.write(saveCursor);
    process.stdout.write(moveTo(this.chatBot, 1));
    for (const line of this.fmtMsg(msg)) {
      process.stdout.write('\n' + line);
    }
    process.stdout.write(restoreCursor);
  }

  /** Write raw lines to the chat scroll region (batch). */
  private writeChatLines(lines: string[]): void {
    if (!lines.length) return;
    this.clearPaletteBeforeScroll();
    process.stdout.write(saveCursor);
    process.stdout.write(moveTo(this.chatBot, 1));
    for (const line of lines) {
      process.stdout.write('\n' + clearLine + line);
    }
    process.stdout.write(restoreCursor);
  }

  /** Flush completed lines from streaming text to the chat area. */
  private flushStreamLines(): void {
    const text = this.streamText;
    if (this.streamFlushedTo >= text.length) return;
    const unflushed = text.slice(this.streamFlushedTo);
    const lastNl = unflushed.lastIndexOf('\n');
    if (lastNl < 0) return; // No complete lines yet

    const complete = unflushed.slice(0, lastNl);
    const lines: string[] = [];
    const w = this.cols - 4;
    for (const line of complete.split('\n')) {
      for (const wl of hardWrap(line, w)) lines.push(this.agentLine(wl));
    }
    if (lines.length) this.writeChatLines(lines);
    this.streamFlushedTo += lastNl + 1;
  }

  /** Flush ALL remaining streaming text (including partial line) to chat. */
  private flushStreamAll(): void {
    const text = this.streamText;
    if (this.streamFlushedTo >= text.length) return;
    const remaining = text.slice(this.streamFlushedTo);
    const lines: string[] = [];
    const w = this.cols - 4;
    for (const line of remaining.split('\n')) {
      for (const wl of hardWrap(line, w)) lines.push(this.agentLine(wl));
    }
    if (lines.length) this.writeChatLines(lines);
    this.streamFlushedTo = text.length;
  }

  /** Format a message into terminal-ready lines. */
  private fmtMsg(msg: { role: string; content: string; elapsed?: number | undefined }): string[] {
    const w = this.cols;
    if (msg.role === 'user') {
      const maxW = Math.min(Math.floor(w * 0.7), w - 4);
      const labelPad = Math.max(0, w - 3);
      const lines = [' '.repeat(labelPad) + chalk.cyan.dim('you')];
      for (const l of hardWrap(renderMarkdown(msg.content), maxW)) {
        const pad = Math.max(0, w - vis(l) - 2);
        lines.push(' '.repeat(pad) + l + chalk.cyan.dim(' \u258E'));
      }
      return lines;
    }
    if (msg.role === 'system') {
      const lines: string[] = [];
      for (const rawLine of msg.content.split('\n')) {
        if (!rawLine) { lines.push(''); continue; }
        for (const wl of hardWrap(rawLine, w - 4)) {
          lines.push('  ' + chalk.yellow(wl));
        }
      }
      return lines;
    }
    // Assistant
    const md = renderMarkdown(msg.content);
    const lines = hardWrap(md, w - 4);
    const label = msg.elapsed !== undefined
      ? ' ' + chalk.magenta.dim('agent') + chalk.gray.dim(` (${msg.elapsed.toFixed(1)}s)`)
      : ' ' + chalk.magenta.dim('agent');
    const out: string[] = [label];
    for (const l of lines) out.push(this.agentLine(l));
    return out;
  }

  // ── Command palette ──────────────────────────────────────────

  /** Recompute filtered palette items from current input. */
  private updatePalette(): void {
    if (!this.input.startsWith('/')) {
      this.paletteItems = [];
      this.paletteSelected = 0;
      return;
    }

    // Extract the command prefix (first word)
    const spaceIdx = this.input.indexOf(' ');
    const prefix = spaceIdx > 0 ? this.input.slice(0, spaceIdx) : this.input;

    // If user typed a complete command name WITH trailing space/args, hide palette.
    // Without a space, keep showing the match so the user has visual confirmation.
    if (spaceIdx > 0 && COMMAND_REGISTRY.some((c) => c.name === prefix)) {
      this.paletteItems = [];
      this.paletteSelected = 0;
      return;
    }

    this.paletteItems = COMMAND_REGISTRY.filter((c) =>
      c.name.startsWith(prefix.toLowerCase()),
    );
    this.paletteSelected = Math.min(this.paletteSelected, Math.max(0, this.paletteItems.length - 1));
  }

  /** Max visible palette rows. */
  private get paletteMaxVisible(): number {
    return Math.min(this.paletteItems.length, 8, Math.max(0, this.chatBot - 2));
  }

  /** Render the command palette overlay on the bottom of the chat scroll region. */
  private drawPalette(): void {
    const count = this.paletteMaxVisible;
    if (count <= 0) return;

    const iw = this.cols - 2; // full width minus 1-char margins

    let buf = saveCursor;
    for (let i = 0; i < count; i++) {
      const item = this.paletteItems[i]!;
      const isSelected = i === this.paletteSelected;
      const row = this.chatBot - count + 1 + i;

      // Format:  /command <args>    Description
      const nameText = item.name + (item.argHint ? ' ' + chalk.gray.dim(item.argHint) : '');
      const nameVis = vis(nameText);
      const descVis = vis(item.desc);
      const gap = Math.max(2, iw - nameVis - descVis);
      const line = nameText + ' '.repeat(gap) + chalk.dim(item.desc);
      const lineVis = nameVis + gap + descVis;
      const pad = Math.max(0, iw - lineVis);

      buf += moveTo(row, 1) + clearLine;
      if (isSelected) {
        buf += ' ' + chalk.bgCyan.black(line + ' '.repeat(pad)) + ' ';
      } else {
        buf += ' ' + chalk.gray(line + ' '.repeat(pad)) + ' ';
      }
    }
    buf += restoreCursor;
    process.stdout.write(buf);
  }

  /** Clear rows that were previously occupied by the palette. */
  private clearPaletteArea(prevCount: number): void {
    if (prevCount <= 0) return;
    let buf = saveCursor;
    for (let i = 0; i < prevCount; i++) {
      const row = this.chatBot - prevCount + 1 + i;
      if (row >= 1) buf += moveTo(row, 1) + clearLine;
    }
    buf += restoreCursor;
    process.stdout.write(buf);
  }

  /** Complete the currently selected palette item into the input. */
  private completePaletteSelection(): void {
    const item = this.paletteItems[this.paletteSelected];
    if (!item) return;
    this.input = item.argHint ? item.name + ' ' : item.name;
    this.cursor = this.input.length;
    this.updatePalette();
  }

  // ── Input box rendering (outside scroll region) ────────────

  /** Redraw the input box, palette overlay, and reposition the cursor. */
  private refresh(): void {
    const wasPaletteCount = this.palettePrevCount;
    this.updatePalette();
    this.drawBox();
    const count = this.paletteMaxVisible;
    if (count > 0) {
      this.drawPalette();
      this.palettePrevCount = count;
    } else if (wasPaletteCount > 0) {
      this.clearPaletteArea(wasPaletteCount);
      this.palettePrevCount = 0;
    }
    this.posCursor();
  }

  /** Render the input box at the bottom of the screen. */
  private drawBox(): void {
    const cols = this.cols;
    const iw = cols - 4; // usable width between │ and │

    // ── Row 0: top border with status chips ──
    const running = this.tasks.filter((t) => t.status === 'running');
    const el = this.thinkLevel !== 'off'
      ? ({ low: 'L', medium: 'M', high: 'H', max: 'X' } as Record<string, string>)[this.thinkLevel] ?? '?'
      : null;
    const parts: string[] = [];
    // Error and reconnecting status as chips (was in the removed activity row)
    if (this.err) {
      const e = this.err.length > 30 ? this.err.slice(0, 29) + '\u2026' : this.err;
      parts.push(chalk.red(e));
    } else if (this.connStatus === 'reconnecting' && this.everConnected) {
      parts.push(chalk.yellow('reconnecting\u2026'));
    }
    // reasoning level moved to bottom-left border
    if (this.loading) {
      const elapsed = this.elapsed;
      parts.push(elapsed ? `${this.spin} ${elapsed}` : this.spin);
    }
    if (running.length) parts.push(`${running.length} task${running.length > 1 ? 's' : ''}`);
    const cost = this.usage.cost ?? 0;
    if (cost > 0) parts.push(cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`);
    const ctxUsed = this.usage.contextTokens ?? 0;
    if (ctxUsed > 0) {
      const pct = Math.round((ctxUsed / 200_000) * 100);
      parts.push(`${ctxBar(ctxUsed, 200_000, 8)} ${fmtTok(ctxUsed)}/200k (${pct}%)`);
    }
    const rs = parts.join(' \u2502 ');
    const fill = Math.max(0, cols - 4 - rs.length);

    // ── Input rows ──
    const visLines = this.getInputVisualLines();
    const dispLines = AnsiTUI.INPUT_LINES;
    const curVis = this.cursorToVisual();

    // Ensure cursor is visible (vertical scroll)
    if (curVis.line < this.inputVScroll) this.inputVScroll = curVis.line;
    if (curVis.line >= this.inputVScroll + dispLines) this.inputVScroll = curVis.line - dispLines + 1;
    this.inputVScroll = Math.max(0, Math.min(this.inputVScroll, visLines.length - dispLines));

    const inputRows: string[] = [];
    for (let i = 0; i < dispLines; i++) {
      const vIdx = i + this.inputVScroll;
      const lineText = vIdx < visLines.length ? visLines[vIdx]! : '';

      if (!this.input && i === 0) {
        // Placeholder on first line when empty
        const ph = this.ctrlCArmed
          ? 'Press Ctrl+C again to exit\u2026'
          : this.loading ? 'Type to queue\u2026' : 'Type a message\u2026';
        inputRows.push(chalk.gray(ph));
      } else {
        inputRows.push(lineText);
      }
    }

    // ── Assemble and write ──
    let buf = syncStart;
    let row = this.boxTop;

    // Row 0: top border
    buf += moveTo(row, 1) + clearLine;
    buf += this.rb('\u250C' + '\u2500'.repeat(fill) + ' ', 0) + chalk.gray(rs) + this.rb(' \u2510', cols - 2);
    row++;

    // Input lines
    for (let i = 0; i < dispLines; i++) {
      const prefix = i === 0
        ? (this.loading ? chalk.gray('> ') : chalk.cyan.bold('> '))
        : '  '; // continuation indent
      const text = inputRows[i] ?? '';
      const textVis = 2 + vis(text); // prefix (2 vis chars) + text
      buf += moveTo(row, 1) + clearLine;
      buf += this.rb('\u2502', 0) + ' ' + prefix + text + ' '.repeat(Math.max(0, iw - textVis)) + this.rb(' \u2502', cols - 2);
      row++;
    }

    // Bottom border — reasoning level on left
    const rl = `r:${el ? 'on ' + el : 'off'}`;
    buf += moveTo(row, 1) + clearLine;
    buf += this.rb('\u2514\u2500 ', 0) + chalk.gray(rl) + this.rb(' ' + '\u2500'.repeat(Math.max(0, cols - 6 - rl.length)) + '\u2518', 0);

    buf += syncEnd;
    process.stdout.write(buf);
  }

  /** Position the terminal cursor inside the input field. */
  private posCursor(): void {
    const curVis = this.cursorToVisual();
    const displayRow = curVis.line - this.inputVScroll;
    const inputStart = this.boxTop + 1; // border
    const row = inputStart + displayRow;
    const col = 5 + curVis.col; // "│ > " = 4 chars + 1-indexed
    process.stdout.write(moveTo(row, col) + showCursor);
  }

  // ── Stdin handling ─────────────────────────────────────────

  private wireStdin(): void {
    const PS = '\x1b[200~';
    const PE = '\x1b[201~';

    process.stdin.on('data', (data: Buffer) => {
      const s = data.toString();

      // Bracket paste start
      const psi = s.indexOf(PS);
      if (psi !== -1) {
        this.pasting = true;
        const after = s.slice(psi + PS.length);
        const ei = after.indexOf(PE);
        if (ei !== -1) this.endPaste(after.slice(0, ei));
        else this.pasteBuf = after;
        return;
      }

      // Mid-paste
      if (this.pasting) {
        const ei = s.indexOf(PE);
        if (ei !== -1) {
          this.pasteBuf += s.slice(0, ei);
          this.endPaste(this.pasteBuf);
          this.pasteBuf = '';
        } else {
          this.pasteBuf += s;
        }
        return;
      }

      this.key(s);
    });
  }

  private endPaste(text: string): void {
    if (text) {
      this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
      this.cursor += text.length;
      this.refresh();
    }
    this.pasting = false;
  }

  /** Handle a single keypress / escape sequence. */
  private key(s: string): void {
    // ── Ctrl+C ──
    if (s === '\x03') {
      if (this.ctrlCArmed) { this.shutdown(); return; }
      if (this.loading) this.client.cancel();
      else if (this.input) { this.input = ''; this.cursor = 0; this.refresh(); return; }
      this.ctrlCArmed = true;
      if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = setTimeout(() => { this.ctrlCArmed = false; this.refresh(); }, 2000);
      this.refresh();
      return;
    }

    // Any other key resets Ctrl+C
    if (this.ctrlCArmed) {
      this.ctrlCArmed = false;
      if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
    }

    // ── Ctrl+D ── exit on empty, forward-delete otherwise
    if (s === '\x04') {
      if (!this.input) { this.shutdown(); return; }
      if (this.cursor < this.input.length) {
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        this.refresh();
      }
      return;
    }

    // ── Escape ── cancel or clear (also dismisses palette)
    if (s === '\x1b') {
      if (this.loading) this.client.cancel();
      else if (this.input) { this.input = ''; this.cursor = 0; }
      this.refresh();
      return;
    }

    // ── Enter ──
    if (s === '\r') {
      // If palette is showing and input is just a partial command (not yet complete),
      // complete the selection instead of submitting
      if (this.paletteItems.length > 0 && !COMMAND_REGISTRY.some((c) => c.name === this.input.trim())) {
        const item = this.paletteItems[this.paletteSelected];
        this.completePaletteSelection();
        if (!item?.argHint) {
          // No args needed — submit immediately
          this.submit();
          return;
        }
        this.refresh();
        return;
      }
      this.submit();
      return;
    }

    // ── Shift+Enter (kitty protocol: \x1b[13;2u) — insert newline ──
    if (s === '\x1b[13;2u' || s === '\x1b[13;5u') {
      this.input = this.input.slice(0, this.cursor) + '\n' + this.input.slice(this.cursor);
      this.cursor++;
      this.refresh();
      return;
    }

    // ── Alt+Enter — insert newline (fallback for terminals without kitty protocol) ──
    if (s === '\x1b\r') {
      this.input = this.input.slice(0, this.cursor) + '\n' + this.input.slice(this.cursor);
      this.cursor++;
      this.refresh();
      return;
    }

    // ── Tab ── complete palette selection
    if (s === '\t') {
      if (this.paletteItems.length > 0) {
        this.completePaletteSelection();
        this.refresh();
      }
      return;
    }

    // ── Backspace ──
    if (s === '\x7f' || s === '\b') {
      if (this.cursor > 0) {
        this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
        this.cursor--;
        this.refresh();
      }
      return;
    }

    // ── Delete key ──
    if (s === '\x1b[3~') {
      if (this.cursor < this.input.length) {
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        this.refresh();
      }
      return;
    }

    // ── Arrow keys ──
    if (s === '\x1b[D') { this.cursor = Math.max(0, this.cursor - 1); this.refresh(); return; }
    if (s === '\x1b[C') { this.cursor = Math.min(this.input.length, this.cursor + 1); this.refresh(); return; }

    // ── Up / Down — palette navigation or multi-line input ──
    if (s === '\x1b[A') {
      if (this.paletteItems.length > 0) {
        this.paletteSelected = Math.max(0, this.paletteSelected - 1);
        this.refresh();
        return;
      }
      const cur = this.cursorToVisual();
      if (cur.line > 0) {
        this.cursor = this.visualToCursor(cur.line - 1, cur.col);
        this.refresh();
      }
      return;
    }
    if (s === '\x1b[B') {
      if (this.paletteItems.length > 0) {
        this.paletteSelected = Math.min(this.paletteItems.length - 1, this.paletteSelected + 1);
        this.refresh();
        return;
      }
      const cur = this.cursorToVisual();
      const totalLines = this.getInputVisualLines().length;
      if (cur.line < totalLines - 1) {
        this.cursor = this.visualToCursor(cur.line + 1, cur.col);
        this.refresh();
      }
      return;
    }

    // Word movement: Ctrl+Left / Alt+b, Ctrl+Right / Alt+f
    if (s === '\x1b[1;5D' || s === '\x1bb') { this.cursor = wordBoundL(this.input, this.cursor); this.refresh(); return; }
    if (s === '\x1b[1;5C' || s === '\x1bf') { this.cursor = wordBoundR(this.input, this.cursor); this.refresh(); return; }

    // ── Home / End ──
    if (s === '\x1b[H' || s === '\x1bOH' || s === '\x1b[1~') { this.cursor = 0; this.refresh(); return; }
    if (s === '\x1b[F' || s === '\x1bOF' || s === '\x1b[4~') { this.cursor = this.input.length; this.refresh(); return; }

    // ── Ctrl navigation ──
    if (s === '\x01') { this.cursor = 0; this.refresh(); return; }             // Ctrl+A
    if (s === '\x05') { this.cursor = this.input.length; this.refresh(); return; } // Ctrl+E
    if (s === '\x02') { this.cursor = Math.max(0, this.cursor - 1); this.refresh(); return; }             // Ctrl+B
    if (s === '\x06') { this.cursor = Math.min(this.input.length, this.cursor + 1); this.refresh(); return; } // Ctrl+F

    // ── Ctrl deletion ──
    if (s === '\x17') { // Ctrl+W — delete word
      const b = wordBoundL(this.input, this.cursor);
      this.input = this.input.slice(0, b) + this.input.slice(this.cursor);
      this.cursor = b;
      this.refresh();
      return;
    }
    if (s === '\x15') { // Ctrl+U — delete to start
      this.input = this.input.slice(this.cursor);
      this.cursor = 0;
      this.refresh();
      return;
    }
    if (s === '\x0b') { // Ctrl+K — delete to end
      this.input = this.input.slice(0, this.cursor);
      this.refresh();
      return;
    }

    // ── Ctrl+J — insert newline ──
    if (s === '\x0a') {
      this.input = this.input.slice(0, this.cursor) + '\n' + this.input.slice(this.cursor);
      this.cursor++;
      this.refresh();
      return;
    }

    // ── Ctrl+L — full screen refresh ──
    if (s === '\x0c') {
      process.stdout.write(clearScreen);
      process.stdout.write(setScrollRegion(1, this.chatBot));
      this.replayChat();
      this.refresh();
      return;
    }

    // Ignore remaining escape sequences (F-keys, etc.)
    if (s.startsWith('\x1b')) return;

    // Ignore remaining control characters
    if (s.length === 1 && s.charCodeAt(0) < 32) return;

    // ── Regular character input ──
    this.input = this.input.slice(0, this.cursor) + s + this.input.slice(this.cursor);
    this.cursor += s.length;
    this.refresh();
  }

  private submit(): void {
    const t = this.input.trim();
    this.input = '';
    this.cursor = 0;

    // Force-clear palette BEFORE any downstream writes/scrolls.
    // sendMessage may synchronously trigger system events → writeChat → scroll,
    // which would bake visible palette rows into permanent scrollback.
    if (this.palettePrevCount > 0) {
      this.clearPaletteArea(this.palettePrevCount);
      this.palettePrevCount = 0;
    }
    this.paletteItems = [];
    this.paletteSelected = 0;

    if (!t) { this.refresh(); return; }

    // /refresh is client-side only
    if (t === '/refresh' || t === '/refesh') {
      process.stdout.write(clearScreen);
      process.stdout.write(setScrollRegion(1, this.chatBot));
      this.replayChat();
      this.refresh();
      return;
    }

    this.client.sendMessage(t);
    this.refresh();
  }

  // ── Shutdown ───────────────────────────────────────────────

  private shutdown(): void {
    this.stopSpinner();
    this.stopBorderAnim();
    process.stdout.write(`${CSI}<u`);       // disable kitty keyboard protocol
    process.stdout.write(resetScrollRegion + showCursor + `${ESC}[?2004l`);
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    this.client.disconnect();
    if (this.exitResolve) {
      this.exitResolve();
    } else {
      process.exit(0);
    }
  }
}
