/**
 * ws-handlers raw_turn — buffering and drain behaviour.
 *
 * raw_turn events arrive before the final message event.
 * They are buffered by messageId in the chat store and drained
 * into the DisplayMessage when finishStream is called.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../stores/chat';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { handlers } from '../hooks/ws-handlers';
import type { WsDeps } from '../hooks/ws-handlers';
import type { RawTurnData } from '../types';

function makeDeps(): WsDeps {
  return {
    send: vi.fn(),
    chat: useChatStore.getState,
    conn: vi.fn() as unknown as WsDeps['conn'],
    ui: useUIStore.getState,
    settings: (() => ({ getClientSetting: () => undefined })) as unknown as WsDeps['settings'],
    voice: useVoiceStore.getState,
    reconnectAttempt: { current: 0 },
  };
}

function makeRawTurn(overrides: Partial<RawTurnData> = {}): RawTurnData {
  return {
    iteration: 1,
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    contentBlocks: [{ type: 'text', text: 'Hello.' }],
    provider: 'anthropic',
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  useChatStore.setState({
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tasks: [],
    taskHistory: [],
    streaming: {
      active: false, text: '', spokenText: null, isThinking: false, thinkingText: '',
      currentToolOutput: '', currentToolImages: [], traces: [], turnStartCtx: 0,
    },
    rawTurnBuffer: new Map(),
  });
});

describe('raw_turn handler', () => {
  it('buffers a raw turn keyed by messageId', () => {
    const deps = makeDeps();
    const turn = makeRawTurn();
    handlers.raw_turn!({ type: 'raw_turn', messageId: 'msg-1', turn }, deps);
    const buf = useChatStore.getState().rawTurnBuffer;
    expect(buf.get('msg-1')).toHaveLength(1);
    expect(buf.get('msg-1')![0]).toEqual(turn);
  });

  it('accumulates multiple raw turns for the same messageId', () => {
    const deps = makeDeps();
    handlers.raw_turn!({ type: 'raw_turn', messageId: 'msg-1', turn: makeRawTurn({ iteration: 1 }) }, deps);
    handlers.raw_turn!({ type: 'raw_turn', messageId: 'msg-1', turn: makeRawTurn({ iteration: 2 }) }, deps);
    expect(useChatStore.getState().rawTurnBuffer.get('msg-1')).toHaveLength(2);
  });

  it('buffers turns for different messageIds independently', () => {
    const deps = makeDeps();
    handlers.raw_turn!({ type: 'raw_turn', messageId: 'msg-a', turn: makeRawTurn() }, deps);
    handlers.raw_turn!({ type: 'raw_turn', messageId: 'msg-b', turn: makeRawTurn() }, deps);
    const buf = useChatStore.getState().rawTurnBuffer;
    expect(buf.get('msg-a')).toHaveLength(1);
    expect(buf.get('msg-b')).toHaveLength(1);
  });
});

describe('drainRawTurns', () => {
  it('returns buffered turns for a messageId', () => {
    const turn = makeRawTurn();
    useChatStore.getState().bufferRawTurn('msg-1', turn);
    const drained = useChatStore.getState().drainRawTurns('msg-1');
    expect(drained).toHaveLength(1);
    expect(drained[0]).toEqual(turn);
  });

  it('removes the entry after draining', () => {
    useChatStore.getState().bufferRawTurn('msg-1', makeRawTurn());
    useChatStore.getState().drainRawTurns('msg-1');
    expect(useChatStore.getState().rawTurnBuffer.get('msg-1')).toBeUndefined();
  });

  it('returns empty array for unknown messageId', () => {
    const drained = useChatStore.getState().drainRawTurns('msg-unknown');
    expect(drained).toHaveLength(0);
  });
});

describe('message handler attaches raw turns', () => {
  it('attaches buffered raw turns to the finished message', () => {
    const deps = makeDeps();
    const msgId = 'msg-1';
    const turn = makeRawTurn();

    // Buffer a raw turn
    useChatStore.getState().bufferRawTurn(msgId, turn);

    // Start a stream so the message handler enters the active-stream branch
    useChatStore.getState().startStream(0);

    handlers.message!({
      type: 'message',
      message: {
        id: msgId,
        role: 'assistant',
        content: 'Hello.',
        timestamp: new Date().toISOString(),
      },
    }, deps);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.rawTurns).toHaveLength(1);
    expect(messages[0]!.rawTurns![0]).toEqual(turn);
  });

  it('leaves message without rawTurns when buffer is empty', () => {
    const deps = makeDeps();
    useChatStore.getState().startStream(0);

    handlers.message!({
      type: 'message',
      message: {
        id: 'msg-2',
        role: 'assistant',
        content: 'Hello.',
        timestamp: new Date().toISOString(),
      },
    }, deps);

    const msg = useChatStore.getState().messages[0]!;
    expect(msg.rawTurns).toBeUndefined();
  });

  it('buffer is empty after message handler drains it', () => {
    const deps = makeDeps();
    useChatStore.getState().bufferRawTurn('msg-3', makeRawTurn());
    useChatStore.getState().startStream(0);

    handlers.message!({
      type: 'message',
      message: { id: 'msg-3', role: 'assistant', content: 'Hi.', timestamp: new Date().toISOString() },
    }, deps);

    expect(useChatStore.getState().rawTurnBuffer.get('msg-3')).toBeUndefined();
  });
});
