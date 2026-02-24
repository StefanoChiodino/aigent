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
    <div id="attachment-preview">
      {pendingAttachments.map(att => {
        const isImage = att.dataUrl && att.mediaType.startsWith('image/');
        return (
          <div key={att.id} className={`attachment-thumb ${isImage ? 'image-thumb' : 'file-badge'}`}>
            {isImage ? (
              <img src={att.dataUrl} alt={att.name} />
            ) : (
              <>
                <span className="file-icon">📄</span>
                <span className="file-info">
                  <span className="file-name">{att.name}</span>
                  <span className="file-size">{fmtSize(att.size)}</span>
                </span>
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
        );
      })}
    </div>
  );
});
