import type { ServerEvent } from '../types';

export type DemoStep =
  | { action: 'wait'; ms: number }
  | { action: 'emit'; event: ServerEvent }
  | { action: 'type_input'; text: string; charDelayMs: number }
  | { action: 'submit_input' }
  | { action: 'auto_approve'; delayMs: number }
  | { action: 'stream_text'; text: string; chunkSize: number; intervalMs: number }
  | { action: 'stream_thinking'; text: string; chunkSize: number; intervalMs: number }
  | { action: 'loop' };

export interface DemoScenario {
  name: string;
  steps: DemoStep[];
}
