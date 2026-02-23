import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DisplayMessage, TokenUsage, BackgroundTaskInfo, TraceEntry } from '../types';

interface StreamingState {
  active: boolean;
  text: string;
  isThinking: boolean;
  thinkingText: string;
  currentToolOutput: string;
  traces: TraceEntry[];
  turnStartCtx: number;
}

interface ChatState {
  messages: DisplayMessage[];
  usage: TokenUsage;
  tasks: BackgroundTaskInfo[];
  streaming: StreamingState;

  setMessages: (msgs: DisplayMessage[]) => void;
  appendMessage: (msg: DisplayMessage, traces?: TraceEntry[]) => void;
  setUsage: (usage: TokenUsage) => void;
  setTasks: (tasks: BackgroundTaskInfo[]) => void;
  upsertTask: (task: BackgroundTaskInfo) => void;
  clearMessages: () => void;

  // Streaming actions
  startStream: (turnStartCtx: number) => void;
  endStream: () => void;
  setStreamText: (text: string) => void;

  startThinkingBlock: () => void;
  appendThinkingText: (text: string) => void;
  finalizeThinkingBlock: () => void;

  startToolBlock: (name: string, summary: string, input: string) => void;
  appendToolOutput: (content: string) => void;
  finalizeToolBlock: () => void;
}

let traceIdCounter = 0;

const INITIAL_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const INITIAL_STREAMING: StreamingState = {
  active: false, text: '', isThinking: false, thinkingText: '',
  currentToolOutput: '', traces: [], turnStartCtx: 0,
};

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      messages: [],
      usage: INITIAL_USAGE,
      tasks: [],
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
      clearMessages: () => set({ messages: [] }),

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

      startToolBlock: (name, summary, input) => set(s => {
        const id = `trace-${++traceIdCounter}`;
        return {
          streaming: {
            ...s.streaming,
            text: '',
            currentToolOutput: '',
            traces: [...s.streaming.traces, {
              id, type: 'tool', toolName: name, toolSummary: summary,
              toolInput: input, toolOutput: '', running: true,
            }],
          },
        };
      }),
      appendToolOutput: (content) => set(s => ({
        streaming: { ...s.streaming, currentToolOutput: s.streaming.currentToolOutput + content },
      })),
      finalizeToolBlock: () => set(s => {
        const output = s.streaming.currentToolOutput;
        const traces = s.streaming.traces.map(t =>
          t.type === 'tool' && t.running ? { ...t, toolOutput: output, running: false } : t
        );
        return { streaming: { ...s.streaming, currentToolOutput: '', traces } };
      }),
    }),
    {
      name: 'aigent-chat',
      partialize: (s) => ({ messages: s.messages, usage: s.usage }),
    }
  )
);
