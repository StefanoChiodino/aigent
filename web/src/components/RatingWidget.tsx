import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useRatingStore } from '../stores/rating';
import { useConnectionStore } from '../stores/connection';

interface Props {
  messageId: string;
}

export const RatingWidget = React.memo(function RatingWidget({ messageId }: Props) {
  const entry = useRatingStore(s => s.ratings[messageId]);
  const setRating = useRatingStore(s => s.setRating);
  const send = useConnectionStore(s => s.send);

  const [open, setOpen] = useState(false);
  const [hoverScore, setHoverScore] = useState(0);
  const [pendingScore, setPendingScore] = useState(entry?.score ?? 0);
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Sync pending state when popover opens
  const handleOpen = useCallback(() => {
    setPendingScore(entry?.score ?? 0);
    setNotes(entry?.notes ?? '');
    setHoverScore(0);
    setOpen(true);
  }, [entry]);

  // Close on outside click — but ignore clicks inside portal overlays
  // (e.g. permission modal rendered via createPortal to document.body).
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        (popoverRef.current && popoverRef.current.contains(target)) ||
        (triggerRef.current && triggerRef.current.contains(target))
      ) return;
      // Don't close when the user interacts with a portal overlay
      const permOverlay = document.getElementById('perm-overlay');
      if (permOverlay && permOverlay.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    }
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (pendingScore === 0) return;
    setRating(messageId, pendingScore, notes.trim() || undefined);
    send({ type: 'message_rating', messageId, rating: pendingScore, notes: notes.trim() || undefined });
    setOpen(false);
  }, [pendingScore, notes, messageId, setRating, send]);

  const handleClear = useCallback(() => {
    setRating(messageId, 0);
    send({ type: 'message_rating', messageId, rating: 0 });
    setOpen(false);
  }, [messageId, setRating, send]);

  const currentScore = entry?.score ?? 0;
  const displayScore = open ? (hoverScore || pendingScore) : currentScore;

  return (
    <span className={`rating-widget${currentScore > 0 ? ' rated' : ''}${open ? ' open' : ''}`}>
      <button
        ref={triggerRef}
        className={`rating-trigger${currentScore > 0 ? ' active' : ''}`}
        title="Rate this response"
        aria-label={currentScore > 0 ? `Rated ${currentScore}/5 — click to edit` : 'Rate this response'}
        onClick={handleOpen}
      >
        ★{currentScore > 0 && <span className="rating-trigger-score">{currentScore}</span>}
      </button>

      {open && (
        <div
          className="rating-popover"
          ref={popoverRef}
          role="dialog"
          aria-label="Rate response"
          onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
        >
          <div className="rating-popover-header">Rate this response</div>
          <div className="rating-popover-stars">
            {[1, 2, 3, 4, 5].map(v => (
              <button
                key={v}
                className={`rating-dot${v <= displayScore ? ' active' : ''}`}
                title={`${v}/5`}
                onClick={() => setPendingScore(v === pendingScore ? 0 : v)}
                onMouseEnter={() => setHoverScore(v)}
                onMouseLeave={() => setHoverScore(0)}
              >★</button>
            ))}
          </div>
          <textarea
            className="rating-notes"
            placeholder="Optional notes…"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            rows={2}
          />
          <div className="rating-popover-actions">
            <button
              className="perm-btn perm-approve"
              onClick={handleSubmit}
              disabled={pendingScore === 0}
            >
              Save
            </button>
            {currentScore > 0 && (
              <button className="perm-btn perm-deny" onClick={handleClear}>
                Clear
              </button>
            )}
            <button className="perm-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </span>
  );
});
