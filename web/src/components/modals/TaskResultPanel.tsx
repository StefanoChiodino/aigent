import React, { useCallback, useEffect, useMemo } from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';
import { renderMarkdown } from '../../lib/markdown';

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtElapsed(startedAt: string, completedAt?: string): string {
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function modelDisplayName(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/);
  if (m) {
    const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  return id.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

export function TaskResultPanel() {
  const task = useUIStore(s => s.taskResultTask);
  const setTaskResultTask = useUIStore(s => s.setTaskResultTask);
  const send = useConnectionStore(s => s.send);

  const rendered = useMemo(() => task?.result ? renderMarkdown(task.result) : '', [task?.result]);

  const isUserPullDone = task?.delivery === 'user-pull' &&
    (task.status === 'completed' || task.status === 'failed') && !!task.result;

  const close = useCallback(() => setTaskResultTask(null), [setTaskResultTask]);

  useEffect(() => {
    if (!task) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [task, close]);

  function discuss() {
    close();
    send({
      type: 'message',
      content: `Let's discuss the result of the background task: "${task!.description}"`,
    });
  }

  if (!task) return null;

  return (
    <div className="task-result-backdrop" onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div id="task-result-panel" className="task-result-panel" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
          <div className="task-result-header">
            <span className="task-result-title">{task.description}</span>
          </div>

          <div className="task-inspect-meta">
            <div className="task-inspect-meta-row">
              <span className="tim-key">ID</span>
              <span className="tim-val tim-monospace">{task.id}</span>
            </div>
            {task.model && (
              <div className="task-inspect-meta-row">
                <span className="tim-key">Model</span>
                <span className="tim-val">{modelDisplayName(task.model)}</span>
              </div>
            )}
            {(task.inputTokens !== undefined || task.outputTokens !== undefined) && (
              <div className="task-inspect-meta-row">
                <span className="tim-key">Tokens</span>
                <span className="tim-val">
                  {(task.inputTokens ?? 0).toLocaleString()} in / {(task.outputTokens ?? 0).toLocaleString()} out
                </span>
              </div>
            )}
            {task.cost !== undefined && task.cost > 0 && (
              <div className="task-inspect-meta-row">
                <span className="tim-key">Cost</span>
                <span className="tim-val">{task.cost < 0.01 ? `$${task.cost.toFixed(4)}` : `$${task.cost.toFixed(3)}`}</span>
              </div>
            )}
            {task.delivery && (
              <div className="task-inspect-meta-row">
                <span className="tim-key">Delivery</span>
                <span className="tim-val">{task.delivery}</span>
              </div>
            )}
            <div className="task-inspect-meta-row">
              <span className="tim-key">Status</span>
              <span className={`tim-val tim-status-${task.status}`}>{task.status}</span>
            </div>
            <div className="task-inspect-meta-row">
              <span className="tim-key">Started</span>
              <span className="tim-val">{fmtTime(task.startedAt)}</span>
            </div>
            <div className="task-inspect-meta-row">
              <span className="tim-key">Elapsed</span>
              <span className="tim-val">{fmtElapsed(task.startedAt, task.completedAt)}</span>
            </div>
          </div>

          {task.result ? (
            <div className="task-result-body message-content" dangerouslySetInnerHTML={{ __html: rendered }} />
          ) : (
            <div className="task-result-body task-result-empty">
              {task.status === 'running' ? 'Task is still running…' : 'No result available.'}
            </div>
          )}

          <div className="task-result-footer">
            {isUserPullDone ? (
              <>
                <button className="task-result-defer" onClick={close}>
                  Defer
                </button>
                <button className="task-result-discuss" onClick={discuss}>
                  Discuss with agent
                </button>
              </>
            ) : (
              <button className="task-result-defer" onClick={close}>
                Close
              </button>
            )}
          </div>
      </div>
    </div>
  );
}
