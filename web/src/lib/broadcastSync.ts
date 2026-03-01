/**
 * BroadcastChannel-based sync between main window and PiP iframe.
 * Syncs input text and mic state so both views stay in sync.
 */

const CHANNEL_NAME = 'aigent-sync';

export type SyncMessage =
  | { type: 'input-text'; text: string }
  | { type: 'mic-state'; active: boolean }
  | { type: 'input-clear' };

let channel: BroadcastChannel | null = null;
const listeners = new Set<(msg: SyncMessage) => void>();

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e: MessageEvent<SyncMessage>) => {
      for (const fn of listeners) fn(e.data);
    };
  }
  return channel;
}

export function broadcastSync(msg: SyncMessage): void {
  getChannel().postMessage(msg);
}

export function onSyncMessage(fn: (msg: SyncMessage) => void): () => void {
  listeners.add(fn);
  getChannel(); // ensure channel is created
  return () => { listeners.delete(fn); };
}
