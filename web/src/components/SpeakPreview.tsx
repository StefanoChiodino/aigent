import React, { useRef, useState, useCallback } from 'react';

interface Props {
  content: string;
  streaming?: boolean;
}

/**
 * Speak-preview icon with a fixed-position tooltip that stays within the viewport.
 * Uses position:fixed so the tooltip escapes the scroll container and never gets clipped.
 */
export const SpeakPreview = React.memo(function SpeakPreview({ content, streaming }: Props) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    const el = iconRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const GAP = 6;
    // Try below the icon first
    let top = rect.bottom + GAP;
    const tipHeight = 80; // approximate max height
    if (top + tipHeight > window.innerHeight) {
      // Not enough room below — place above
      top = rect.top - GAP - tipHeight;
    }
    // Clamp to viewport top
    if (top < 4) top = 4;
    // Left-align to icon, clamp to viewport
    let left = rect.left;
    const tipWidth = 360;
    if (left + tipWidth > window.innerWidth - 8) {
      left = window.innerWidth - tipWidth - 8;
    }
    if (left < 4) left = 4;
    setPos({ top, left });
  }, []);

  const hide = useCallback(() => setPos(null), []);

  return (
    <span
      ref={iconRef}
      className={`speak-preview${streaming ? ' streaming-speak' : ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      {pos && (
        <span
          className="speak-preview-tooltip"
          style={{ position: 'fixed', top: pos.top, left: pos.left, display: 'block' }}
        >
          {content}
        </span>
      )}
    </span>
  );
});
