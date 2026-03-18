/**
 * WebSocket event handlers — dispatched by event type from useWebSocket.
 *
 * Each handler receives the typed ServerEvent and a deps object with access
 * to Zustand stores and the WebSocket send function. This replaces the large
 * switch statement that was previously in useWebSocket.ts.
 */

import { useChatStore } from '../stores/chat';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { useSettingsStore } from '../stores/settings';
import { useVoiceStore } from '../stores/voice';
import { useRatingStore } from '../stores/rating';
import { STREAMING_MESSAGE_ID } from '../components/StreamingMessage';
import { parseDiffIntoFiles } from '../lib/diff';
import { captureScreenshot, startScreenShare } from '../lib/screen';
import { playPermissionSound, playResponseCompleteSound } from '../lib/audio';
import { showBrowserNotification } from '../lib/notifications';
import { isPiPOpen, pipSupported } from './usePiP';
import type { ServerEvent, TraceEntry } from '../types';

/** Fire permission-related sound and/or browser notification if enabled. */
function notifyPermission(settings: WsDeps['settings'], detail: string): void {
  if (settings().getClientSetting('notify_sound_permission') !== false) {
    playPermissionSound();
  }
  if (settings().getClientSetting('notify_browser_permission') === true) {
    showBrowserNotification('Permission Required', detail);
  }
}

/** Fire response-complete sound and/or browser notification if enabled. */
function notifyResponseComplete(settings: WsDeps['settings']): void {
  if (settings().getClientSetting('notify_sound_response') === true) {
    playResponseCompleteSound();
  }
  if (settings().getClientSetting('notify_browser_response') === true) {
    showBrowserNotification('Response Complete', 'The agent has finished responding.');
  }
}

// --- Deps interface ---

export interface WsDeps {
  send: (data: Record<string, unknown>) => void;
  chat: typeof useChatStore.getState;
  conn: typeof useConnectionStore.getState;
  ui: typeof useUIStore.getState;
  settings: typeof useSettingsStore.getState;
  voice: typeof useVoiceStore.getState;
  reconnectAttempt: { current: number };
}

function generateMsgId(): string {
  return crypto.randomUUID();
}

// --- Type-safe handler map ---

type HandlerMap = {
  [K in ServerEvent['type']]?: (event: Extract<ServerEvent, { type: K }>, deps: WsDeps) => void;
};

