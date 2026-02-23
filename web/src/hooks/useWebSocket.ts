import { useEffect, useRef } from 'react';
import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { useVoiceStore } from '../stores/voice';
import { parseDiffIntoFiles } from '../lib/diff';
import { captureScreenshot, startScreenShare } from '../lib/screen';
import { playPermissionSound } from '../lib/audio';
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
          chat().startToolBlock(event.name, event.summary, event.input);
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

        case 'mount_request': {
          ui().enqueuePermRequest({
            type: 'mount',
            id: event.id,
            title: `Mount Request (${event.mode})`,
            detail: event.path,
            ...(event.reason ? { body: event.reason } : {}),
            approveCmd: `/grant ${event.id}`,
            denyCmd: `/deny ${event.id}`,
            ...(event.durationMinutes !== undefined ? { durationMinutes: event.durationMinutes } : {}),
          });
          playPermissionSound();
          break;
        }

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
          ui().setCtxInspectorOpen(true);
          break;

        case 'pong':
          break;
      }
    }

    function connect(): void {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${location.host}/ws`);
      wsRef.current = ws;
      conn().setWs(ws);
      conn().setStatus('connecting');

      ws.onopen = () => {
        conn().setStatus('connected');
        reconnectAttempt.current = 0;
        // Start ping interval
        if (pingTimer.current) clearInterval(pingTimer.current);
        pingTimer.current = setInterval(() => {
          conn().send({ type: 'ping' });
        }, 25_000);
      };

      ws.onmessage = (ev: MessageEvent) => {
        try {
          const event = JSON.parse(ev.data as string) as ServerEvent;
          handleEvent(event);
        } catch { /* malformed JSON */ }
      };

      ws.onclose = () => {
        if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null; }
        conn().setStatus('reconnecting');
        conn().setWs(null);
        wsRef.current = null;
        chat().endStream();
        scheduleReconnect();
      };

      ws.onerror = () => { /* onclose fires next */ };
    }

    function scheduleReconnect(): void {
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
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (pingTimer.current) clearInterval(pingTimer.current);
      wsRef.current?.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
