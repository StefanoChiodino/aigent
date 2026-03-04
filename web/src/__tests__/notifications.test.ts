/**
 * Notification system tests — verifies:
 * 1. showBrowserNotification helper respects visibility and permission
 * 2. Setting defaults match expected values
 * 3. ws-handlers gate sounds and notifications behind settings
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSettingsStore } from '../stores/settings';
import { useChatStore } from '../stores/chat';
import { useUIStore } from '../stores/ui';
import { useConnectionStore } from '../stores/connection';
import { useVoiceStore } from '../stores/voice';
import { useRatingStore } from '../stores/rating';
import { handlers } from '../hooks/ws-handlers';
import type { WsDeps } from '../hooks/ws-handlers';

// ── Mock audio and notification modules ─────────────────────────────────────

vi.mock('../lib/audio', () => ({
  playPermissionSound: vi.fn(),
  playResponseCompleteSound: vi.fn(),
}));

vi.mock('../lib/notifications', () => ({
  showBrowserNotification: vi.fn(),
}));

// Must be imported AFTER vi.mock
import { playPermissionSound, playResponseCompleteSound } from '../lib/audio';
import { showBrowserNotification } from '../lib/notifications';

// ── showBrowserNotification unit tests ──────────────────────────────────────

describe('showBrowserNotification', () => {
  let NotificationSpy: ReturnType<typeof vi.fn>;
  let originalHidden: boolean;

  beforeEach(() => {
    // Clear the mock so we can test the real implementation
    vi.unmock('../lib/notifications');
    NotificationSpy = vi.fn();
    (globalThis as Record<string, unknown>).Notification = Object.assign(NotificationSpy, {
      permission: 'granted' as NotificationPermission,
      requestPermission: () => Promise.resolve('granted' as NotificationPermission),
    });
    originalHidden = document.hidden;
  });

  afterEach(() => {
    Object.defineProperty(document, 'hidden', { value: originalHidden, configurable: true });
    vi.restoreAllMocks();
    // Re-mock for subsequent tests
    vi.mock('../lib/notifications', () => ({
      showBrowserNotification: vi.fn(),
    }));
  });

  it('fires Notification when document is hidden and permission granted', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    // Dynamic import to get the real (unmocked) module
    const mod = await vi.importActual<typeof import('../lib/notifications')>('../lib/notifications');
    mod.showBrowserNotification('Test', 'body text');
    expect(NotificationSpy).toHaveBeenCalledWith('Test', expect.objectContaining({ body: 'body text', tag: 'aigent' }));
  });

  it('does NOT fire when document is visible', async () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    const mod = await vi.importActual<typeof import('../lib/notifications')>('../lib/notifications');
    mod.showBrowserNotification('Test', 'body');
    expect(NotificationSpy).not.toHaveBeenCalled();
  });

  it('does NOT fire when permission is denied', async () => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    (globalThis as Record<string, unknown>).Notification = Object.assign(vi.fn(), {
      permission: 'denied' as NotificationPermission,
      requestPermission: () => Promise.resolve('denied' as NotificationPermission),
    });
    const mod = await vi.importActual<typeof import('../lib/notifications')>('../lib/notifications');
    mod.showBrowserNotification('Test', 'body');
    expect((globalThis.Notification as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

// ── Setting defaults ────────────────────────────────────────────────────────

describe('Notification setting defaults', () => {
  beforeEach(() => {
    useSettingsStore.setState({ clientSettings: {} });
  });

  it('permission sound is ON by default', () => {
    expect(useSettingsStore.getState().getClientSetting('notify_sound_permission')).toBe(true);
  });

  it('response sound is OFF by default', () => {
    expect(useSettingsStore.getState().getClientSetting('notify_sound_response')).toBe(false);
  });

  it('browser notification for permission is OFF by default', () => {
    expect(useSettingsStore.getState().getClientSetting('notify_browser_permission')).toBe(false);
  });

  it('browser notification for response is OFF by default', () => {
    expect(useSettingsStore.getState().getClientSetting('notify_browser_response')).toBe(false);
  });
});

// ── Handler notification gating ─────────────────────────────────────────────

function makeDeps(overrides?: Partial<WsDeps>): WsDeps {
  return {
    send: vi.fn(),
    chat: useChatStore.getState as WsDeps['chat'],
    conn: useConnectionStore.getState as WsDeps['conn'],
    ui: useUIStore.getState as WsDeps['ui'],
    settings: useSettingsStore.getState as WsDeps['settings'],
    voice: useVoiceStore.getState as WsDeps['voice'],
    reconnectAttempt: { current: 0 },
    ...overrides,
  };
}

describe('Permission handler sound gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ permQueue: [], permShowing: false });
  });

  it('exec_request plays sound when notify_sound_permission is true (default)', () => {
    useSettingsStore.setState({ clientSettings: {} });
    const deps = makeDeps();
    handlers.exec_request!(
      { type: 'exec_request', id: 'e1', command: 'ls', segments: [] } as never,
      deps,
    );
    expect(playPermissionSound).toHaveBeenCalled();
    expect(showBrowserNotification).not.toHaveBeenCalled();
  });

  it('exec_request does NOT play sound when notify_sound_permission is false', () => {
    useSettingsStore.setState({ clientSettings: { notify_sound_permission: false } });
    const deps = makeDeps();
    handlers.exec_request!(
      { type: 'exec_request', id: 'e2', command: 'ls', segments: [] } as never,
      deps,
    );
    expect(playPermissionSound).not.toHaveBeenCalled();
  });

  it('exec_request shows browser notification when notify_browser_permission is true', () => {
    useSettingsStore.setState({ clientSettings: { notify_browser_permission: true } });
    const deps = makeDeps();
    handlers.exec_request!(
      { type: 'exec_request', id: 'e3', command: 'git status', segments: [] } as never,
      deps,
    );
    expect(showBrowserNotification).toHaveBeenCalledWith('Permission Required', 'git status');
  });

  it('fetch_request gates permission sound behind setting', () => {
    useSettingsStore.setState({ clientSettings: { notify_sound_permission: false } });
    const deps = makeDeps();
    handlers.fetch_request!(
      { type: 'fetch_request', id: 'f1', url: 'https://example.com', method: 'GET' } as never,
      deps,
    );
    expect(playPermissionSound).not.toHaveBeenCalled();
  });
});

describe('Response complete notification gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRatingStore.setState({ ratings: {} });
  });

  it('message handler fires response sound when enabled', () => {
    useSettingsStore.setState({ clientSettings: { notify_sound_response: true } });
    // Start a stream so finishStream() path is taken
    useChatStore.getState().startStream(0);
    const deps = makeDeps();
    handlers.message!(
      {
        type: 'message',
        message: { id: 'msg-1', role: 'assistant', content: 'Hello', timestamp: new Date().toISOString() },
      } as never,
      deps,
    );
    expect(playResponseCompleteSound).toHaveBeenCalled();
  });

  it('message handler does NOT fire response sound when disabled (default)', () => {
    useSettingsStore.setState({ clientSettings: {} });
    useChatStore.getState().startStream(0);
    const deps = makeDeps();
    handlers.message!(
      {
        type: 'message',
        message: { id: 'msg-2', role: 'assistant', content: 'Hi', timestamp: new Date().toISOString() },
      } as never,
      deps,
    );
    expect(playResponseCompleteSound).not.toHaveBeenCalled();
  });

  it('message handler shows browser notification when enabled', () => {
    useSettingsStore.setState({ clientSettings: { notify_browser_response: true } });
    useChatStore.getState().startStream(0);
    const deps = makeDeps();
    handlers.message!(
      {
        type: 'message',
        message: { id: 'msg-3', role: 'assistant', content: 'Done', timestamp: new Date().toISOString() },
      } as never,
      deps,
    );
    expect(showBrowserNotification).toHaveBeenCalledWith(
      'Response Complete',
      'The agent has finished responding.',
    );
  });

  it('message handler does NOT notify for non-assistant messages', () => {
    useSettingsStore.setState({ clientSettings: { notify_sound_response: true, notify_browser_response: true } });
    const deps = makeDeps();
    handlers.message!(
      {
        type: 'message',
        message: { id: 'msg-4', role: 'user', content: 'test', timestamp: new Date().toISOString() },
      } as never,
      deps,
    );
    expect(playResponseCompleteSound).not.toHaveBeenCalled();
    expect(showBrowserNotification).not.toHaveBeenCalled();
  });
});
