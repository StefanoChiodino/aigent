import React from 'react';
import { useConnectionStore } from '../stores/connection';
import { useUIStore } from '../stores/ui';

export const QueueChips = React.memo(function QueueChips() {
  const queuedMessages = useUIStore(s => s.queuedMessages);
  const send = useConnectionStore(s => s.send);

  if (queuedMessages.length === 0) return null;

  return (
    <div id="queue-chips">
      {queuedMessages.map(msg => (
        <div key={msg.id} className="queue-chip">
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
