/**
 * Chat store — message management, streaming lifecycle,
 * thinking/tool trace state machines, and task upsert logic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chat';
import type { DisplayMessage, BackgroundTaskInfo, ClassifierMeta } from '../types';

function makeMsg(role: DisplayMessage['role'], content: string): DisplayMessage {
  return { role, content, timestamp: new Date().toISOString() };
}
function makeTask(id: string, status: BackgroundTaskInfo['status'] = 'running'): BackgroundTaskInfo {
  return { id, description: `Task ${id}`, status, startedAt: new Date().toISOString() };
}

describe('Chat store', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      tasks: [], streaming: {
        active: false, text: '', isThinking: false, thinkingText: '',
        currentToolOutput: '', currentToolImages: [], traces: [], turnStartCtx: 0,
      },
    });
  });

  it('setMessages replaces all messages', () => {
    const msgs = [makeMsg('user', 'hello'), makeMsg('assistant', 'hi')];
    useChatStore.getState().setMessages(msgs);
    expect(useChatStore.getState().messages).toEqual(msgs);
  });

  it('appendMessage adds to end', () => {
    useChatStore.getState().appendMessage(makeMsg('user', 'first'));
    useChatStore.getState().appendMessage(makeMsg('assistant', 'second'));
    expect(useChatStore.getState().messages).toHaveLength(2);
    expect(useChatStore.getState().messages[1]!.content).toBe('second');
  });

  it('appendMessage attaches traces when provided', () => {
    const traces = [{ id: 't1', type: 'thinking' as const, text: 'hmm', running: false }];
    useChatStore.getState().appendMessage(makeMsg('assistant', 'ok'), traces);
    expect(useChatStore.getState().messages[0]!.traces).toEqual(traces);
  });

  it('appendMessage omits traces when empty array', () => {
    useChatStore.getState().appendMessage(makeMsg('assistant', 'ok'), []);
    expect(useChatStore.getState().messages[0]!.traces).toBeUndefined();
  });

  it('clearMessages empties the list', () => {
    useChatStore.getState().appendMessage(makeMsg('user', 'x'));
    useChatStore.getState().clearMessages();
    expect(useChatStore.getState().messages).toEqual([]);
  });

  it('setUsage updates usage state', () => {
    const usage = { input: 100, output: 50, cacheRead: 25, cacheWrite: 10 };
    useChatStore.getState().setUsage(usage);
    expect(useChatStore.getState().usage).toEqual(usage);
  });

  it('upsertTask inserts a new task', () => {
    useChatStore.getState().upsertTask(makeTask('new'));
    expect(useChatStore.getState().tasks).toHaveLength(1);
  });

  it('upsertTask updates existing task by id', () => {
    useChatStore.getState().upsertTask(makeTask('t1', 'running'));
    useChatStore.getState().upsertTask(makeTask('t1', 'completed'));
    expect(useChatStore.getState().tasks).toHaveLength(1);
    expect(useChatStore.getState().tasks[0]!.status).toBe('completed');
  });

  it('upsertTask preserves other tasks on update', () => {
    useChatStore.getState().upsertTask(makeTask('t1'));
    useChatStore.getState().upsertTask(makeTask('t2'));
    useChatStore.getState().upsertTask(makeTask('t1', 'failed'));
    expect(useChatStore.getState().tasks).toHaveLength(2);
    expect(useChatStore.getState().tasks[0]!.status).toBe('failed');
  });

  it('startStream activates streaming with turnStartCtx', () => {
    useChatStore.getState().startStream(5000);
    const s = useChatStore.getState().streaming;
    expect(s.active).toBe(true);
    expect(s.turnStartCtx).toBe(5000);
    expect(s.traces).toEqual([]);
  });

  it('endStream deactivates but preserves traces', () => {
    useChatStore.getState().startStream(0);
    useChatStore.getState().startThinkingBlock();
    useChatStore.getState().endStream();
    const s = useChatStore.getState().streaming;
    expect(s.active).toBe(false);
    expect(s.traces).toHaveLength(1);
  });

  it('thinking block lifecycle: start -> append -> finalize', () => {
    useChatStore.getState().startStream(0);
    useChatStore.getState().startThinkingBlock();
    expect(useChatStore.getState().streaming.isThinking).toBe(true);
    expect(useChatStore.getState().streaming.traces[0]!.running).toBe(true);

    useChatStore.getState().appendThinkingText('Let me');
    useChatStore.getState().appendThinkingText(' think');
    expect(useChatStore.getState().streaming.thinkingText).toBe('Let me think');

    useChatStore.getState().finalizeThinkingBlock();
    expect(useChatStore.getState().streaming.isThinking).toBe(false);
    expect(useChatStore.getState().streaming.traces[0]!.running).toBe(false);
  });

  it('tool block lifecycle: start -> output -> images -> finalize', () => {
    useChatStore.getState().startStream(0);
    useChatStore.getState().startToolBlock('exec', 'Running ls', '{"command":"ls"}');
    expect(useChatStore.getState().streaming.traces[0]!.type).toBe('tool');

    useChatStore.getState().appendToolOutput('file1\n');
    useChatStore.getState().appendToolOutput('file2\n');
    expect(useChatStore.getState().streaming.currentToolOutput).toBe('file1\nfile2\n');

    useChatStore.getState().appendToolImages([{ mediaType: 'image/png', data: 'abc' }]);
    expect(useChatStore.getState().streaming.currentToolImages).toHaveLength(1);

    useChatStore.getState().finalizeToolBlock();
    const trace = useChatStore.getState().streaming.traces[0]!;
    expect(trace.running).toBe(false);
    if (trace.type === 'tool') {
      expect(trace.toolOutput).toBe('file1\nfile2\n');
      expect(trace.images).toHaveLength(1);
    }
  });

  it('finalizeToolBlock without images omits images field', () => {
    useChatStore.getState().startStream(0);
    useChatStore.getState().startToolBlock('grep', 'Searching', '{}');
    useChatStore.getState().appendToolOutput('match');
    useChatStore.getState().finalizeToolBlock();
    const trace = useChatStore.getState().streaming.traces[0]!;
    if (trace.type === 'tool') expect(trace.images).toBeUndefined();
  });

  it('setClassifierMeta attaches to last tool trace', () => {
    useChatStore.getState().startStream(0);
    useChatStore.getState().startToolBlock('exec', 'test1', '{}');
    useChatStore.getState().finalizeToolBlock();
    useChatStore.getState().startToolBlock('exec', 'test2', '{}');

    const meta: ClassifierMeta = { tier: 3, action: 'allow', reason: 'safe' };
    useChatStore.getState().setClassifierMeta(meta);

    const traces = useChatStore.getState().streaming.traces;
    if (traces[1]!.type === 'tool') expect(traces[1]!.classifierMeta).toEqual(meta);
    if (traces[0]!.type === 'tool') expect(traces[0]!.classifierMeta).toBeUndefined();
  });

  it('startToolBlock preserves accumulated streaming text', () => {
    // Regression: text was cleared to '' when a tool started, causing it to
    // visually disappear from the StreamingMessage component mid-stream.
    useChatStore.getState().startStream(0);
    useChatStore.getState().setStreamText('Here is what I found:');
    useChatStore.getState().startToolBlock('exec', 'Running ls', '{}');
    expect(useChatStore.getState().streaming.text).toBe('Here is what I found:');
  });

  it('cancel mid-tool: tool output is preserved when stream ends with a running tool', () => {
    // Regression: when cancel fires mid-tool, the tool output sitting in
    // currentToolOutput was never flushed into the trace. appendMessage received
    // traces where the last tool had running:true and toolOutput:''.
    useChatStore.getState().startStream(0);
    useChatStore.getState().startToolBlock('exec', 'Running ls', '{"command":"ls"}');
    useChatStore.getState().appendToolOutput('file1.txt\nfile2.txt\n');

    // Simulate what cancel should do: finalize the running tool before ending stream
    useChatStore.getState().finalizeToolBlock();
    const traces = useChatStore.getState().streaming.traces;
    useChatStore.getState().endStream();
    useChatStore.getState().appendMessage({
      id: 'msg1',
      role: 'assistant',
      content: '*(cancelled)*',
      timestamp: new Date().toISOString(),
      cancelled: true,
    }, traces);

    const msg = useChatStore.getState().messages[0]!;
    expect(msg.traces).toHaveLength(1);
    const trace = msg.traces![0]!;
    expect(trace.type).toBe('tool');
    if (trace.type === 'tool') {
      expect(trace.running).toBe(false);
      expect(trace.toolOutput).toBe('file1.txt\nfile2.txt\n');
    }
  });

  it('cancel mid-tool: WITHOUT fix, running tool trace has no output (documents the bug)', () => {
    // This test documents the bug: if finalizeToolBlock is NOT called before
    // reading traces, the tool output is lost.
    useChatStore.getState().startStream(0);
    useChatStore.getState().startToolBlock('exec', 'Running ls', '{"command":"ls"}');
    useChatStore.getState().appendToolOutput('file1.txt\nfile2.txt\n');

    // Bug: read traces WITHOUT finalizing — this is what the old code did
    const traces = useChatStore.getState().streaming.traces;
    useChatStore.getState().endStream();
    useChatStore.getState().appendMessage({
      id: 'msg1',
      role: 'assistant',
      content: '*(cancelled)*',
      timestamp: new Date().toISOString(),
      cancelled: true,
    }, traces);

    const msg = useChatStore.getState().messages[0]!;
    const trace = msg.traces![0]!;
    // Demonstrates the bug: tool is still running and output is empty
    if (trace.type === 'tool') {
      expect(trace.running).toBe(true);   // BUG: should be false after cancel
      expect(trace.toolOutput).toBe('');  // BUG: output was lost
    }
  });

  it('trace IDs are unique', () => {
    useChatStore.getState().startStream(0);
    useChatStore.getState().startThinkingBlock();
    useChatStore.getState().startToolBlock('exec', 'test', '{}');
    const ids = useChatStore.getState().streaming.traces.map(t => t.id);
    expect(new Set(ids).size).toBe(2);
  });
});
