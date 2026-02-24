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

  /** No-op — demo doesn't process client messages */
  send(_data: string): void {}

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}
