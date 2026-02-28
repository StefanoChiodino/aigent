import type { DemoStep, DemoScenario } from './types';
import type { MockWebSocket } from './MockWebSocket';
import { useUIStore } from '../stores/ui';
import { useChatStore } from '../stores/chat';
import { useVoiceStore } from '../stores/voice';
import { useSettingsStore } from '../stores/settings';
import { useDemoPlaybackStore } from './demoStore';
import type { DemoSection } from './demoStore';

interface Snapshot {
  chat: Record<string, unknown>;
  ui: Record<string, unknown>;
  voice: Record<string, unknown>;
  settings: Record<string, unknown>;
  inputText: string;
}

/**
 * Walks through a DemoScenario step-by-step, emitting ServerEvents
 * through the MockWebSocket and orchestrating UI interactions.
 *
 * Supports pause/resume and seeking (forward and backward) via
 * Zustand store snapshots captured before each step executes.
 */
// SVG cursor icon (simple pointer arrow)
const CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" stroke="black" stroke-width="1">
  <path d="M5 3l14 10-6.5 1.5L16 21l-3 1.5-3.5-6.5L4 18z"/>
</svg>`;

/** Default alternate voice for simulated STT — must differ from the main TTS voice (en-US-AvaNeural). */
const STT_SIM_VOICE = 'en-US-AndrewNeural';

export class DemoPlaybackEngine {
  private scenario: DemoScenario;
  private mockWs: MockWebSocket;
  private aborted = false;
  private currentAudio: HTMLAudioElement | null = null;

  // Fake cursor element
  private cursorEl: HTMLElement | null = null;
  private cursorRing: HTMLElement | null = null;

  // Scrubber / seek support
  private stepIdx = 0;
  private snapshots: Snapshot[] = [];
  private currentInputText = '';
  private _seekTarget: number | null = null;
  private _delayTimer: ReturnType<typeof setTimeout> | null = null;
  private _delayResolve: (() => void) | null = null;
  private _paused = false;
  private _pauseResolve: (() => void) | null = null;

  /** Effective step count (excludes the final 'loop' step) */
  readonly effectiveSteps: number;

  /** Map from section id to step index, for URL fragment navigation */
  readonly sectionIndex: Map<string, number> = new Map();

  /** Map from step index to section id (only for steps that ARE a section label) */
  private sectionByStep: Map<number, string> = new Map();

  constructor(scenario: DemoScenario, mockWs: MockWebSocket) {
    this.scenario = scenario;
    this.mockWs = mockWs;

    // Exclude trailing 'loop' step from the slider range
    const last = scenario.steps[scenario.steps.length - 1];
    this.effectiveSteps = last?.action === 'loop'
      ? scenario.steps.length - 1
      : scenario.steps.length;

    const store = useDemoPlaybackStore.getState();
    store.setTotalSteps(this.effectiveSteps);

    // Pre-build label index: each step maps to the most recent label
    const labels: string[] = [];
    const sections: DemoSection[] = [];
    let current = '';
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i]!;
      if (step.action === 'label') {
        current = step.text;
        if (step.id) {
          this.sectionIndex.set(step.id, i);
          this.sectionByStep.set(i, step.id);
          sections.push({ id: step.id, label: step.text, step: i });
        }
      }
      labels[i] = current;
    }
    store.setStepLabels(labels);
    store.setSections(sections);
  }

  /** Whether current step should bail early (abort or seek in progress) */
  private shouldStop(): boolean {
    return this.aborted || this._seekTarget !== null;
  }

  async play(): Promise<void> {
    while (!this.aborted) {
      if (this.stepIdx >= this.scenario.steps.length) return;

      // Handle pending seek
      if (this._seekTarget !== null) {
        this.handleSeek();
        continue;
      }

      // Handle pause
      if (this._paused) {
        await new Promise<void>(r => { this._pauseResolve = r; });
        continue;
      }

      const step = this.scenario.steps[this.stepIdx]!;

      // Capture snapshot before step executes
      this.captureSnapshot();

      // Execute the step
      await this.executeStep(step);

      // If a seek happened mid-step, don't advance — loop will handle it
      if (this._seekTarget !== null) continue;

      // Handle loop: reset and restart from step 0
      if (step.action === 'loop') {
        this.stepIdx = 0;
        this.snapshots = [];
        useDemoPlaybackStore.getState().setCurrentStep(0);
        continue;
      }

      this.stepIdx++;
      useDemoPlaybackStore.getState().setCurrentStep(this.stepIdx);
    }
  }

  stop(): void {
    this.aborted = true;
    this.cancelDelay();
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
    this.removeCursor();
  }

  seekTo(step: number): void {
    const target = Math.max(0, Math.min(step, this.effectiveSteps - 1));
    this._seekTarget = target;
    this.cancelDelay();
    // Stop any playing audio
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
    useVoiceStore.getState().setTtsPlaying(false);
    speechSynthesis.cancel();
    // If paused, resume so the play loop processes the seek
    if (this._paused) {
      this._paused = false;
      this._pauseResolve?.();
      this._pauseResolve = null;
    }
  }

  seekToSection(id: string): void {
    const step = this.sectionIndex.get(id);
    if (step !== undefined) this.seekTo(step);
  }

  pause(): void {
    this._paused = true;
    useDemoPlaybackStore.getState().setPlaying(false);
  }

  resume(): void {
    this._paused = false;
    useDemoPlaybackStore.getState().setPlaying(true);
    this._pauseResolve?.();
    this._pauseResolve = null;
  }

  togglePause(): void {
    if (this._paused) this.resume();
    else this.pause();
  }

  // ── Snapshot / Seek ──────────────────────────────────────────────────────

  private captureSnapshot(): void {
    if (this.snapshots.length <= this.stepIdx) {
      this.snapshots[this.stepIdx] = {
        chat: { ...useChatStore.getState() },
        ui: { ...useUIStore.getState() },
        voice: { ...useVoiceStore.getState() },
        settings: { clientSettings: { ...useSettingsStore.getState().clientSettings } },
        inputText: this.currentInputText,
      };
    }
  }

  private handleSeek(): void {
    const target = this._seekTarget!;
    this._seekTarget = null;

    if (target < this.snapshots.length) {
      // We have a snapshot — restore it directly
      this.restoreSnapshot(target);
    } else {
      // Fast-forward from last known snapshot to target
      this.fastForwardTo(target);
    }

    this.stepIdx = target;
    useDemoPlaybackStore.getState().setCurrentStep(target);

    // Update current section id and URL hash based on seek target
    // Walk backward from target to find the most recent section
    for (let i = target; i >= 0; i--) {
      const sectionId = this.sectionByStep.get(i);
      if (sectionId) {
        useDemoPlaybackStore.getState().setCurrentSectionId(sectionId);
        history.replaceState(null, '', `#${sectionId}`);
        break;
      }
    }

    // Pause after seek so user can inspect
    this._paused = true;
    useDemoPlaybackStore.getState().setPlaying(false);
  }

  private restoreSnapshot(idx: number): void {
    const snap = this.snapshots[idx]!;
    useChatStore.setState(snap.chat);
    useUIStore.setState(snap.ui);
    useVoiceStore.setState(snap.voice);
    useSettingsStore.setState(snap.settings);
    this.currentInputText = snap.inputText;
    window.dispatchEvent(new CustomEvent('__demo_set_input', { detail: snap.inputText }));
  }

  /**
   * Fast-forward from the last available snapshot to the target step.
   * Executes all intermediate steps synchronously (no delays, no animations).
   */
  private fastForwardTo(target: number): void {
    // Start from the last available snapshot, or 0
    const start = this.snapshots.length > 0 ? this.snapshots.length - 1 : 0;

    // Restore to last known state
    if (start > 0 && start < this.snapshots.length) {
      this.restoreSnapshot(start);
    }

    // Fast-execute steps from start to target (capturing snapshots along the way)
    for (let i = start; i <= target && i < this.scenario.steps.length; i++) {
      this.stepIdx = i;
      this.captureSnapshot();
      const step = this.scenario.steps[i]!;
      if (step.action === 'loop') break; // Don't fast-forward past loop
      this.fastExecuteStep(step);
    }

    // Dispatch final input text
    window.dispatchEvent(new CustomEvent('__demo_set_input', { detail: this.currentInputText }));
  }

  /** Execute a step instantly (no delays, no animations, no audio) */
  private fastExecuteStep(step: DemoStep): void {
    switch (step.action) {
      case 'wait': break;
      case 'label': break;
      case 'play_audio': break;
      case 'speak_tts': break;

      case 'emit':
        this.mockWs.emit(step.event);
        break;

      case 'type_input':
        this.currentInputText = step.text;
        break;

      case 'submit_input':
        // Emit a submit event so InputArea clears
        window.dispatchEvent(new Event('__demo_submit_input'));
        this.currentInputText = '';
        break;

      case 'auto_approve':
        this.autoApprovePermission();
        break;

      case 'stream_text':
        // Emit the final accumulated text in one shot
        this.mockWs.emit({ type: 'text', content: step.text });
        break;

      case 'stream_thinking':
        // Emit all thinking text as one delta
        this.mockWs.emit({ type: 'thinking', content: step.text });
        break;

      case 'open_modal':
        this.setModal(step.modal, true);
        break;

      case 'close_modal':
        this.setModal(step.modal, false);
        break;

      case 'set_mic':
        useVoiceStore.getState().setMicState(step.state);
        if (step.vadActive !== undefined) useVoiceStore.getState().setVadActive(step.vadActive);
        break;

      case 'add_attachment':
        useUIStore.getState().addAttachment(step.attachment);
        break;

      case 'clear_attachments':
        useUIStore.getState().clearAttachments();
        break;

      case 'set_tts_auto':
        useVoiceStore.getState().setTtsAutoSpeak(step.on);
        break;

      case 'set_short':
        useUIStore.getState().setShortMode(step.on);
        break;

      case 'click': {
        const el = document.querySelector(step.selector) as HTMLElement | null;
        if (el) el.click();
        break;
      }

      case 'set_theme':
        useSettingsStore.getState().setClientSetting('AIGENT_THEME', step.theme);
        break;

      case 'close_pip':
        this.closePiP();
        break;

      case 'tts_to_stt':
        // Fast-forward: just set the input text, skip audio & mic animation
        this.currentInputText = step.text;
        break;

      case 'loop': break;
    }
  }

  // ── Step Execution (normal, with delays) ─────────────────────────────────

  private async executeStep(step: DemoStep): Promise<void> {
    switch (step.action) {
      case 'wait':
        await this.delay(step.ms);
        break;

      case 'label':
        // Update URL hash when reaching a section label
        if (step.id) {
          useDemoPlaybackStore.getState().setCurrentSectionId(step.id);
          history.replaceState(null, '', `#${step.id}`);
        }
        break;

      case 'emit':
        this.mockWs.emit(step.event);
        break;

      case 'type_input':
        await this.animateTyping(step.text, step.charDelayMs);
        break;

      case 'submit_input':
        window.dispatchEvent(new Event('__demo_submit_input'));
        this.currentInputText = '';
        break;

      case 'auto_approve':
        await this.delay(step.delayMs);
        this.autoApprovePermission();
        break;

      case 'stream_text':
        await this.streamText(step.text, step.chunkSize, step.intervalMs);
        break;

      case 'stream_thinking':
        await this.streamThinking(step.text, step.chunkSize, step.intervalMs);
        break;

      case 'open_modal':
        this.setModal(step.modal, true);
        break;

      case 'close_modal':
        this.setModal(step.modal, false);
        break;

      case 'set_mic':
        useVoiceStore.getState().setMicState(step.state);
        if (step.vadActive !== undefined) useVoiceStore.getState().setVadActive(step.vadActive);
        break;

      case 'add_attachment':
        useUIStore.getState().addAttachment(step.attachment);
        break;

      case 'clear_attachments':
        useUIStore.getState().clearAttachments();
        break;

      case 'set_tts_auto':
        useVoiceStore.getState().setTtsAutoSpeak(step.on);
        break;

      case 'set_short':
        useUIStore.getState().setShortMode(step.on);
        break;

      case 'play_audio':
        await this.playAudio(step.src);
        break;

      case 'speak_tts':
        await this.speakViaTts(step.text, step.voice);
        break;

      case 'click':
        await this.animatedClick(step.selector);
        break;

      case 'set_theme':
        useSettingsStore.getState().setClientSetting('AIGENT_THEME', step.theme);
        break;

      case 'close_pip':
        this.closePiP();
        break;

      case 'tts_to_stt':
        await this.executeTtsToStt(step.text, step.voice);
        break;

      case 'loop':
        await this.loopReset();
        break;
    }
  }

  private setModal(modal: 'settings' | 'shortcuts' | 'context', open: boolean): void {
    // Hide cursor when closing a modal (no more clicking to show)
    if (!open) this.removeCursor();
    const ui = useUIStore.getState();
    switch (modal) {
      case 'settings': ui.setSettingsOpen(open); break;
      case 'shortcuts': ui.setShortcutsOpen(open); break;
      case 'context': ui.setCtxInspectorOpen(open); break;
    }
  }

  /** Animate typing character-by-character via custom DOM events */
  private async animateTyping(text: string, charDelayMs: number): Promise<void> {
    let current = '';
    for (const char of text) {
      if (this.shouldStop()) return;
      current += char;
      this.currentInputText = current;
      window.dispatchEvent(new CustomEvent('__demo_set_input', { detail: current }));
      await this.delay(charDelayMs + Math.random() * charDelayMs * 0.5);
    }
  }

  private async streamText(text: string, chunkSize: number, intervalMs: number): Promise<void> {
    for (let i = chunkSize; i <= text.length; i += chunkSize) {
      if (this.shouldStop()) return;
      this.mockWs.emit({ type: 'text', content: text.slice(0, i) });
      await this.delay(intervalMs);
    }
    if (text.length % chunkSize !== 0) {
      if (this.shouldStop()) return;
      this.mockWs.emit({ type: 'text', content: text });
      await this.delay(intervalMs);
    }
  }

  private async streamThinking(text: string, chunkSize: number, intervalMs: number): Promise<void> {
    for (let i = 0; i < text.length; i += chunkSize) {
      if (this.shouldStop()) return;
      this.mockWs.emit({ type: 'thinking', content: text.slice(i, i + chunkSize) });
      await this.delay(intervalMs);
    }
  }

  private async playAudio(src: string): Promise<void> {
    if (this.shouldStop()) return;
    return new Promise<void>((resolve) => {
      const audio = new Audio(src);
      this.currentAudio = audio;
      useVoiceStore.getState().setTtsPlaying(true);
      const done = () => {
        this.currentAudio = null;
        useVoiceStore.getState().setTtsPlaying(false);
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      void audio.play().catch(done);
    });
  }

  /**
   * Speak text via edge-tts (default voice) and play the audio.
   * Used for the agent's TTS response in the demo — no static file needed.
   * Falls back to browser SpeechSynthesis if TTS server is unavailable.
   */
  private async speakViaTts(text: string, voiceName?: string): Promise<void> {
    if (this.shouldStop()) return;

    useVoiceStore.getState().setTtsPlaying(true);
    let played = false;
    try {
      const params = new URLSearchParams();
      if (voiceName) params.set('voice', voiceName);
      const qs = params.toString();
      const res = await fetch(`/tts${qs ? `?${qs}` : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          this.currentAudio = audio;
          const done = () => { this.currentAudio = null; URL.revokeObjectURL(url); resolve(); };
          audio.onended = done;
          audio.onerror = done;
          void audio.play().catch(done);
        });
        played = true;
      }
    } catch { /* TTS server unavailable */ }

    // Fallback: browser SpeechSynthesis
    if (!played && !this.shouldStop()) {
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
      });
    }

    useVoiceStore.getState().setTtsPlaying(false);
  }

  /**
   * Simulate voice input: generate speech with edge-tts (alternate voice),
   * play the audio while animating mic/VAD states, then "transcribe" the text into input.
   * Falls back to browser SpeechSynthesis if TTS server is unavailable.
   */
  private async executeTtsToStt(text: string, voiceName?: string): Promise<void> {
    if (this.shouldStop()) return;

    const voice = voiceName ?? STT_SIM_VOICE;

    // Start "recording"
    useVoiceStore.getState().setMicState('recording');
    useVoiceStore.getState().setVadActive(false);
    await this.delay(400);
    if (this.shouldStop()) return;

    // Generate audio with edge-tts using a different voice
    useVoiceStore.getState().setVadActive(true);
    let played = false;
    try {
      const qs = `?voice=${encodeURIComponent(voice)}&rate=${encodeURIComponent('+0%')}`;
      const res = await fetch(`/tts${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: text,
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        await new Promise<void>((resolve) => {
          const audio = new Audio(url);
          this.currentAudio = audio;
          const done = () => { this.currentAudio = null; URL.revokeObjectURL(url); resolve(); };
          audio.onended = done;
          audio.onerror = done;
          void audio.play().catch(done);
        });
        played = true;
      }
    } catch { /* TTS server unavailable — fall through to SpeechSynthesis fallback */ }

    // Fallback: browser SpeechSynthesis if /tts failed
    if (!played && !this.shouldStop()) {
      await new Promise<void>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.0;
        utterance.onend = () => resolve();
        utterance.onerror = () => resolve();
        speechSynthesis.speak(utterance);
      });
    }
    if (this.shouldStop()) return;

    // Speech ended — VAD goes silent
    useVoiceStore.getState().setVadActive(false);
    await this.delay(300);
    if (this.shouldStop()) return;

    // "Transcribing"
    useVoiceStore.getState().setMicState('transcribing');
    await this.delay(800);
    if (this.shouldStop()) return;

    // Transcription complete — type the text into input
    useVoiceStore.getState().setMicState('idle');
    await this.animateTyping(text, 30);
  }

  // ── Fake cursor ──────────────────────────────────────────────────────────

  private ensureCursor(): HTMLElement {
    if (!this.cursorEl) {
      const el = document.createElement('div');
      el.id = 'demo-cursor';
      el.innerHTML = CURSOR_SVG;
      document.body.appendChild(el);
      this.cursorEl = el;

      const ring = document.createElement('div');
      ring.id = 'demo-cursor-ring';
      document.body.appendChild(ring);
      this.cursorRing = ring;
    }
    return this.cursorEl;
  }

  private removeCursor(): void {
    this.cursorEl?.remove();
    this.cursorEl = null;
    this.cursorRing?.remove();
    this.cursorRing = null;
  }

  private async animatedClick(selector: string): Promise<void> {
    const target = document.querySelector(selector) as HTMLElement | null;
    if (!target) return;

    const cursor = this.ensureCursor();
    const rect = target.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;

    // Show cursor at current position (or start from bottom-right)
    if (!cursor.classList.contains('visible')) {
      cursor.style.left = `${targetX + 60}px`;
      cursor.style.top = `${targetY + 60}px`;
      // Force reflow before adding visible class
      cursor.offsetHeight;
      cursor.classList.add('visible');
    }

    // Animate to target position
    cursor.style.left = `${targetX}px`;
    cursor.style.top = `${targetY}px`;

    await this.delay(700); // wait for cursor travel animation
    if (this.shouldStop()) return;

    // Click animation: scale down + ring effect
    cursor.classList.add('clicking');
    if (this.cursorRing) {
      this.cursorRing.style.left = `${targetX}px`;
      this.cursorRing.style.top = `${targetY}px`;
      this.cursorRing.classList.add('active');
    }

    await this.delay(150);
    cursor.classList.remove('clicking');
    target.click();

    await this.delay(300);
    if (this.cursorRing) this.cursorRing.classList.remove('active');
  }

  private closePiP(): void {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pip = (window as any).documentPictureInPicture;
      if (pip?.window) pip.window.close();
    } catch { /* noop — unsupported or already closed */ }
  }

  private autoApprovePermission(): void {
    const { permQueue } = useUIStore.getState();
    if (permQueue.length === 0) return;
    const next = permQueue.slice(1);
    useUIStore.setState({ permQueue: next, permShowing: next.length > 0 });
  }

  private async loopReset(): Promise<void> {
    // Hide cursor before fade
    this.removeCursor();
    document.getElementById('app')?.classList.add('demo-fade');
    await this.delay(1000);

    useChatStore.getState().clearMessages();
    useChatStore.getState().setUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    useChatStore.getState().endStream();
    useChatStore.getState().setTasks([]);
    useUIStore.setState({
      permQueue: [], permShowing: false,
      settingsOpen: false, shortcutsOpen: false, ctxInspectorOpen: false,
      pendingAttachments: [],
    });
    useVoiceStore.getState().setMicState('idle');
    useVoiceStore.getState().setVadActive(false);
    useVoiceStore.getState().setTtsAutoSpeak(false);
    useVoiceStore.getState().setTtsPlaying(false);
    useUIStore.getState().setShortMode(false);
    useSettingsStore.getState().setClientSetting('AIGENT_THEME', 'aurora');
    if (this.currentAudio) { this.currentAudio.pause(); this.currentAudio = null; }
    speechSynthesis.cancel();
    this.closePiP();
    this.currentInputText = '';
    window.dispatchEvent(new CustomEvent('__demo_set_input', { detail: '' }));

    document.getElementById('app')?.classList.remove('demo-fade');
    await this.delay(3000);
  }

  // ── Timing ───────────────────────────────────────────────────────────────

  private cancelDelay(): void {
    if (this._delayTimer) { clearTimeout(this._delayTimer); this._delayTimer = null; }
    this._delayResolve?.();
    this._delayResolve = null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      this._delayResolve = resolve;
      this._delayTimer = setTimeout(() => {
        this._delayTimer = null;
        this._delayResolve = null;
        resolve();
      }, ms);
    });
  }
}
