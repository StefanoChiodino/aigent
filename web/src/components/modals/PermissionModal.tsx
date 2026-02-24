import React, { useEffect, useState } from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';
import type { DiffFile } from '../../types';
import DiffViewer from './DiffViewer';
import { parseDiffIntoFiles } from '../../lib/diff';

const TYPE_ICONS: Record<string, string> = {
  mount: '📂',
  patch: '🩹',
  exec: '⚡',
  fetch: '🌐',
  config_write: '✏️',
};

export function PermissionModal() {
  const permQueue = useUIStore(s => s.permQueue);
  const resolvePermRequest = useUIStore(s => s.resolvePermRequest);
  const send = useConnectionStore(s => s.send);
  const [activeFileIdx, setActiveFileIdx] = useState(0);

  const req = permQueue[0] ?? null;

  useEffect(() => {
    setActiveFileIdx(0);
  }, [req?.id]);

  useEffect(() => {
    if (!req) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); resolvePermRequest(send, true); }
      else if (e.key === 'Escape') { e.preventDefault(); resolvePermRequest(send, false); }
      else if ((e.key === 'a' || e.key === 'A') && req.alwaysAllowCmd) {
        e.preventDefault();
        resolvePermRequest(send, true, true, false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [req, send, resolvePermRequest]);

  const isPatch = req?.type === 'patch';
  const isExec = req?.type === 'exec';
  const isFetch = req?.type === 'fetch';

  let diffFiles: DiffFile[] = req?.diffFiles ?? [];
  if (isPatch && diffFiles.length === 0 && req?.diff) {
    diffFiles = parseDiffIntoFiles(req.diff);
  }
  const activeFile = diffFiles[activeFileIdx] ?? null;
  const multiSegment = isExec && req?.segments && req.segments.length > 1;

  const overlayClass = [
    !req ? 'hidden' : '',
    isPatch ? 'patch-mode' : '',
    isExec ? 'exec-mode' : '',
    isFetch ? 'fetch-mode' : '',
  ].filter(Boolean).join(' ') || undefined;

  return (
    <div id="perm-overlay" className={overlayClass}>
      {req && (
        <div id="perm-card">
          <div id="perm-card-icon" className="perm-icon">{TYPE_ICONS[req.type] ?? '🔐'}</div>
          <div id="perm-card-title" className="perm-title">{req.title}</div>

          <div id="perm-card-detail" className="perm-detail">
            {multiSegment ? (
              <>
                <div className="exec-pipeline">
                  {req.segments!.map((seg, idx) => (
                    <React.Fragment key={idx}>
                      <span className={`exec-pipeline-token${seg.isSubshell ? ' is-subshell' : ''}`}>
                        <span className="exec-pipeline-exe">{seg.executable ?? '(subshell)'}</span>
                      </span>
                      {seg.operator && (
                        <span className="exec-pipeline-op">{seg.operator}</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
                <div className="exec-pipeline-full">{req.detail}</div>
              </>
            ) : (
              req.detail.split('\n').filter(Boolean).map((line, i) => (
                <div key={i}>{line}</div>
              ))
            )}
          </div>

          {req.body && (
            <div id="perm-card-body" className="perm-body">{req.body}</div>
          )}

          <div
            id="perm-card-duration"
            className={`perm-duration${req.durationMinutes == null ? ' hidden' : ''}`}
          >
            {req.durationMinutes != null && <>⏱ {req.durationMinutes} min (auto-expires)</>}
          </div>

          {isPatch && activeFile && (
            <div id="patch-viewer">
              {diffFiles.length >= 1 && (
                <div id="patch-file-list">
                  {diffFiles.map((file, idx) => {
                    const slashIdx = file.path.lastIndexOf('/');
                    return (
                      <button
                        key={idx}
                        className={`patch-file-item${idx === activeFileIdx ? ' active' : ''}`}
                        title={file.path}
                        onClick={() => setActiveFileIdx(idx)}
                      >
                        {slashIdx !== -1 && (
                          <div className="patch-file-dir">{file.path.slice(0, slashIdx + 1)}</div>
                        )}
                        <div className="patch-file-name">{file.path.slice(slashIdx + 1) || file.name}</div>
                      </button>
                    );
                  })}
                </div>
              )}
              <div id="perm-card-diff">
                <DiffViewer diffText={activeFile.content} />
              </div>
            </div>
          )}

          <div id="perm-card-actions">
            <button id="perm-approve-btn" className="perm-btn perm-approve" onClick={() => resolvePermRequest(send, true)}>
              Approve
            </button>
            <button id="perm-deny-btn" className="perm-btn perm-deny" onClick={() => resolvePermRequest(send, false)}>
              Deny
            </button>
            <button
              id="perm-always-allow-btn"
              className={`perm-btn perm-always-allow${req.alwaysAllowCmd ? '' : ' hidden'}`}
              onClick={() => req.alwaysAllowCmd && resolvePermRequest(send, true, true, false)}
            >
              Always Allow
            </button>
            <button
              id="perm-always-allow-domain-btn"
              className={`perm-btn perm-always-allow-domain${req.alwaysAllowDomainCmd ? '' : ' hidden'}`}
              onClick={() => req.alwaysAllowDomainCmd && resolvePermRequest(send, true, false, true)}
            >
              Always Allow Domain
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
