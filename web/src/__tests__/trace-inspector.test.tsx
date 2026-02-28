/**
 * TraceInspector modal — unit tests for visibility, content, and close behaviour.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, act, screen } from '@testing-library/react';
import { useUIStore } from '../stores/ui';
import { TraceInspector } from '../components/modals/TraceInspector';
import type { TraceEntry } from '../types';

function makeToolTrace(overrides: Partial<Extract<TraceEntry, { type: 'tool' }>> = {}): TraceEntry {
  return {
    id: 'trace-1',
    type: 'tool',
    toolName: 'exec',
    toolSummary: '$ ls -la',
    toolInput: '{"command":"ls -la"}',
    toolOutput: 'file.txt\ndir/',
    running: false,
    ...overrides,
  };
}

function makeThinkingTrace(): TraceEntry {
  return {
    id: 'trace-2',
    type: 'thinking',
    text: 'Let me think about this carefully.',
    running: false,
  };
}

describe('TraceInspector', () => {
  beforeEach(() => {
    useUIStore.setState({ traceInspectorTrace: null });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when traceInspectorTrace is null', () => {
    const { container } = render(<TraceInspector />);
    expect(container.firstChild).toBeNull();
  });

  it('shows modal when trace is set', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace());
    });
    expect(document.querySelector('.ti-modal')).not.toBeNull();
  });

  it('shows "Tool Inspector" header label', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace());
    });
    expect(screen.getByText('Tool Inspector')).toBeTruthy();
  });

  it('shows tool name for tool traces', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace({ toolName: 'read_file' }));
    });
    expect(document.querySelector('.ti-name')?.textContent).toBe('Read File');
  });

  it('shows tool summary when different from tool name', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace({ toolSummary: '$ git status' }));
    });
    expect(screen.getByText('$ git status')).toBeTruthy();
  });

  it('shows Input section when toolInput is present', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace({ toolInput: '{"command":"pwd"}' }));
    });
    expect(screen.getByText('Input')).toBeTruthy();
  });

  it('shows Output section when toolOutput is non-empty', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace({ toolOutput: '/home/user' }));
    });
    expect(screen.getByText('Output')).toBeTruthy();
  });

  it('shows Reasoning label for thinking traces', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeThinkingTrace());
    });
    expect(screen.getByText('Reasoning')).toBeTruthy();
  });

  it('shows thinking text content', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeThinkingTrace());
    });
    expect(screen.getByText('Let me think about this carefully.')).toBeTruthy();
  });

  it('close button (×) clears the trace', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace());
    });
    await act(async () => {
      (document.querySelector('.ti-close') as HTMLButtonElement)?.click();
    });
    expect(useUIStore.getState().traceInspectorTrace).toBeNull();
  });

  it('closes on Escape key', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace());
    });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useUIStore.getState().traceInspectorTrace).toBeNull();
  });

  it('clicking backdrop closes the inspector', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace());
    });
    await act(async () => {
      (document.querySelector('.ti-backdrop') as HTMLElement)?.click();
    });
    expect(useUIStore.getState().traceInspectorTrace).toBeNull();
  });

  it('clicking modal body does not close the inspector', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace());
    });
    await act(async () => {
      (document.querySelector('.ti-modal') as HTMLElement)?.click();
    });
    expect(useUIStore.getState().traceInspectorTrace).not.toBeNull();
  });

  it('does not show Output section when output is empty', async () => {
    render(<TraceInspector />);
    await act(async () => {
      useUIStore.getState().setTraceInspectorTrace(makeToolTrace({ toolOutput: '' }));
    });
    // Output section header should not be present
    expect(screen.queryByText('Output')).toBeNull();
  });
});
