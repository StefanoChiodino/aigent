import type { DemoStep, DemoScenario } from './types';
import type { MockWebSocket } from './MockWebSocket';
import { useUIStore } from '../stores/ui';
import { useChatStore } from '../stores/chat';
import { useVoiceStore } from '../stores/voice';

/**
 * Walks through a DemoScenario step-by-step, emitting ServerEvents
 * through the MockWebSocket and orchestrating UI interactions
 * (typing animation, permission auto-approval, loop resets).
 */
export class DemoPlaybackEngine {
  private scenario: DemoScenario;
  private mockWs: MockWebSocket;
  private aborted = false;

  constructor(scenario: DemoScenario, mockWs: MockWebSocket) {
    this.scenario = scenario;
    this.mockWs = mockWs;
  }

  async play(): Promise<void> {
    for (const step of this.scenario.steps) {
      if (this.aborted) return;
      await this.executeStep(step);
    }
  }

  stop(): void {
    this.aborted = true;
  }

  private async executeStep(step: DemoStep): Promise<void> {
    switch (step.action) {
      case 'wait':
        await this.delay(step.ms);
        break;

      case 'emit':
        this.mockWs.emit(step.event);
        break;

      case 'type_input':
        await this.animateTyping(step.text, step.charDelayMs);
        break;

      case 'submit_input':
        window.dispatchEvent(new Event('__demo_submit_input'));
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

      case 'loop':
        await this.loopReset();
        if (!this.aborted) await this.play();
        break;
    }
  }

  private setModal(modal: 'settings' | 'shortcuts' | 'context', open: boolean): void {
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
      if (this.aborted) return;
      current += char;
      window.dispatchEvent(new CustomEvent('__demo_set_input', { detail: current }));
      // Vary delay slightly for realism
      await this.delay(charDelayMs + Math.random() * charDelayMs * 0.5);
    }
  }

  /**
   * Stream text events with accumulated content.
   * handleEvent 'text' calls setStreamText (replaces), so we send the full
   * accumulated string each time, not deltas.
   */
  private async streamText(text: string, chunkSize: number, intervalMs: number): Promise<void> {
    for (let i = chunkSize; i <= text.length; i += chunkSize) {
      if (this.aborted) return;
      const accumulated = text.slice(0, i);
      this.mockWs.emit({ type: 'text', content: accumulated });
      await this.delay(intervalMs);
    }
    // Emit final full text if not aligned to chunkSize
    if (text.length % chunkSize !== 0) {
      this.mockWs.emit({ type: 'text', content: text });
      await this.delay(intervalMs);
    }
  }

  /**
   * Stream thinking events as deltas.
   * handleEvent 'thinking' calls appendThinkingText (appends), so we send
   * incremental chunks.
   */
  private async streamThinking(text: string, chunkSize: number, intervalMs: number): Promise<void> {
    for (let i = 0; i < text.length; i += chunkSize) {
      if (this.aborted) return;
      const chunk = text.slice(i, i + chunkSize);
      this.mockWs.emit({ type: 'thinking', content: chunk });
      await this.delay(intervalMs);
    }
  }

  /** Directly dequeue the top permission request from the UI store */
  private autoApprovePermission(): void {
    const { permQueue } = useUIStore.getState();
    if (permQueue.length === 0) return;
    const next = permQueue.slice(1);
    useUIStore.setState({ permQueue: next, permShowing: next.length > 0 });
  }

  /** Fade out, reset stores, pause, then caller replays */
  private async loopReset(): Promise<void> {
    // Fade out
    document.getElementById('app')?.classList.add('demo-fade');
    await this.delay(1000);

    // Reset stores
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
    speechSynthesis.cancel();

    // Fade back in
    document.getElementById('app')?.classList.remove('demo-fade');
    await this.delay(3000);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
