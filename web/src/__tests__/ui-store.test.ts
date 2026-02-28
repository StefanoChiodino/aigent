/**
 * UI store — permission queue, modal state, thinking level, attachments.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIStore } from '../stores/ui';
import type { PermRequest, PendingAttachment } from '../types';

function makePermReq(overrides: Partial<PermRequest> = {}): PermRequest {
  return {
    type: 'exec', id: 'perm-' + Math.random().toString(36).slice(2),
    title: 'Execute', detail: 'echo hello',
    approveCmd: '/approve-exec abc', denyCmd: '/deny-exec abc', ...overrides,
  };
}
function makeAttachment(id: string): PendingAttachment {
  return { id, name: id + '.txt', mediaType: 'text/plain', data: 'aGVsbG8=', size: 5 };
}

describe('UI store', () => {
  beforeEach(() => {
    useUIStore.setState({
      errorMsg: null, isLoading: false, permQueue: [], permShowing: false,
      modelPickerOpen: false, settingsOpen: false, shortcutsOpen: false,
      ctxInspectorOpen: false, capsList: {},
      ttsAvailable: false, sttAvailable: false, modelName: '',
      availableModels: [], availableTools: [], shortMode: false,
      thinkingLevel: 'high', lastEffortLevel: 'high',
      contextBreakdown: null, pendingAttachments: [], taskResultTask: null,
      traceInspectorTrace: null,
    });
  });

  it('setError sets and clears', () => {
    useUIStore.getState().setError('broken');
    expect(useUIStore.getState().errorMsg).toBe('broken');
    useUIStore.getState().setError(null);
    expect(useUIStore.getState().errorMsg).toBeNull();
  });

  it('enqueuePermRequest adds and shows modal', () => {
    useUIStore.getState().enqueuePermRequest(makePermReq());
    expect(useUIStore.getState().permQueue).toHaveLength(1);
    expect(useUIStore.getState().permShowing).toBe(true);
  });

  it('dismissPermRequests removes by id and hides when empty', () => {
    useUIStore.getState().enqueuePermRequest(makePermReq({ id: 'a' }));
    useUIStore.getState().enqueuePermRequest(makePermReq({ id: 'b' }));
    useUIStore.getState().dismissPermRequests(['a']);
    expect(useUIStore.getState().permQueue).toHaveLength(1);
    useUIStore.getState().dismissPermRequests(['b']);
    expect(useUIStore.getState().permShowing).toBe(false);
  });

  it('resolvePermRequest approves with approveCmd', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ approveCmd: '/approve foo' }));
    useUIStore.getState().resolvePermRequest(send, true);
    expect(send).toHaveBeenCalledWith({ type: 'command', cmd: '/approve foo' });
  });

  it('resolvePermRequest denies with denyCmd', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ denyCmd: '/deny bar' }));
    useUIStore.getState().resolvePermRequest(send, false);
    expect(send).toHaveBeenCalledWith({ type: 'command', cmd: '/deny bar' });
  });

  it('resolvePermRequest uses alwaysAllowCmd', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ alwaysAllowCmd: '/always x' }));
    useUIStore.getState().resolvePermRequest(send, true, true);
    expect(send).toHaveBeenCalledWith({ type: 'command', cmd: '/always x' });
  });

  it('resolvePermRequest uses alwaysAllowDomainCmd', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ alwaysAllowDomainCmd: '/domain x' }));
    useUIStore.getState().resolvePermRequest(send, true, false, true);
    expect(send).toHaveBeenCalledWith({ type: 'command', cmd: '/domain x' });
  });

  it('resolvePermRequest does nothing on empty queue', () => {
    const send = vi.fn();
    useUIStore.getState().resolvePermRequest(send, true);
    expect(send).not.toHaveBeenCalled();
  });

  it('resolvePermRequest processes FIFO', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ approveCmd: '/first' }));
    useUIStore.getState().enqueuePermRequest(makePermReq({ approveCmd: '/second' }));
    useUIStore.getState().resolvePermRequest(send, true);
    expect(send).toHaveBeenCalledWith({ type: 'command', cmd: '/first' });
    useUIStore.getState().resolvePermRequest(send, true);
    expect(send).toHaveBeenLastCalledWith({ type: 'command', cmd: '/second' });
  });

  it('resolveQuestionRequest sends answer', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ type: 'user_question', id: 'q1' }));
    useUIStore.getState().resolveQuestionRequest(send, 'yes');
    expect(send).toHaveBeenCalledWith({
      type: 'user_question_response', id: 'q1', answer: 'yes', dismissed: false,
    });
  });

  it('resolveQuestionRequest skips non-question requests', () => {
    const send = vi.fn();
    useUIStore.getState().enqueuePermRequest(makePermReq({ type: 'exec' }));
    useUIStore.getState().resolveQuestionRequest(send, 'answer');
    expect(send).not.toHaveBeenCalled();
  });

  it('setThinkingLevel updates level and preserves lastEffortLevel', () => {
    useUIStore.getState().setThinkingLevel('medium');
    expect(useUIStore.getState().thinkingLevel).toBe('medium');
    expect(useUIStore.getState().lastEffortLevel).toBe('medium');
  });

  it('setThinkingLevel to off keeps previous lastEffortLevel', () => {
    useUIStore.getState().setThinkingLevel('high');
    useUIStore.getState().setThinkingLevel('off');
    expect(useUIStore.getState().thinkingLevel).toBe('off');
    expect(useUIStore.getState().lastEffortLevel).toBe('high');
  });

  it('addAttachment/removeAttachment/clearAttachments', () => {
    useUIStore.getState().addAttachment(makeAttachment('a'));
    useUIStore.getState().addAttachment(makeAttachment('b'));
    expect(useUIStore.getState().pendingAttachments).toHaveLength(2);
    useUIStore.getState().removeAttachment('a');
    expect(useUIStore.getState().pendingAttachments).toHaveLength(1);
    useUIStore.getState().clearAttachments();
    expect(useUIStore.getState().pendingAttachments).toEqual([]);
  });

  it('setAvailableModels/setAvailableTools update lists', () => {
    useUIStore.getState().setAvailableModels(['claude-3', 'gpt-4']);
    useUIStore.getState().setAvailableTools(['exec', 'read_file']);
    expect(useUIStore.getState().availableModels).toEqual(['claude-3', 'gpt-4']);
    expect(useUIStore.getState().availableTools).toEqual(['exec', 'read_file']);
  });

  it('traceInspectorTrace starts null', () => {
    expect(useUIStore.getState().traceInspectorTrace).toBeNull();
  });

  it('setTraceInspectorTrace sets and clears trace', () => {
    const trace = { id: 't1', type: 'thinking' as const, text: 'thinking...', running: false };
    useUIStore.getState().setTraceInspectorTrace(trace);
    expect(useUIStore.getState().traceInspectorTrace).toEqual(trace);
    useUIStore.getState().setTraceInspectorTrace(null);
    expect(useUIStore.getState().traceInspectorTrace).toBeNull();
  });

  it('setTraceInspectorTrace works with tool traces', () => {
    const trace = {
      id: 't2', type: 'tool' as const, toolName: 'exec', toolSummary: '$ ls',
      toolInput: '{"command":"ls"}', toolOutput: 'file.txt', running: false,
    };
    useUIStore.getState().setTraceInspectorTrace(trace);
    const stored = useUIStore.getState().traceInspectorTrace;
    expect(stored?.type).toBe('tool');
    if (stored?.type === 'tool') expect(stored.toolName).toBe('exec');
  });
});