export const handlers: HandlerMap = {

  connected(event, { chat, conn, ui, settings, voice, reconnectAttempt }) {
    conn().setStatus('connected');
    conn().resetReconnect();
    reconnectAttempt.current = 0;

    if (event.state.messages.length > 0) {
      chat().setMessages(event.state.messages);
    }
    const cached = chat().usage.contextTokens;
    chat().setUsage(
      event.state.usage.contextTokens
        ? event.state.usage
        : { ...event.state.usage, contextTokens: cached }
    );
    ui().setThinkingLevel(event.state.thinking);
    ui().setShortMode(event.state.short ?? false);
    ui().setLoading(event.state.isLoading);
    ui().setQueuedMessages(event.state.queue ?? []);
    chat().setTasks(event.state.tasks ?? []);
    for (const t of event.state.tasks ?? []) {
      chat().upsertTaskHistory(t);
    }
    ui().setError(null);

    if (event.state.isLoading) {
      if (!chat().streaming.active) {
        const turnStartCtx = chat().usage.contextTokens ?? 0;
        voice().setSpeakBlockSpoken(false);
        chat().startStream(turnStartCtx);
      }
      if (event.state.streamingTraces?.length) {
        const traces = event.state.streamingTraces as TraceEntry[];
        useChatStore.setState({ streaming: { ...chat().streaming, traces } });
      }
    } else {
      chat().endStream();
    }
    ui().setModelName(event.state.model);
    ui().setAvailableModels(event.state.availableModels ?? []);
    ui().setModelsWithoutThinking(event.state.modelsWithoutThinking ?? []);
    ui().setAvailableTools(event.state.availableTools ?? []);
    if (event.state.contextWindow) ui().setContextWindow(event.state.contextWindow);
    if (event.state.modelTiers) ui().setModelTiers(event.state.modelTiers);

    // Server is authoritative for runtime state.
    settings().setClientSetting('AIGENT_SHORT', event.state.short ?? false);
    settings().setClientSetting('AIGENT_THINKING', event.state.thinking);
    settings().setClientSetting('AIGENT_MODEL', event.state.model);
  },

  text(event, { chat }) {
    const { streaming } = chat();
    if (streaming.isThinking) chat().finalizeThinkingBlock();
    if (event.content) {
      chat().setStreamText(event.content);
    }
  },

  speak(event, { chat }) {
    chat().setStreamSpokenText(event.content);
  },

  thinking(event, { chat }) {
    const { streaming } = chat();
    if (!streaming.isThinking && streaming.active) {
      chat().startThinkingBlock();
    }
    chat().appendThinkingText(event.content);
  },

  tool_start(event, { chat, voice }) {
    const { streaming } = chat();
    if (!streaming.active) {
      voice().setSpeakBlockSpoken(false);
      chat().startStream(chat().usage.contextTokens ?? 0);
    }
    if (streaming.isThinking) chat().finalizeThinkingBlock();
    chat().startToolBlock(event.name, event.summary, event.input, event.model, event.thinking);
  },

  tool_output(event, { chat }) {
    chat().appendToolOutput(event.content);
  },

  tool_images(event, { chat }) {
    chat().appendToolImages(event.images);
  },

  tool_end(_event, { chat }) {
    chat().finalizeToolBlock();
  },

  classifier_decision(event, { chat }) {
    chat().setClassifierMeta({ tier: event.tier, action: event.action, reason: event.reason });
  },

  task_update(event, { chat, ui }) {
    chat().upsertTask(event.task);
    chat().upsertTaskHistory(event.task);
    if (
      event.task.status === 'completed' ||
      event.task.status === 'failed' ||
      event.task.status === 'cancelled'
    ) {
      const taskId = event.task.id;
      if (event.task.status === 'completed' && event.task.delivery === 'user-pull') {
        ui().setTaskResultTask(event.task);
      }
      setTimeout(() => {
        const current = chat().tasks.filter(t => t.id !== taskId);
        chat().setTasks(current);
      }, 30_000);
    }
  },

  raw_turn(event, { chat }) {
    chat().bufferRawTurn(event.messageId, event.turn);
  },

  message(event, { chat, conn, settings }) {
    const { streaming } = chat();
    if (event.message.role === 'assistant' && streaming.active) {
      if (streaming.isThinking) chat().finalizeThinkingBlock();
      chat().finalizeToolBlock();
      const traces = chat().streaming.traces;
      const bufferedRawTurns = chat().drainRawTurns(event.message.id);
      const msgWithRaw = bufferedRawTurns.length > 0
        ? { ...event.message, rawTurns: bufferedRawTurns }
        : event.message;
      chat().finishStream(msgWithRaw, traces);
      notifyResponseComplete(settings);
      const streamingRating = useRatingStore.getState().ratings[STREAMING_MESSAGE_ID];
      if (streamingRating) {
        useRatingStore.getState().remapRating(STREAMING_MESSAGE_ID, event.message.id);
        conn().send({
          type: 'message_rating',
          messageId: event.message.id,
          rating: streamingRating.score,
          notes: streamingRating.notes,
        });
      }
    } else {
      chat().appendMessage(event.message);
    }
  },

  system(event, { chat }) {
    chat().appendMessage({
      id: 'msg_sys_' + Date.now(),
      role: 'system',
      content: event.content,
      timestamp: new Date().toISOString(),
    });
  },

  usage(event, { chat }) {
    chat().setUsage(event.usage);
  },

  loading(event, { chat, ui, voice }) {
    ui().setLoading(event.isLoading);
    if (event.isLoading && !chat().streaming.active) {
      const turnStartCtx = chat().usage.contextTokens ?? 0;
      voice().setSpeakBlockSpoken(false);
      chat().startStream(turnStartCtx);
    }
    if (!event.isLoading) {
      const { streaming } = chat();
      if (streaming.active && (streaming.text || streaming.traces.length > 0)) {
        // Finalize any in-progress tool/thinking block before reading traces.
        // If cancel fires mid-tool, the output sits in currentToolOutput and
        // the trace has running:true — without this the tool call is invisible.
        if (streaming.isThinking) chat().finalizeThinkingBlock();
        const hasRunningTool = streaming.traces.some(t => t.type === 'tool' && t.running);
        if (hasRunningTool) chat().finalizeToolBlock();
        const traces = chat().streaming.traces;
        chat().endStream();
        chat().appendMessage({
          id: generateMsgId(),
          role: 'assistant',
          content: streaming.text || '*(cancelled)*',
          timestamp: new Date().toISOString(),
          cancelled: true,
        }, traces);
      } else {
        chat().endStream();
      }
    }
  },

  error(event, { ui }) {
    ui().setError(event.message);
  },

  queue_update(event, { ui }) {
    ui().setQueuedMessages(event.queue);
  },

  state(event, { ui, settings }) {
    if (event.thinking) {
      ui().setThinkingLevel(event.thinking);
      settings().setClientSetting('AIGENT_THINKING', event.thinking);
    }
    if (event.model) {
      ui().setModelName(event.model);
      settings().setClientSetting('AIGENT_MODEL', event.model);
    }
    if (event.short !== undefined) {
      ui().setShortMode(event.short);
      settings().setClientSetting('AIGENT_SHORT', event.short);
    }
    if (event.availableModels) ui().setAvailableModels(event.availableModels);
    if (event.modelsWithoutThinking) ui().setModelsWithoutThinking(event.modelsWithoutThinking);
    if (event.contextWindow) ui().setContextWindow(event.contextWindow);
    if (event.modelTiers) ui().setModelTiers(event.modelTiers);
  },

  host_state(event, { ui }) {
    if (event.capabilities) ui().setCaps(event.capabilities);
    if (event.ttsAvailable !== undefined) ui().setTtsAvailable(event.ttsAvailable);
    if (event.sttAvailable !== undefined) ui().setSttAvailable(event.sttAvailable);
    if (event.extensionConnected !== undefined) ui().setExtensionConnected(event.extensionConnected);
    if (event.extensionPath) ui().setExtensionPath(event.extensionPath);
    if (event.vscodeConnected !== undefined) ui().setVscodeConnected(event.vscodeConnected);
  },

  client_settings(event, { settings }) {
    settings().mergeClientSettings(event.settings);
  },

  config_write_request(event, { ui, settings }) {
    const detail = `File: ${event.file}\nReason: ${event.reason}`;
    ui().enqueuePermRequest({
      type: 'config_write',
      id: event.id,
      title: 'Config Write Request',
      detail,
      approveCmd: `/approve ${event.id}`,
      denyCmd: `/reject ${event.id}`,
    });
    notifyPermission(settings, detail);
  },

  patch_request(event, { ui, settings }) {
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
    notifyPermission(settings, title);
  },

  exec_request(event, { ui, settings }) {
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
    notifyPermission(settings, event.command);
  },

  fetch_request(event, { ui, settings }) {
    const detail = `${event.method ?? 'GET'} ${event.url}`;
    ui().enqueuePermRequest({
      type: 'fetch',
      id: event.id,
      title: 'Fetch URL',
      detail,
      approveCmd: `/approve-fetch ${event.id}`,
      denyCmd: `/deny-fetch ${event.id}`,
      alwaysAllowCmd: `/approve-fetch ${event.id} --always`,
      alwaysAllowDomainCmd: `/approve-fetch ${event.id} --always-domain`,
    });
    notifyPermission(settings, detail);
  },

  file_access_request(event, { ui, settings }) {
    ui().enqueuePermRequest({
      type: 'file_access',
      id: event.id,
      title: `File ${event.operation === 'read' ? 'Read' : 'Write'}`,
      detail: event.path,
      body: event.reason,
      approveCmd: `/approve-file ${event.id}`,
      denyCmd: `/deny-file ${event.id}`,
      alwaysAllowCmd: `/approve-file ${event.id} --always`,
      alwaysAllowDomainCmd: `/approve-file ${event.id} --always-dir`,
    });
    notifyPermission(settings, event.path);
  },

  fetch_size_request(event, { ui, settings }) {
    const mb = (event.requestedBytes / (1024 * 1024)).toFixed(1);
    const defaultMb = (event.defaultBytes / (1024 * 1024)).toFixed(0);
    const detail = `${mb} MB from ${event.url}`;
    ui().enqueuePermRequest({
      type: 'fetch_size',
      id: event.id,
      title: 'Large Fetch',
      detail,
      body: `Default limit is ${defaultMb} MB`,
      approveCmd: `/approve-fetchsize ${event.id}`,
      denyCmd: `/deny-fetchsize ${event.id}`,
    });
    notifyPermission(settings, detail);
  },

  mcp_tool_request(event, { ui, settings }) {
    const paramsPreview = event.params.length > 200
      ? event.params.slice(0, 200) + '\n...'
      : event.params;
    const detail = `${event.server}/${event.tool}`;
    ui().enqueuePermRequest({
      type: 'mcp_tool',
      id: event.id,
      title: 'MCP Tool',
      detail,
      body: paramsPreview,
      approveCmd: `/approve-mcp ${event.id}`,
      denyCmd: `/deny-mcp ${event.id}`,
      alwaysAllowCmd: `/approve-mcp ${event.id} --always`,
    });
    notifyPermission(settings, detail);
  },

  browser_write_request(event, { ui, settings }) {
    const isDestructive = !!(event as Record<string, unknown>).destructive;
    const destructiveDetail = (event as Record<string, unknown>).destructiveDetail as string | undefined;
    const autonomousCmd = (event as Record<string, unknown>).autonomousCmd as string | undefined;
    const baseTitle = event.action === 'navigate' ? 'Browser: Navigate'
      : event.action === 'open_tab' ? 'Browser: Open Tab'
      : event.action === 'close_tab' ? 'Browser: Close Tab'
      : event.action === 'run_script' ? 'Browser: Run Script'
      : 'Browser: Run Action';
    const title = isDestructive ? `⚠ ${baseTitle}` : baseTitle;
    const bodyParts: string[] = [];
    if (event.domain) bodyParts.push(`Domain: ${event.domain}`);
    if (event.tabUrl) bodyParts.push(`On: ${event.tabUrl}`);
    if (isDestructive && destructiveDetail) bodyParts.push(`Destructive: ${destructiveDetail}`);
    else if (event.requiredTier) bodyParts.push(`Required: ${event.requiredTier}`);
    ui().enqueuePermRequest({
      type: 'browser_write',
      id: event.id,
      title,
      detail: event.stepSummary,
      ...(bodyParts.length > 0 ? { body: bodyParts.join('\n') } : {}),
      approveCmd: `/approve-browser-write ${event.id}`,
      denyCmd: `/deny-browser-write ${event.id}`,
      ...(!isDestructive ? { alwaysAllowCmd: `/approve-browser-write ${event.id} --always` } : {}),
      ...(autonomousCmd ? { autonomousCmd } : {}),
      ...(event.alwaysReadCmd ? { alwaysReadCmd: event.alwaysReadCmd } : {}),
      ...(event.alwaysWriteCmd ? { alwaysWriteCmd: event.alwaysWriteCmd } : {}),
      ...(event.alwaysScriptCmd ? { alwaysScriptCmd: event.alwaysScriptCmd } : {}),
    });
    notifyPermission(settings, event.stepSummary);
  },

  user_question_request(event, { ui, settings }) {
    ui().enqueuePermRequest({
      type: 'user_question',
      id: event.id,
      title: 'Question from Agent',
      detail: event.question,
      questionOptions: event.options,
      questionMultiSelect: event.multiSelect,
      questionAllowFreeText: true,
      approveCmd: '',
      denyCmd: '',
    });
    notifyPermission(settings, event.question);
  },

  pip_suggestion(event, { send, ui, settings }) {
    const autoPip = settings().getClientSetting('auto_pip');
    if (isPiPOpen() || autoPip === false || !pipSupported) {
      send({ type: 'pip_suggestion_response', id: event.id, action: 'skip' });
      return;
    }
    ui().enqueuePermRequest({
      type: 'pip_suggestion',
      id: event.id,
      title: 'Float chat?',
      detail: 'Agent is about to switch tabs',
      approveCmd: '',
      denyCmd: '',
    });
    notifyPermission(settings, 'Agent is about to switch tabs');
  },

  screenshot_request(event, { send }) {
    const base64 = captureScreenshot();
    if (!base64) {
      send({ type: 'screenshot_response', id: event.id, ok: false, message: 'Screen sharing not active. Click the monitor icon in the input bar to start sharing.' });
    } else {
      send({ type: 'screenshot_response', id: event.id, ok: true, data: base64, mediaType: 'image/png', message: 'Screenshot captured' });
    }
  },

  screen_share_request(event, { send }) {
    void (async () => {
      try {
        await startScreenShare();
        send({ type: 'screen_share_response', id: event.id, ok: true, message: 'Screen sharing started' });
      } catch {
        send({ type: 'screen_share_response', id: event.id, ok: false, message: 'Screen sharing cancelled or denied' });
      }
    })();
  },

  context_breakdown(event, { ui }) {
    ui().setContextBreakdown(event.breakdown);
  },

  reset(_event, { chat }) {
    chat().clearMessages();
    useRatingStore.getState().clearRatings();
  },

  pong() { /* keep-alive */ },

  browser_error(event, { chat }) {
    chat().appendMessage({
      id: generateMsgId(),
      role: 'system',
      content: `[browser:${event.level}]${event.source ? ` (${event.source})` : ''} ${event.message}`,
      timestamp: new Date().toISOString(),
    });
  },

  perm_dismissed(event, { ui }) {
    ui().dismissPermRequests(event.ids);
  },
};

/**
 * Dispatch a server event to the appropriate handler.
 * Returns true if a handler was found.
 */
export function dispatchEvent(event: ServerEvent, deps: WsDeps): boolean {
  const handler = handlers[event.type] as ((event: ServerEvent, deps: WsDeps) => void) | undefined;
  if (handler) {
    handler(event, deps);
    return true;
  }
  return false;
}
