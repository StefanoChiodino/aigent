import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DisplayMessage, TokenUsage, BackgroundTaskInfo, TraceEntry, ClassifierMeta } from '../types';

interface StreamingState {
  active: boolean;
  text: string;
  isThinking: boolean;
  thinkingText: string;
  currentToolOutput: string;
  currentToolImages: { mediaType: string; data: string }[];
  traces: TraceEntry[];
  turnStartCtx: number;
}

interface ChatState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  tasks: BackgroundTaskInfo[];
  taskHistory: BackgroundTaskInfo[];
  streaming: StreamingState;

  setMessages: (msgs: DisplayMessage[]) => void;
  appendMessage: (msg: DisplayMessage, traces?: TraceEntry[]) => void;
  setUsage: (usage: TokenUsage) => void;
  setTasks: (tasks: BackgroundTaskInfo[]) => void;
  upsertTask: (task: BackgroundTaskInfo) => void;
  upsertTaskHistory: (task: BackgroundTaskInfo) => void;
  clearMessages: () => void;
  clearTaskHistory: () => void;

  // Streaming actions
  startStream: (turnStartCtx: number) => void;
  endStream: () => void;
  setStreamText: (text: string) => void;

  startThinkingBlock: () => void;
  appendThinkingText: (text: string) => void;
  finalizeThinkingBlock: () => void;

  startToolBlock: (name: string, summary: string, input: string, model?: string, thinking?: string) => void;
  appendToolOutput: (content: string) => void;
  appendToolImages: (images: { mediaType: string; data: string }[]) => void;
  finalizeToolBlock: () => void;
  setClassifierMeta: (meta: ClassifierMeta) => void;
}

let traceIdCounter = 0;

const INITIAL_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const INITIAL_STREAMING: StreamingState = {
  active: false, text: '', isThinking: false, thinkingText: '',
  currentToolOutput: '', currentToolImages: [], traces: [], turnStartCtx: 0,
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      usage: INITIAL_USAGE,
      tasks: [],
      taskHistory: [],
      streaming: INITIAL_STREAMING,

      setMessages: (msgs) => set({ messages: msgs }),
      appendMessage: (msg, traces?) => set(s => ({
        messages: [...s.messages, traces && traces.length > 0 ? { ...msg, traces } : msg],
      })),
      setUsage: (usage) => set({ usage }),
      setTasks: (tasks) => set({ tasks }),
      upsertTask: (task) => set(s => {
        const idx = s.tasks.findIndex(t => t.id === task.id);
        if (idx >= 0) {
          const next = [...s.tasks];
          next[idx] = task;
          return { tasks: next };
        }
        return { tasks: [...s.tasks, task] };
      }),
      upsertTaskHistory: (task) => set(s => {
        const idx = s.taskHistory.findIndex(t => t.id === task.id);
        if (idx >= 0) {
          const next = [...s.taskHistory];
          next[idx] = { ...next[idx], ...task };
          return { taskHistory: next };
        }
        return { taskHistory: [...s.taskHistory, task] };
      }),
      clearMessages: () => set({ messages: [] }),
      clearTaskHistory: () => set({ taskHistory: [] }),

      startStream: (turnStartCtx) => set({
        streaming: { ...INITIAL_STREAMING, active: true, turnStartCtx },
      }),
      endStream: () => set(s => ({ streaming: { ...s.streaming, active: false, isThinking: false } })),
      setStreamText: (text) => set(s => ({ streaming: { ...s.streaming, text } })),

      startThinkingBlock: () => set(s => {
        const id = `trace-${++traceIdCounter}`;
        return {
          streaming: {
            ...s.streaming,
            isThinking: true,
            thinkingText: '',
            traces: [...s.streaming.traces, { id, type: 'thinking', text: '', running: true }],
          },
        };
      }),
      appendThinkingText: (content) => set(s => {
        const newText = s.streaming.thinkingText + content;
        const traces = s.streaming.traces.map(t =>
          t.type === 'thinking' && t.running ? { ...t, text: newText } : t
        );
        return { streaming: { ...s.streaming, thinkingText: newText, traces } };
      }),
      finalizeThinkingBlock: () => set(s => {
        const traces = s.streaming.traces.map(t =>
          t.type === 'thinking' && t.running ? { ...t, running: false } : t
        );
        return { streaming: { ...s.streaming, isThinking: false, thinkingText: '', traces } };
      }),

      startToolBlock: (name, summary, input, model, thinking) => set(s => {
        const id = `trace-${++traceIdCounter}`;
        return {
          streaming: {
            ...s.streaming,
            text: '',
            currentToolOutput: '',
            currentToolImages: [],
            traces: [...s.streaming.traces, {
              id, type: 'tool', toolName: name, toolSummary: summary,
              toolInput: input, toolOutput: '', running: true,
              ...(model ? { model } : {}),
              ...(thinking ? { thinking } : {}),
            }],
          },
        };
      }),
      appendToolOutput: (content) => set(s => ({
        streaming: { ...s.streaming, currentToolOutput: s.streaming.currentToolOutput + content },
      })),
      appendToolImages: (images) => set(s => ({
        streaming: { ...s.streaming, currentToolImages: [...s.streaming.currentToolImages, ...images] },
      })),
      finalizeToolBlock: () => set(s => {
        const output = s.streaming.currentToolOutput;
        const images = s.streaming.currentToolImages;
        const traces = s.streaming.traces.map(t =>
          t.type === 'tool' && t.running
            ? { ...t, toolOutput: output, running: false, ...(images.length ? { images } : {}) }
            : t
        );
        return { streaming: { ...s.streaming, currentToolOutput: '', currentToolImages: [], traces } };
      }),
      setClassifierMeta: (meta) => set(s => {
        // Attach classifier metadata to the last tool trace (the one that triggered the decision)
        const traces = [...s.streaming.traces];
        for (let i = traces.length - 1; i >= 0; i--) {
          const t = traces[i]!;
          if (t.type === 'tool') {
            traces[i] = { ...t, classifierMeta: meta };
            break;
          }
        }
        return { streaming: { ...s.streaming, traces } };
      }),
    }),
    {
      name: 'aigent-chat',
      partialize: (s) => ({ messages: s.messages, usage: s.usage, taskHistory: s.taskHistory }),
    }
  )
);
