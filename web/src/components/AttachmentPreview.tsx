import React from 'react';
import { useUIStore } from '../stores/ui';

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const AttachmentPreview = React.memo(function AttachmentPreview() {
  const pendingAttachments = useUIStore(s => s.pendingAttachments);
  const removeAttachment = useUIStore(s => s.removeAttachment);

  if (pendingAttachments.length === 0) return null;

  return (
    <div className="attachment-preview">
      {pendingAttachments.map(att => (
        <div key={att.id} className="attachment-chip">
          {att.dataUrl && att.mediaType.startsWith('image/') ? (
            <img className="attachment-chip-img" src={att.dataUrl} alt={att.name} />
          ) : (
            <>
              <span className="attachment-chip-name">{att.name}</span>
              <span className="attachment-chip-size">{fmtSize(att.size)}</span>
            </>
          )}
          <button
            className="attachment-remove"
            onClick={() => removeAttachment(att.id)}
            title="Remove"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
});
