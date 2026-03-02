import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DisplayMessage, TokenUsage, BackgroundTaskInfo, TraceEntry, ClassifierMeta } from '../types';

interface StreamingState {
  active: boolean;
  text: string;
  spokenText: string | null;
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
  /** Atomically append final message and end stream in one state update. */
  finishStream: (msg: DisplayMessage, traces?: TraceEntry[]) => void;
  setStreamText: (text: string) => void;
  setStreamSpokenText: (text: string | null) => void;

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
  active: false, text: '', spokenText: null, isThinking: false, thinkingText: '',
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
      appendMessage: (msg, traces?) => set(s => {
        let finalMsg = traces && traces.length > 0 ? { ...msg, traces } : msg;
        // Extract <speak> tags from assistant content (server may already set spokenText,
        // but handle inline tags for test harness and backwards compatibility)
        if (finalMsg.role === 'assistant' && !finalMsg.spokenText) {
          const m = finalMsg.content.match(/<speak>([\s\S]*?)<\/speak>/);
          if (m) {
            const spokenText = m[1]!.trim();
            const stripped = finalMsg.content.replace(/<speak>[\s\S]*?<\/speak>/g, '').trim();
            finalMsg = { ...finalMsg, spokenText, content: stripped || finalMsg.content };
          }
        }
        return { messages: [...s.messages, finalMsg] };
      }),
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
      /** Atomically append the final message and end the stream in one state update.
       *  This prevents any intermediate render where StreamingMessage is gone
       *  but the final Message hasn't appeared yet (or vice versa). */
      finishStream: (msg, traces?) => set(s => {
        let finalMsg = traces && traces.length > 0 ? { ...msg, traces } : msg;
        if (finalMsg.role === 'assistant' && !finalMsg.spokenText) {
          const m = finalMsg.content.match(/<speak>([\s\S]*?)<\/speak>/);
          if (m) {
            const spokenText = m[1]!.trim();
            const stripped = finalMsg.content.replace(/<speak>[\s\S]*?<\/speak>/g, '').trim();
            finalMsg = { ...finalMsg, spokenText, content: stripped || finalMsg.content };
          }
        }
        return {
          messages: [...s.messages, finalMsg],
          streaming: { ...s.streaming, active: false, isThinking: false },
        };
      }),
      setStreamText: (text) => set(s => {
        // Extract <speak> tags from streaming text
        const m = text.match(/<speak>([\s\S]*?)<\/speak>/);
        if (m) {
          const spokenText = m[1]!.trim();
          const stripped = text.replace(/<speak>[\s\S]*?<\/speak>/g, '').trim();
          return { streaming: { ...s.streaming, text: stripped || text, spokenText: spokenText || s.streaming.spokenText } };
        }
        return { streaming: { ...s.streaming, text } };
      }),
      setStreamSpokenText: (text) => set(s => ({ streaming: { ...s.streaming, spokenText: text } })),

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
      onRehydrateStorage: () => (state) => {
        // Migrate old messages that have <speak> tags baked into content.
        // Extract spokenText and strip tags so the UI never sees them.
        if (!state) return;
        for (const msg of state.messages) {
          if (msg.role === 'assistant' && !msg.spokenText && msg.content.includes('<speak>')) {
            const m = msg.content.match(/<speak>([\s\S]*?)<\/speak>/);
            if (m) {
              msg.spokenText = m[1]!.trim();
              const stripped = msg.content.replace(/<speak>[\s\S]*?<\/speak>/g, '').trim();
              msg.content = stripped || msg.spokenText;
            }
          }
        }
      },
    }
  )
);
