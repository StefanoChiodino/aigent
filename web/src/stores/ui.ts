import { create } from 'zustand';
import type { PermRequest, MountInfo, ContextBreakdown, PendingAttachment } from '../types';

interface UIState {
  errorMsg: string | null;
  isLoading: boolean;
  permQueue: PermRequest[];
  permShowing: boolean;
  modelPickerOpen: boolean;
  settingsOpen: boolean;
  shortcutsOpen: boolean;
  ctxInspectorOpen: boolean;
  mountsList: MountInfo[];
  capsList: Record<string, { grant: string; available: boolean }>;
  ttsAvailable: boolean;
  sttAvailable: boolean;
  modelName: string;
  availableModels: string[];
  availableTools: string[];
  shortMode: boolean;
  thinkingLevel: string;
  lastEffortLevel: string;
  contextBreakdown: ContextBreakdown | null;
  pendingAttachments: PendingAttachment[];
  taskResultTask: import('../types').BackgroundTaskInfo | null;

  setError: (msg: string | null) => void;
  setLoading: (loading: boolean) => void;
  enqueuePermRequest: (req: PermRequest) => void;
  resolvePermRequest: (send: (data: Record<string, unknown>) => void, approve: boolean, alwaysAllow?: boolean, alwaysDomain?: boolean) => void;
  resolveQuestionRequest: (send: (data: Record<string, unknown>) => void, answer: string, selectedOptions?: string[], dismissed?: boolean) => void;
  setModelPickerOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setCtxInspectorOpen: (open: boolean) => void;
  setMounts: (mounts: MountInfo[]) => void;
  setCaps: (caps: Record<string, { grant: string; available: boolean }>) => void;
  setTtsAvailable: (v: boolean) => void;
  setSttAvailable: (v: boolean) => void;
  setModelName: (name: string) => void;
  setAvailableModels: (models: string[]) => void;
  setAvailableTools: (tools: string[]) => void;
  setShortMode: (on: boolean) => void;
  setThinkingLevel: (level: string) => void;
  setContextBreakdown: (bd: ContextBreakdown | null) => void;
  addAttachment: (att: PendingAttachment) => void;
  removeAttachment: (id: string) => void;
  clearAttachments: () => void;
  setTaskResultTask: (task: import('../types').BackgroundTaskInfo | null) => void;
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
  mountsList: [],
  capsList: {},
  ttsAvailable: false,
  sttAvailable: false,
  modelName: '',
  availableModels: [],
  availableTools: [],
  shortMode: false,
  thinkingLevel: 'high',
  lastEffortLevel: 'high',
  contextBreakdown: null,
  pendingAttachments: [],
  taskResultTask: null,

  setError: (msg) => set({ errorMsg: msg }),
  setLoading: (loading) => set({ isLoading: loading }),

  enqueuePermRequest: (req) => set(s => {
    const queue = [...s.permQueue, req];
    return { permQueue: queue, permShowing: true };
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
  setMounts: (mounts) => set({ mountsList: mounts }),
  setCaps: (caps) => set({ capsList: caps }),
  setTtsAvailable: (v) => set({ ttsAvailable: v }),
  setSttAvailable: (v) => set({ sttAvailable: v }),
  setModelName: (name) => set({ modelName: name }),
  setAvailableModels: (models) => set({ availableModels: models }),
  setAvailableTools: (tools) => set({ availableTools: tools }),
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
}));
