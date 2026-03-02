import { create } from 'zustand';
import type { PermRequest, ContextBreakdown, PendingAttachment, TraceEntry, QueuedMessageInfo } from '../types';

interface UIState {
  errorMsg: string | null;
  isLoading: boolean;
  permQueue: PermRequest[];
  permShowing: boolean;
  modelPickerOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  ctxInspectorOpen: boolean;
  tasksInspectorOpen: boolean;
  capsList: Record<string, { grant: string; available: boolean }>;
  ttsAvailable: boolean;
  sttAvailable: boolean;
  extensionConnected: boolean;
  extensionPath: string;
  modelName: string;
  availableModels: string[];
  modelsWithoutThinking: string[];
  modelTiers: { flash: string; pro: string; ultra: string };
  availableTools: string[];
  contextWindow: number;
  shortMode: boolean;
  thinkingLevel: string;
  lastEffortLevel: string;
  contextBreakdown: ContextBreakdown | null;
  pendingAttachments: PendingAttachment[];
  taskResultTask: import('../types').BackgroundTaskInfo | null;
  traceInspectorTrace: TraceEntry | null;
  queuedMessages: QueuedMessageInfo[];

  setError: (msg: string | null) => void;
  setLoading: (loading: boolean) => void;
  enqueuePermRequest: (req: PermRequest) => void;
  dismissPermRequests: (ids: string[]) => void;
  resolvePermRequest: (send: (data: Record<string, unknown>) => void, approve: boolean, alwaysAllow?: boolean, alwaysDomain?: boolean) => void;
  resolveQuestionRequest: (send: (data: Record<string, unknown>) => void, answer: string, selectedOptions?: string[], dismissed?: boolean) => void;
  setModelPickerOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setCtxInspectorOpen: (open: boolean) => void;
  setTasksInspectorOpen: (open: boolean) => void;
  setCaps: (caps: Record<string, { grant: string; available: boolean }>) => void;
  setTtsAvailable: (v: boolean) => void;
  setSttAvailable: (v: boolean) => void;
  setExtensionConnected: (v: boolean) => void;
  setExtensionPath: (v: string) => void;
  setModelName: (name: string) => void;
  setAvailableModels: (models: string[]) => void;
  setModelsWithoutThinking: (models: string[]) => void;
  setModelTiers: (tiers: { flash: string; pro: string; ultra: string }) => void;
  setAvailableTools: (tools: string[]) => void;
  setContextWindow: (n: number) => void;
  setShortMode: (on: boolean) => void;
  setThinkingLevel: (level: string) => void;
  setContextBreakdown: (bd: ContextBreakdown | null) => void;
  addAttachment: (att: PendingAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setTaskResultTask: (task: import('../types').BackgroundTaskInfo | null) => void;
  setTraceInspectorTrace: (trace: TraceEntry | null) => void;
  setQueuedMessages: (queue: QueuedMessageInfo[]) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  errorMsg: null,
  isLoading: false,
  permQueue: [],
  permShowing: false,
  modelPickerOpen: false,
  settingsOpen: false,
  shortcutsOpen: false,
  ctxInspectorOpen: false,
  tasksInspectorOpen: false,
  capsList: {},
  ttsAvailable: false,
  sttAvailable: false,
  extensionConnected: false,
  extensionPath: '',
  modelName: '',
  availableModels: [],
  modelsWithoutThinking: [],
  modelTiers: { flash: '', pro: '', ultra: '' },
  availableTools: [],
  contextWindow: 200_000,
  shortMode: false,
  thinkingLevel: 'high',
  lastEffortLevel: 'high',
  contextBreakdown: null,
  pendingAttachments: [],
  taskResultTask: null,
  traceInspectorTrace: null,
  queuedMessages: [],

  setError: (msg) => set({ errorMsg: msg }),
  setLoading: (loading) => set({ isLoading: loading }),

  enqueuePermRequest: (req) => set(s => {
    if (s.permQueue.some(r => r.id === req.id)) return s;
    const queue = [...s.permQueue, req];
    return { permQueue: queue, permShowing: true };
  }),

  dismissPermRequests: (ids) => set(s => {
    const idSet = new Set(ids);
    const queue = s.permQueue.filter(r => !idSet.has(r.id));
    return { permQueue: queue, permShowing: queue.length > 0 };
  }),

  resolvePermRequest: (send, approve, alwaysAllow = false, alwaysDomain = false) => {
    let resolved: PermRequest | null = null;
    set(s => {
      const req = s.permQueue[0];
      if (!req) return s;
      resolved = req;
      const next = s.permQueue.slice(1);
      return { permQueue: next, permShowing: next.length > 0 };
    });
    if (!resolved) return;
    const req = resolved;
    if (approve) {
      const cmd = alwaysDomain && req.alwaysAllowDomainCmd
        ? req.alwaysAllowDomainCmd
        : alwaysAllow && req.alwaysAllowCmd
          ? req.alwaysAllowCmd
          : req.approveCmd;
      send({ type: 'command', cmd });
    } else {
      send({ type: 'command', cmd: req.denyCmd });
    }
  },

  resolveQuestionRequest: (send, answer, selectedOptions, dismissed = false) => {
    let resolved: PermRequest | null = null;
    set(s => {
      const req = s.permQueue[0];
      if (!req || req.type !== 'user_question') return s;
      resolved = req;
      const next = s.permQueue.slice(1);
      return { permQueue: next, permShowing: next.length > 0 };
    });
    if (!resolved) return;
    send({
      type: 'user_question_response',
      id: (resolved as PermRequest).id,
      answer,
      ...(selectedOptions ? { selectedOptions } : {}),
      dismissed,
    });
  },

  setModelPickerOpen: (open) => set({ modelPickerOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setCtxInspectorOpen: (open) => set({ ctxInspectorOpen: open }),
  setTasksInspectorOpen: (open) => set({ tasksInspectorOpen: open }),
  setCaps: (caps) => set({ capsList: caps }),
  setTtsAvailable: (v) => set({ ttsAvailable: v }),
  setSttAvailable: (v) => set({ sttAvailable: v }),
  setExtensionConnected: (v) => set({ extensionConnected: v }),
  setExtensionPath: (v) => set({ extensionPath: v }),
  setModelName: (name) => set({ modelName: name }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setModelsWithoutThinking: (models) => set({ modelsWithoutThinking: models }),
  setModelTiers: (tiers) => set({ modelTiers: tiers }),
  setAvailableTools: (tools) => set({ availableTools: tools }),
  setContextWindow: (n) => set({ contextWindow: n }),
  setShortMode: (on) => set({ shortMode: on }),
  setThinkingLevel: (level) => set(s => ({
    thinkingLevel: level,
    lastEffortLevel: level !== 'off' ? level : s.lastEffortLevel,
  })),
  setContextBreakdown: (bd) => set({ contextBreakdown: bd }),
  addAttachment: (att) => set(s => ({ pendingAttachments: [...s.pendingAttachments, att] })),
  removeAttachment: (id) => set(s => ({ pendingAttachments: s.pendingAttachments.filter(a => a.id !== id) })),
  clearAttachments: () => set({ pendingAttachments: [] }),
  setTaskResultTask: (task) => set({ taskResultTask: task }),
  setTraceInspectorTrace: (trace) => set({ traceInspectorTrace: trace }),
  setQueuedMessages: (queue) => set({ queuedMessages: queue }),
}));
