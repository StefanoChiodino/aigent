/**
 * Rating widget — store state + component rendering.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useRatingStore } from '../stores/rating';
import { useConnectionStore } from '../stores/connection';
import { RatingWidget } from '../components/RatingWidget';

// ---------------------------------------------------------------------------
// Store tests
// ---------------------------------------------------------------------------

describe('Rating store', () => {
  beforeEach(() => {
    useRatingStore.setState({ ratings: {} });
  });

  it('setRating stores a rating entry for a message', () => {
    useRatingStore.getState().setRating('msg-1', 4);
    expect(useRatingStore.getState().ratings['msg-1']?.score).toBe(4);
  });

  it('setRating with 0 removes the rating', () => {
    useRatingStore.getState().setRating('msg-1', 3);
    useRatingStore.getState().setRating('msg-1', 0);
    expect(useRatingStore.getState().ratings['msg-1']).toBeUndefined();
  });

  it('setRating for different messages are independent', () => {
    useRatingStore.getState().setRating('msg-1', 5);
    useRatingStore.getState().setRating('msg-2', 2);
    expect(useRatingStore.getState().ratings['msg-1']?.score).toBe(5);
    expect(useRatingStore.getState().ratings['msg-2']?.score).toBe(2);
  });

  it('clearRatings empties all ratings', () => {
    useRatingStore.getState().setRating('msg-1', 5);
    useRatingStore.getState().setRating('msg-2', 3);
    useRatingStore.getState().clearRatings();
    expect(useRatingStore.getState().ratings).toEqual({});
  });

  it('setRating overwrites previous value', () => {
    useRatingStore.getState().setRating('msg-1', 2);
    useRatingStore.getState().setRating('msg-1', 4);
    expect(useRatingStore.getState().ratings['msg-1']?.score).toBe(4);
  });

  it('setRating stores optional notes', () => {
    useRatingStore.getState().setRating('msg-1', 4, 'great response');
    expect(useRatingStore.getState().ratings['msg-1']?.notes).toBe('great response');
  });

  it('setRating without notes sets notes as undefined', () => {
    useRatingStore.getState().setRating('msg-1', 3);
    expect(useRatingStore.getState().ratings['msg-1']?.notes).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Component tests
// ---------------------------------------------------------------------------

describe('RatingWidget component', () => {
  const mockSend = vi.fn();

  beforeEach(() => {
    useRatingStore.setState({ ratings: {} });
    useConnectionStore.setState({ send: mockSend });
    mockSend.mockClear();
  });

  it('renders a trigger button', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const trigger = container.querySelector('.rating-trigger');
    expect(trigger).toBeTruthy();
  });

  it('does not show popover by default', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const popover = container.querySelector('.rating-popover');
    expect(popover).toBeNull();
  });

  it('opens popover on trigger click', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const trigger = container.querySelector('.rating-trigger')!;
    fireEvent.click(trigger);
    const popover = container.querySelector('.rating-popover');
    expect(popover).toBeTruthy();
  });

  it('popover contains 5 rating dots', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    fireEvent.click(container.querySelector('.rating-trigger')!);
    const dots = container.querySelectorAll('.rating-dot');
    expect(dots).toHaveLength(5);
  });

  it('save button sends message_rating via WebSocket', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    // Open popover
    fireEvent.click(container.querySelector('.rating-trigger')!);
    // Click 3rd star
    const dots = container.querySelectorAll('.rating-dot');
    fireEvent.click(dots[2]!);
    // Click save
    const saveBtn = container.querySelector('.perm-btn.perm-approve')!;
    fireEvent.click(saveBtn);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message_rating',
        messageId: 'msg-1',
        rating: 3,
      })
    );
  });

  it('adds rated class when rating is set', () => {
    useRatingStore.getState().setRating('msg-1', 5);
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const widget = container.querySelector('.rating-widget');
    expect(widget?.classList.contains('rated')).toBe(true);
  });

  it('does not have rated class when no rating', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const widget = container.querySelector('.rating-widget');
    expect(widget?.classList.contains('rated')).toBe(false);
  });

  it('trigger shows score when rated', () => {
    useRatingStore.getState().setRating('msg-1', 4);
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const score = container.querySelector('.rating-trigger-score');
    expect(score?.textContent).toBe('4');
  });

  it('trigger has active class when rated', () => {
    useRatingStore.getState().setRating('msg-1', 3);
    const { container } = render(<RatingWidget messageId="msg-1" />);
    const trigger = container.querySelector('.rating-trigger');
    expect(trigger?.classList.contains('active')).toBe(true);
  });

  it('popover has a notes textarea', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    fireEvent.click(container.querySelector('.rating-trigger')!);
    const textarea = container.querySelector('.rating-notes');
    expect(textarea).toBeTruthy();
  });

  it('each dot has a title attribute showing its value', () => {
    const { container } = render(<RatingWidget messageId="msg-1" />);
    fireEvent.click(container.querySelector('.rating-trigger')!);
    const dots = container.querySelectorAll('.rating-dot');
    expect(dots[0]?.getAttribute('title')).toBe('1/5');
    expect(dots[4]?.getAttribute('title')).toBe('5/5');
  });
});
