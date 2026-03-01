/**
 * Queue chips — store state + component rendering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useUIStore } from '../stores/ui';
import { useConnectionStore } from '../stores/connection';
import { QueueChips } from '../components/QueueChips';

describe('Queue chips store', () => {
  beforeEach(() => {
    useUIStore.setState({ queuedMessages: [] });
  });

  it('setQueuedMessages sets queue', () => {
    useUIStore.getState().setQueuedMessages([
      { id: 1, displayText: 'first' },
      { id: 2, displayText: 'second' },
    ]);
    expect(useUIStore.getState().queuedMessages).toHaveLength(2);
    expect(useUIStore.getState().queuedMessages[0]!.displayText).toBe('first');
  });

  it('setQueuedMessages clears queue', () => {
    useUIStore.getState().setQueuedMessages([{ id: 1, displayText: 'msg' }]);
    useUIStore.getState().setQueuedMessages([]);
    expect(useUIStore.getState().queuedMessages).toHaveLength(0);
  });
});

describe('QueueChips component', () => {
  const mockSend = vi.fn();

  beforeEach(() => {
    useUIStore.setState({ queuedMessages: [] });
    useConnectionStore.setState({ send: mockSend });
    mockSend.mockClear();
  });

  it('renders nothing when queue is empty', () => {
    const { container } = render(<QueueChips />);
    expect(container.querySelector('#queue-chips')).toBeNull();
  });

  it('renders chips for each queued message', () => {
    useUIStore.setState({
      queuedMessages: [
        { id: 1, displayText: 'Add tests' },
        { id: 2, displayText: 'Fix bug' },
      ],
    });
    render(<QueueChips />);
    expect(screen.getByText('Add tests')).toBeTruthy();
    expect(screen.getByText('Fix bug')).toBeTruthy();
  });

  it('dismiss button sends cancel_queued with correct ID', () => {
    useUIStore.setState({
      queuedMessages: [{ id: 42, displayText: 'Pending message' }],
    });
    render(<QueueChips />);
    const dismissBtn = screen.getByTitle('Cancel queued message');
    fireEvent.click(dismissBtn);
    expect(mockSend).toHaveBeenCalledWith({ type: 'cancel_queued', id: 42 });
  });

  it('renders multiple dismiss buttons for multiple chips', () => {
    useUIStore.setState({
      queuedMessages: [
        { id: 1, displayText: 'first' },
        { id: 2, displayText: 'second' },
      ],
    });
    render(<QueueChips />);
    const dismissBtns = screen.getAllByTitle('Cancel queued message');
    expect(dismissBtns).toHaveLength(2);
  });

  it('chips are draggable', () => {
    useUIStore.setState({
      queuedMessages: [
        { id: 1, displayText: 'first' },
        { id: 2, displayText: 'second' },
      ],
    });
    const { container } = render(<QueueChips />);
    const chips = container.querySelectorAll('.queue-chip');
    expect(chips[0]!.getAttribute('draggable')).toBe('true');
    expect(chips[1]!.getAttribute('draggable')).toBe('true');
  });

  it('renders drag handles', () => {
    useUIStore.setState({
      queuedMessages: [
        { id: 1, displayText: 'first' },
        { id: 2, displayText: 'second' },
      ],
    });
    const { container } = render(<QueueChips />);
    const handles = container.querySelectorAll('.queue-chip-handle');
    expect(handles).toHaveLength(2);
  });

  it('drop sends reorder_queue with new ID order', () => {
    useUIStore.setState({
      queuedMessages: [
        { id: 1, displayText: 'first' },
        { id: 2, displayText: 'second' },
        { id: 3, displayText: 'third' },
      ],
    });
    const { container } = render(<QueueChips />);
    const chips = container.querySelectorAll('.queue-chip');

    // Simulate drag chip 0 onto chip 2 (move first to third)
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: vi.fn(), getData: vi.fn() };
    fireEvent.dragStart(chips[0]!, { dataTransfer });
    fireEvent.dragOver(chips[2]!, { dataTransfer });
    fireEvent.drop(chips[2]!, { dataTransfer });

    expect(mockSend).toHaveBeenCalledWith({
      type: 'reorder_queue',
      ids: [2, 3, 1],
    });
  });
});
