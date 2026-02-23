import { create } from 'zustand';

export type ConnStatus = 'connecting' | 'connected' | 'reconnecting';

interface ConnectionState {
  status: ConnStatus;
  ws: WebSocket | null;
  reconnectAttempt: number;

  setStatus: (status: ConnStatus) => void;
  setWs: (ws: WebSocket | null) => void;
  incrementReconnect: () => void;
  resetReconnect: () => void;
  send: (data: Record<string, unknown>) => void;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  status: 'connecting',
  ws: null,
  reconnectAttempt: 0,

  setStatus: (status) => set({ status }),
  setWs: (ws) => set({ ws }),
  incrementReconnect: () => set(s => ({ reconnectAttempt: s.reconnectAttempt + 1 })),
  resetReconnect: () => set({ reconnectAttempt: 0 }),
  send: (data) => {
    const { ws } = get();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  },
}));
