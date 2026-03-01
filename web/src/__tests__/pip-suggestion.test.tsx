/**
 * PiP suggestion prompt — tests for the pip_suggestion type in PermissionModal
 * and the "Float & Approve" button on browser_write requests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, act, fireEvent, screen } from '@testing-library/react';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';
import { PermissionModal } from '../components/modals/PermissionModal';
import type { PermRequest } from '../types';

// Mock usePiP module — control pipSupported / isPiPOpen from tests
const mockTryOpenPiP = vi.fn(async () => true);
const mockIsPiPOpen = vi.fn(() => false);
let mockPipSupported = true;

vi.mock('../hooks/usePiP', () => ({
  tryOpenPiP: (...args: unknown[]) => mockTryOpenPiP(...args),
  isPiPOpen: () => mockIsPiPOpen(),
  get pipSupported() { return mockPipSupported; },
}));

function fakeWs() {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
}

function sentPayloads(ws: WebSocket): Record<string, unknown>[] {
  return (ws.send as ReturnType<typeof vi.fn>).mock.calls.map(
    (call: unknown[]) => JSON.parse(call[0] as string) as Record<string, unknown>,
  );
}

describe('PiP suggestion prompt', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    useUIStore.setState({ permQueue: [], permShowing: false });
    vi.clearAllMocks();
    mockPipSupported = true;
    mockIsPiPOpen.mockReturnValue(false);
    mockTryOpenPiP.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  function enqueuePipSuggestion(id = 'pip_test1') {
    useUIStore.getState().enqueuePermRequest({
      type: 'pip_suggestion',
      id,
      title: 'Float chat?',
      detail: 'Agent is about to switch tabs',
      approveCmd: '',
      denyCmd: '',
    } as PermRequest);
  }

  function enqueueBrowserWrite(overrides: Partial<PermRequest> = {}) {
    useUIStore.getState().enqueuePermRequest({
      type: 'browser_write',
      id: 'bw-1',
      title: 'navigate to https://example.com',
      detail: 'Navigate tab',
      approveCmd: '/approve-browser bw-1',
      denyCmd: '/deny-browser bw-1',
      ...overrides,
    } as PermRequest);
  }

  it('renders Float & Continue and Skip buttons for pip_suggestion', () => {
    enqueuePipSuggestion();
    render(<PermissionModal />);

    expect(screen.getByText('Float & Continue')).toBeTruthy();
    expect(screen.getByText('Skip')).toBeTruthy();
    // Should NOT show Approve/Deny
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Deny')).toBeNull();
  });

  it('Float & Continue calls tryOpenPiP and sends float response', async () => {
    enqueuePipSuggestion('pip_f1');
    render(<PermissionModal />);

    await act(async () => {
      fireEvent.click(screen.getByText('Float & Continue'));
    });

    expect(mockTryOpenPiP).toHaveBeenCalledTimes(1);
    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({
      type: 'pip_suggestion_response',
      id: 'pip_f1',
      action: 'float',
    });
    // Request should be dismissed
    expect(useUIStore.getState().permQueue).toHaveLength(0);
  });

  it('Skip sends skip response without opening PiP', async () => {
    enqueuePipSuggestion('pip_s1');
    render(<PermissionModal />);

    await act(async () => {
      fireEvent.click(screen.getByText('Skip'));
    });

    expect(mockTryOpenPiP).not.toHaveBeenCalled();
    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({
      type: 'pip_suggestion_response',
      id: 'pip_s1',
      action: 'skip',
    });
    expect(useUIStore.getState().permQueue).toHaveLength(0);
  });

  it('Enter key triggers Float & Continue for pip_suggestion', async () => {
    enqueuePipSuggestion('pip_k1');
    render(<PermissionModal />);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', code: 'Enter', bubbles: true });
    });

    expect(mockTryOpenPiP).toHaveBeenCalledTimes(1);
    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({
      type: 'pip_suggestion_response',
      id: 'pip_k1',
      action: 'float',
    });
  });

  it('Escape key triggers Skip for pip_suggestion', async () => {
    enqueuePipSuggestion('pip_k2');
    render(<PermissionModal />);

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape', bubbles: true });
    });

    expect(mockTryOpenPiP).not.toHaveBeenCalled();
    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({
      type: 'pip_suggestion_response',
      id: 'pip_k2',
      action: 'skip',
    });
  });

  it('shows the pip_suggestion icon and title', () => {
    enqueuePipSuggestion();
    render(<PermissionModal />);

    expect(screen.getByText('Float chat?')).toBeTruthy();
    expect(screen.getByText('Agent is about to switch tabs')).toBeTruthy();
  });
});

describe('Float & Approve button on browser_write', () => {
  let ws: WebSocket;

  beforeEach(() => {
    ws = fakeWs();
    useConnectionStore.setState({ status: 'connected', ws, reconnectAttempt: 0 });
    useUIStore.setState({ permQueue: [], permShowing: false });
    vi.clearAllMocks();
    mockPipSupported = true;
    mockIsPiPOpen.mockReturnValue(false);
    mockTryOpenPiP.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  function enqueueBrowserWrite(overrides: Partial<PermRequest> = {}) {
    useUIStore.getState().enqueuePermRequest({
      type: 'browser_write',
      id: 'bw-1',
      title: 'navigate to https://example.com',
      detail: 'Navigate tab to example.com',
      approveCmd: '/approve-browser bw-1',
      denyCmd: '/deny-browser bw-1',
      ...overrides,
    } as PermRequest);
  }

  it('shows Float & Approve for navigate actions when PiP is supported and not open', () => {
    enqueueBrowserWrite();
    render(<PermissionModal />);

    expect(screen.getByText('Float & Approve')).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
  });

  it('hides Float & Approve when PiP is already open', () => {
    mockIsPiPOpen.mockReturnValue(true);
    enqueueBrowserWrite();
    render(<PermissionModal />);

    expect(screen.queryByText('Float & Approve')).toBeNull();
    // Regular Approve/Deny should still show
    expect(screen.getByText('Approve')).toBeTruthy();
  });

  it('hides Float & Approve when PiP is not supported', () => {
    mockPipSupported = false;
    enqueueBrowserWrite();
    render(<PermissionModal />);

    expect(screen.queryByText('Float & Approve')).toBeNull();
  });

  it('hides Float & Approve for non-navigate actions', () => {
    enqueueBrowserWrite({ title: 'run_script on example.com' });
    render(<PermissionModal />);

    expect(screen.queryByText('Float & Approve')).toBeNull();
  });

  it('Float & Approve calls tryOpenPiP and then approves', async () => {
    enqueueBrowserWrite();
    render(<PermissionModal />);

    await act(async () => {
      fireEvent.click(screen.getByText('Float & Approve'));
    });

    expect(mockTryOpenPiP).toHaveBeenCalledTimes(1);
    const payloads = sentPayloads(ws);
    expect(payloads).toContainEqual({
      type: 'command',
      cmd: '/approve-browser bw-1',
    });
    expect(useUIStore.getState().permQueue).toHaveLength(0);
  });

  it('shows Float & Approve for open_tab actions', () => {
    enqueueBrowserWrite({ title: 'open tab https://google.com' });
    render(<PermissionModal />);

    expect(screen.getByText('Float & Approve')).toBeTruthy();
  });
});
