import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { useVoiceStore } from '../stores/voice';
import { parseDiffIntoFiles } from '../lib/diff';
import { captureScreenshot, startScreenShare } from '../lib/screen';
import { playPermissionSound } from '../lib/audio';
import { isDemo, getDemoWebSocket } from '../demo/useDemoMode';
import { setupErrorRelay, teardownErrorRelay } from '../lib/errorRelay';
import type { ServerEvent, MountInfo } from '../types';

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

    function handleEvent(event: ServerEvent): void {
      switch (event.type) {
        case 'connected': {
          conn().setStatus('connected');
          conn().resetReconnect();
          reconnectAttempt.current = 0;

          if (event.state.messages.length > 0) {
            chat().setMessages(event.state.messages);
          }
          // Preserve cached contextTokens if server has none yet
          const cached = chat().usage.contextTokens;
          chat().setUsage(
            event.state.usage.contextTokens
              ? event.state.usage
              : { ...event.state.usage, contextTokens: cached }
          );
          ui().setThinkingLevel(event.state.thinking);
          ui().setConciseMode(event.state.concise ?? false);
          ui().setLoading(event.state.isLoading);
          chat().setTasks(event.state.tasks ?? []);
          ui().setError(null);
          chat().endStream();
          ui().setModelName(event.state.model);
          ui().setAvailableModels(event.state.availableModels ?? []);
          ui().setAvailableTools(event.state.availableTools ?? []);
          break;
        }

        case 'text': {
          const { streaming } = chat();
          if (streaming.isThinking) chat().finalizeThinkingBlock();
          if (event.content) {
            chat().setStreamText(event.content);
            // TTS flush handled by useTTS hook listening to store
          }
          break;
        }

        case 'thinking': {
          const { streaming } = chat();
          if (!streaming.isThinking && streaming.active) {
            chat().startThinkingBlock();
          }
          chat().appendThinkingText(event.content);
          break;
        }

        case 'tool_start': {
          const { streaming } = chat();
          if (streaming.isThinking) chat().finalizeThinkingBlock();
          chat().startToolBlock(event.name, event.summary, event.input, event.model, event.thinking);
          break;
        }

        case 'tool_output':
          chat().appendToolOutput(event.content);
          break;

        case 'tool_end':
          chat().finalizeToolBlock();
          break;

        case 'task_update': {
          chat().upsertTask(event.task);
          if (
            event.task.status === 'completed' ||
            event.task.status === 'failed' ||
            event.task.status === 'cancelled'
          ) {
            const taskId = event.task.id;
            // Show task result panel for user-pull delivery
            if (event.task.status === 'completed' && event.task.delivery === 'user-pull') {
              ui().setTaskResultTask(event.task);
            }
            setTimeout(() => {
              const current = chat().tasks.filter(t => t.id !== taskId);
              chat().setTasks(current);
            }, 30_000);
          }
          break;
        }

        case 'message': {
          const { streaming } = chat();
          if (event.message.role === 'assistant' && streaming.active) {
            if (streaming.isThinking) chat().finalizeThinkingBlock();
            chat().finalizeToolBlock();
            // Capture traces before endStream resets streaming state
            const traces = chat().streaming.traces;
            chat().endStream();
            chat().appendMessage(event.message, traces);
          } else {
            chat().appendMessage(event.message);
          }
          break;
        }

        case 'system':
          chat().appendMessage({
            role: 'system',
            content: event.content,
            timestamp: new Date().toISOString(),
          });
          break;

        case 'usage':
          chat().setUsage(event.usage);
          break;

        case 'loading':
          ui().setLoading(event.isLoading);
          if (event.isLoading && !chat().streaming.active) {
            const turnStartCtx = chat().usage.contextTokens ?? 0;
            voice().setSpeakBlockSpoken(false);
            chat().startStream(turnStartCtx);
          }
          if (!event.isLoading) {
            chat().endStream();
          }
          break;

        case 'error':
          ui().setError(event.message);
          break;

        case 'state':
          if (event.thinking) ui().setThinkingLevel(event.thinking);
          if (event.model) ui().setModelName(event.model);
          if (event.concise !== undefined) ui().setConciseMode(event.concise);
          if (event.availableModels) ui().setAvailableModels(event.availableModels);
          break;

        case 'host_state':
          ui().setMounts(event.mounts as MountInfo[]);
          if (event.capabilities) ui().setCaps(event.capabilities);
          break;

        case 'client_settings':
          settings().mergeClientSettings(event.settings);
          break;

        case 'config_write_request':
          ui().enqueuePermRequest({
            type: 'config_write',
            id: event.id,
            title: 'Config Write Request',
            detail: `File: ${event.file}\nReason: ${event.reason}`,
            approveCmd: `/approve ${event.id}`,
            denyCmd: `/reject ${event.id}`,
          });
          playPermissionSound();
          break;

        case 'patch_request': {
          const diffFiles = parseDiffIntoFiles(event.diff);
          const title = diffFiles.length === 1
            ? `Patch: ${diffFiles[0]!.name}`
            : `Patch: ${diffFiles.length} files`;
          ui().enqueuePermRequest({
            type: 'patch',
            id: event.id,
            title,
            detail: event.reason,
            diff: event.diff,
            diffFiles,
            approveCmd: `/approve-patch ${event.id}`,
            denyCmd: `/reject-patch ${event.id}`,
          });
          playPermissionSound();
          break;
        }

        case 'exec_request':
          ui().enqueuePermRequest({
            type: 'exec',
            id: event.id,
            title: 'Run Command',
            detail: event.command,
            segments: event.segments,
            approveCmd: `/approve-exec ${event.id}`,
            denyCmd: `/deny-exec ${event.id}`,
            alwaysAllowCmd: `/approve-exec ${event.id} --always`,
          });
          playPermissionSound();
          break;

        case 'fetch_request':
          ui().enqueuePermRequest({
            type: 'fetch',
            id: event.id,
            title: 'Fetch URL',
            detail: `${event.method ?? 'GET'} ${event.url}`,
            approveCmd: `/approve-fetch ${event.id}`,
            denyCmd: `/deny-fetch ${event.id}`,
            alwaysAllowCmd: `/approve-fetch ${event.id} --always`,
            alwaysAllowDomainCmd: `/approve-fetch ${event.id} --always-domain`,
          });
          playPermissionSound();
          break;

        case 'browser_write_request':
          ui().enqueuePermRequest({
            type: 'browser_write',
            id: event.id,
            title: event.action === 'navigate' ? 'Browser: Navigate'
              : event.action === 'open_tab' ? 'Browser: Open Tab'
              : event.action === 'close_tab' ? 'Browser: Close Tab'
              : 'Browser: Run Script',
            detail: event.stepSummary,
            ...(event.tabUrl ? { body: `On: ${event.tabUrl}` } : {}),
            approveCmd: `/approve-browser-write ${event.id}`,
            denyCmd: `/deny-browser-write ${event.id}`,
            alwaysAllowCmd: `/approve-browser-write ${event.id} --always`,
            ...(event.autonomousCmd ? { autonomousCmd: event.autonomousCmd } : {}),
          });
          playPermissionSound();
          break;

        case 'screenshot_request': {
          const base64 = captureScreenshot();
          if (!base64) {
            send({ type: 'screenshot_response', id: event.id, ok: false, message: 'Screen sharing not active. Click the monitor icon in the input bar to start sharing.' });
          } else {
            send({ type: 'screenshot_response', id: event.id, ok: true, data: base64, mediaType: 'image/png', message: 'Screenshot captured' });
          }
          break;
        }

        case 'screen_share_request': {
          void (async () => {
            try {
              await startScreenShare();
              send({ type: 'screen_share_response', id: event.id, ok: true, message: 'Screen sharing started' });
            } catch {
              send({ type: 'screen_share_response', id: event.id, ok: false, message: 'Screen sharing cancelled or denied' });
            }
          })();
          break;
        }

        case 'context_breakdown':
          ui().setContextBreakdown(event.breakdown);
          break;

        case 'reset':
          chat().clearMessages();
          break;

        case 'pong':
          break;

        case 'browser_error':
          chat().appendMessage({
            role: 'system',
            content: `[browser:${event.level}]${event.source ? ` (${event.source})` : ''} ${event.message}`,
            timestamp: new Date().toISOString(),
          });
          break;
      }
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
