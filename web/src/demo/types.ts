import type { ServerEvent, PendingAttachment } from '../types';

export type DemoStep =
  | { action: 'wait'; ms: number }
  | { action: 'emit'; event: ServerEvent }
  | { action: 'type_input'; text: string; charDelayMs: number }
  | { action: 'submit_input' }
  | { action: 'auto_approve'; delayMs: number }
  | { action: 'stream_text'; text: string; chunkSize: number; intervalMs: number }
  | { action: 'stream_thinking'; text: string; chunkSize: number; intervalMs: number }
  | { action: 'open_modal'; modal: 'settings' | 'shortcuts' | 'context' }
  | { action: 'close_modal'; modal: 'settings' | 'shortcuts' | 'context' }
  | { action: 'set_mic'; state: 'idle' | 'recording' | 'transcribing'; vadActive?: boolean }
  | { action: 'add_attachment'; attachment: PendingAttachment }
  | { action: 'clear_attachments' }
  | { action: 'set_tts_auto'; on: boolean }
  | { action: 'set_short'; on: boolean }
  | { action: 'play_audio'; src: string }
  | { action: 'click'; selector: string }
  | { action: 'set_theme'; theme: string }
  | { action: 'label'; text: string; id?: string }
  | { action: 'loop' };

export interface DemoScenario {
  name: string;
  steps: DemoStep[];
}
