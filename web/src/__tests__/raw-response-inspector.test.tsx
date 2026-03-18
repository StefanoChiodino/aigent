/**
 * RawResponseInspector modal — unit tests for visibility, content, and close behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';
import { useUIStore } from '../stores/ui';
import { RawResponseInspector } from '../components/modals/RawResponseInspector';
import type { DisplayMessage, RawTurnData } from '../types';

function makeRawTurn(overrides: Partial<RawTurnData> = {}): RawTurnData {
  return {
    iteration: 1,
    model: 'claude-sonnet-4-6',
    stopReason: 'end_turn',
    usage: { input: 1200, output: 300, cacheRead: 500, cacheWrite: 0 },
    contentBlocks: [{ type: 'text', text: 'Hello from the model.' }],
    provider: 'anthropic',
    completedAt: new Date('2025-01-01T12:00:00Z').toISOString(),
    ...overrides,
  };
}

function makeMessage(rawTurns: RawTurnData[]): DisplayMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: 'Hello from the model.',
    timestamp: new Date('2025-01-01T12:00:00Z').toISOString(),
    rawTurns,
  };
}

describe('RawResponseInspector', () => {
  beforeEach(() => {
    useUIStore.setState({ rawResponseMessage: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when rawResponseMessage is null', () => {
    const { container } = render(<RawResponseInspector />);
    expect(container.firstChild).toBeNull();
  });

  it('shows modal when message is set', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    expect(document.querySelector('.rri-modal')).not.toBeNull();
  });

  it('shows "Raw Response" header label', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    expect(screen.getByText('Raw Response')).toBeTruthy();
  });

  it('shows turn label with correct iteration and total', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([
        makeRawTurn({ iteration: 1 }),
        makeRawTurn({ iteration: 2, stopReason: 'end_turn' }),
      ]));
    });
    expect(screen.getByText('Turn 1 of 2')).toBeTruthy();
    expect(screen.getByText('Turn 2 of 2')).toBeTruthy();
  });

  it('shows model name', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn({ model: 'claude-opus-4-6' })]));
    });
    expect(screen.getByText('claude-opus-4-6')).toBeTruthy();
  });

  it('shows stop reason', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn({ stopReason: 'tool_use' })]));
    });
    expect(screen.getByText('tool_use')).toBeTruthy();
  });

  it('shows text content block', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn({
        contentBlocks: [{ type: 'text', text: 'This is the response text.' }],
      })]));
    });
    expect(screen.getByText('This is the response text.')).toBeTruthy();
  });

  it('shows tool_use block with tool name', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn({
        contentBlocks: [{ type: 'tool_use', id: 'tu-1', name: 'exec', input: { command: 'ls' } }],
      })]));
    });
    expect(screen.getByText('exec')).toBeTruthy();
  });

  it('shows thinking block toggle', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn({
        contentBlocks: [{ type: 'thinking', thinking: 'Deep thought.' }],
      })]));
    });
    // The toggle button should have "thinking" label
    const btn = document.querySelector('.rri-block-toggle');
    expect(btn?.textContent).toContain('thinking');
  });

  it('shows empty state when no content blocks', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn({ contentBlocks: [] })]));
    });
    expect(screen.getByText('No content blocks')).toBeTruthy();
  });

  it('close button clears the message', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    await act(async () => {
      (document.querySelector('.rri-close') as HTMLButtonElement)?.click();
    });
    expect(useUIStore.getState().rawResponseMessage).toBeNull();
  });

  it('closes on Escape key', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUIStore.getState().rawResponseMessage).toBeNull();
  });

  it('clicking backdrop closes the inspector', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    await act(async () => {
      (document.querySelector('.rri-overlay') as HTMLElement)?.click();
    });
    expect(useUIStore.getState().rawResponseMessage).toBeNull();
  });

  it('clicking modal body does not close the inspector', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    await act(async () => {
      (document.querySelector('.rri-modal') as HTMLElement)?.click();
    });
    expect(useUIStore.getState().rawResponseMessage).not.toBeNull();
  });

  it('Copy JSON button is present', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([makeRawTurn()]));
    });
    expect(document.querySelector('.rri-copy')).not.toBeNull();
  });

  it('shows empty state when rawTurns is empty', async () => {
    render(<RawResponseInspector />);
    await act(async () => {
      useUIStore.getState().setRawResponseMessage(makeMessage([]));
    });
    expect(screen.getByText('No raw turn data available.')).toBeTruthy();
  });
});
