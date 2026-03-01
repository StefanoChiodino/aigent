import React, { useCallback, useRef, useState } from 'react';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';

export const QueueChips = React.memo(function QueueChips() {
  const queuedMessages = useUIStore(s => s.queuedMessages);
  const send = useConnectionStore(s => s.send);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const onDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, idx: number) => {
    setDragIdx(idx);
    dragNodeRef.current = e.currentTarget;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
    // Make the dragged chip slightly transparent
    requestAnimationFrame(() => {
      if (dragNodeRef.current) dragNodeRef.current.classList.add('queue-chip-dragging');
    });
  }, []);

  const onDragEnd = useCallback(() => {
    if (dragNodeRef.current) dragNodeRef.current.classList.remove('queue-chip-dragging');
    dragNodeRef.current = null;
    setDragIdx(null);
    setOverIdx(null);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIdx(idx);
  }, []);

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>, dropIdx: number) => {
    e.preventDefault();
    const fromIdx = dragIdx;
    if (fromIdx === null || fromIdx === dropIdx) return;

    // Build reordered ID list
    const ids = queuedMessages.map(m => m.id);
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(dropIdx, 0, moved!);
    send({ type: 'reorder_queue', ids });

    setDragIdx(null);
    setOverIdx(null);
  }, [dragIdx, queuedMessages, send]);

  if (queuedMessages.length === 0) return null;

  return (
    <div id="queue-chips">
      {queuedMessages.map((msg, idx) => (
        <div
          key={msg.id}
          className={`queue-chip${overIdx === idx && dragIdx !== idx ? ' queue-chip-drop-target' : ''}`}
          draggable
          onDragStart={e => onDragStart(e, idx)}
          onDragEnd={onDragEnd}
          onDragOver={e => onDragOver(e, idx)}
          onDrop={e => onDrop(e, idx)}
        >
          <span className="queue-chip-handle" title="Drag to reorder">⠿</span>
          <span className="queue-chip-text">{msg.displayText}</span>
          <button
            className="queue-chip-remove"
            onClick={() => send({ type: 'cancel_queued', id: msg.id })}
            title="Cancel queued message"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
});
