import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { useVoiceStore } from '../stores/voice';
import { isDemo, getDemoWebSocket } from '../demo/useDemoMode';
import { setupErrorRelay, teardownErrorRelay } from '../lib/errorRelay';
import { dispatchEvent, type WsDeps } from './ws-handlers';
import type { ServerEvent } from '../types';

export function useWebSocket(): void {
  const chat = useChatStore.getState;
  const conn = useConnectionStore.getState;
  const ui = useUIStore.getState;
  const settings = useSettingsStore.getState;
  const voice = useVoiceStore.getState;

  const reconnectAttempt = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Track WebSockets that were intentionally closed (by cleanup).
  // We can't use a simple "mounted" boolean because WebSocket close is async —
  // by the time onclose fires for the old WS, React StrictMode has already
  // re-mounted the hook and set mounted=true, causing a phantom reconnect.
  const closedIntentionally = useRef(new WeakSet<WebSocket>());

  useEffect(() => {
    function send(data: Record<string, unknown>): void {
      conn().send(data);
    }

    const deps: WsDeps = { send, chat, conn, ui, settings, voice, reconnectAttempt };

    function handleEvent(event: ServerEvent): void {
      dispatchEvent(event, deps);
    }

    function connect(): void {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      // In dev mode (Vite on :5173), connect directly to the backend
      // to avoid Vite proxy errors during tsx-watch restarts.
      const wsHost = import.meta.env.DEV ? 'localhost:3141' : location.host;
      const ws = isDemo()
        ? getDemoWebSocket() as unknown as WebSocket
        : new WebSocket(`${proto}//${wsHost}/ws`);
      wsRef.current = ws;
      conn().setWs(ws);
      conn().setStatus('connecting');

      ws.onopen = () => {
        conn().setStatus('connected');
        reconnectAttempt.current = 0;
        // Start ping interval (skip in demo mode — no server to ping)
        if (!isDemo()) {
          if (pingTimer.current) clearInterval(pingTimer.current);
          pingTimer.current = setInterval(() => {
            conn().send({ type: 'ping' });
          }, 25_000);
        }
        // Start error relay if the debug setting is on
        if (settings().getClientSetting('debug_browser_errors') === true) {
          setupErrorRelay((data) => conn().send(data));
        }
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const event = JSON.parse(ev.data as string) as ServerEvent;
          handleEvent(event);
        } catch { /* malformed JSON */ }
      };

      ws.onclose = () => {
        teardownErrorRelay();
        if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
        // Only clear the store if THIS ws is still the active connection.
        // In React StrictMode, the old ws's onclose fires AFTER the remount
        // has already stored a new ws — clearing it would wipe the new connection.
        // Check the global store (not the local ref) since each hook instance
        // has its own wsRef but they all share the same zustand store.
        if (conn().ws === ws) {
          conn().setWs(null);
          wsRef.current = null;
          chat().endStream();
          // Only reconnect if this WebSocket wasn't intentionally closed by cleanup.
          if (!closedIntentionally.current.has(ws)) {
            conn().setStatus('reconnecting');
            scheduleReconnect();
          }
        }
      };

      ws.onerror = () => { /* onclose fires next */ };
    }

    function scheduleReconnect(): void {
      if (isDemo()) return;
      if (reconnectTimer.current) return;
      reconnectAttempt.current++;
      const delay = reconnectAttempt.current <= 1 ? 200 : reconnectAttempt.current <= 3 ? 500 : 1000;
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      teardownErrorRelay();
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
      if (wsRef.current) {
        closedIntentionally.current.add(wsRef.current);
        wsRef.current.close();
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
