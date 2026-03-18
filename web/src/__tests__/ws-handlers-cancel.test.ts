/**
 * Regression test: cancel mid-tool-call must preserve tool output in traces.
 *
 * Bug: when the user cancelled while a tool was running, the tool output sitting
 * in currentToolOutput was never flushed into the trace. The loading handler read
 * streaming.traces before finalizing the running tool, so the cancelled message
 * received traces where the last tool had running:true and toolOutput:''.
 *
 * Fix: the loading handler now calls finalizeToolBlock() (and finalizeThinkingBlock())
 * before reading traces in the cancel path.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from '../stores/chat';
import { useUIStore } from '../stores/ui';
import { useVoiceStore } from '../stores/voice';
import { handlers } from '../hooks/ws-handlers';
import type { WsDeps } from '../hooks/ws-handlers';

function makeDeps(): WsDeps {
  return {
    send: vi.fn(),
    chat: useChatStore.getState,
    conn: vi.fn() as unknown as WsDeps['conn'],
    ui: useUIStore.getState,
    settings: vi.fn() as unknown as WsDeps['settings'],
    voice: useVoiceStore.getState,
    reconnectAttempt: { current: 0 },
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
  });
  useUIStore.setState({ isLoading: false, error: null });
});

describe('ws-handlers loading (cancel)', () => {
  it('cancel mid-tool preserves tool output in the saved message traces', () => {
    const deps = makeDeps();

    // Simulate a tool call in progress
    useChatStore.getState().startStream(0);
    useChatStore.getState().startToolBlock('exec', 'Running ls', '{"command":"ls"}');
    useChatStore.getState().appendToolOutput('file1.txt\nfile2.txt\n');

    // Fire cancel (loading=false) — this is what the server sends on cancel
    handlers.loading!({ type: 'loading', isLoading: false }, deps);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);

    const msg = messages[0]!;
    expect(msg.cancelled).toBe(true);
    expect(msg.traces).toHaveLength(1);

    const trace = msg.traces![0]!;
    expect(trace.type).toBe('tool');
    if (trace.type === 'tool') {
      expect(trace.running).toBe(false);        // must be finalized
      expect(trace.toolOutput).toBe('file1.txt\nfile2.txt\n'); // output must be preserved
    }
  });

  it('cancel with thinking in progress finalizes the thinking block', () => {
    const deps = makeDeps();

    useChatStore.getState().startStream(0);
    useChatStore.getState().startThinkingBlock();
    useChatStore.getState().appendThinkingText('I should think about this');

    handlers.loading!({ type: 'loading', isLoading: false }, deps);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);

    const trace = messages[0]!.traces![0]!;
    expect(trace.type).toBe('thinking');
    if (trace.type === 'thinking') {
      expect(trace.running).toBe(false);               // must be finalized
      expect(trace.text).toBe('I should think about this');
    }
  });

  it('cancel with both thinking and tool preserves both traces', () => {
    const deps = makeDeps();

    useChatStore.getState().startStream(0);
    useChatStore.getState().startThinkingBlock();
    useChatStore.getState().appendThinkingText('hmm');
    useChatStore.getState().finalizeThinkingBlock();
    useChatStore.getState().startToolBlock('read_file', 'Reading', '{"path":"/foo"}');
    useChatStore.getState().appendToolOutput('contents here\n');

    handlers.loading!({ type: 'loading', isLoading: false }, deps);

    const msg = useChatStore.getState().messages[0]!;
    expect(msg.traces).toHaveLength(2);
    const toolTrace = msg.traces!.find(t => t.type === 'tool')!;
    if (toolTrace.type === 'tool') {
      expect(toolTrace.running).toBe(false);
      expect(toolTrace.toolOutput).toBe('contents here\n');
    }
  });

  it('normal completion (loading=false with no active stream) does not create a message', () => {
    const deps = makeDeps();
    // No stream started — nothing to cancel
    handlers.loading!({ type: 'loading', isLoading: false }, deps);
    expect(useChatStore.getState().messages).toHaveLength(0);
  });
});
