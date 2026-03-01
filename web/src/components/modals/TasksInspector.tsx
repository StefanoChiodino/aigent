import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useUIStore } from '../../stores/ui';
import { useChatStore } from '../../stores/chat';
import { renderMarkdown } from '../../lib/markdown';
import type { BackgroundTaskInfo } from '../../types';

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDateShort(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="tski-copy"
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      title="Copy to clipboard"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function TaskRow({ task }: { task: BackgroundTaskInfo }) {
  const [expanded, setExpanded] = useState(false);

  const statusChar =
    task.status === 'running' ? '\u25B6' :
    task.status === 'completed' ? '\u2713' :
    task.status === 'cancelled' ? '\u2014' : '\u2717';

  const tokTotal = (task.inputTokens ?? 0) + (task.outputTokens ?? 0);
  const costStr = task.cost !== undefined && task.cost > 0
    ? (task.cost < 0.01 ? `$${task.cost.toFixed(4)}` : `$${task.cost.toFixed(3)}`)
    : null;

  const rendered = useMemo(
    () => task.result ? renderMarkdown(task.result) : '',
    [task.result]
  );

  const prompt = task.context
    ? `${task.description}\n\nContext: ${task.context}`
    : task.description;

  const renderedPrompt = useMemo(
    () => renderMarkdown(prompt),
    [prompt]
  );

  return (
    <div className="tski-row-wrap">
      <div className="tski-row" onClick={() => setExpanded(e => !e)}>
        <span className={`tski-status tski-status-${task.status}`}>{statusChar}</span>
        <span className="tski-desc" title={task.description}>{task.description}</span>
        <span className="tski-date">{fmtDateShort(task.startedAt)}</span>
        <span className="tski-model">{task.model ? modelDisplayName(task.model) : '--'}</span>
        <span className="tski-tokens">{tokTotal > 0 ? tokTotal.toLocaleString() : '--'}</span>
        <span className="tski-cost">{costStr ?? '--'}</span>
        <span className="tski-chevron">{expanded ? '\u2304' : '\u203A'}</span>
      </div>
      {expanded && (
        <div className="tski-detail">
          <div className="tski-meta">
            <div className="tski-meta-row">
              <span className="tim-key">ID</span>
              <span className="tim-val tim-monospace">{task.id}</span>
            </div>
            {task.model && (
              <div className="tski-meta-row">
                <span className="tim-key">Model</span>
                <span className="tim-val">{modelDisplayName(task.model)}</span>
              </div>
            )}
            {(task.inputTokens !== undefined || task.outputTokens !== undefined) && (
              <div className="tski-meta-row">
                <span className="tim-key">Tokens</span>
                <span className="tim-val">
                  {(task.inputTokens ?? 0).toLocaleString()} in / {(task.outputTokens ?? 0).toLocaleString()} out
                </span>
              </div>
            )}
            {costStr && (
              <div className="tski-meta-row">
                <span className="tim-key">Cost</span>
                <span className="tim-val">{costStr}</span>
              </div>
            )}
            {task.delivery && (
              <div className="tski-meta-row">
                <span className="tim-key">Delivery</span>
                <span className="tim-val">{task.delivery}</span>
              </div>
            )}
            <div className="tski-meta-row">
              <span className="tim-key">Status</span>
              <span className={`tim-val tim-status-${task.status}`}>{task.status}</span>
            </div>
            <div className="tski-meta-row">
              <span className="tim-key">Started</span>
              <span className="tim-val">{fmtDateTime(task.startedAt)}</span>
            </div>
            <div className="tski-meta-row">
              <span className="tim-key">Elapsed</span>
              <span className="tim-val">{fmtElapsed(task.startedAt, task.completedAt)}</span>
            </div>
          </div>

          <div className="tski-section">
            <div className="tski-section-header">
              <span className="tski-section-label">Prompt</span>
              <CopyButton text={prompt} />
            </div>
            <div
              className="tski-section-body tski-prompt-md message-content"
              dangerouslySetInnerHTML={{ __html: renderedPrompt }}
            />
          </div>

          <div className="tski-section">
            <div className="tski-section-header">
              <span className="tski-section-label">Result</span>
              {task.result && <CopyButton text={task.result} />}
            </div>
            {task.result ? (
              <div
                className="tski-section-body tski-result-md message-content"
                dangerouslySetInnerHTML={{ __html: rendered }}
              />
            ) : (
              <div className="tski-section-body tski-no-result">
                {task.status === 'running' ? 'Task is still running...' : 'No result available.'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function TasksInspector() {
  const open = useUIStore(s => s.tasksInspectorOpen);
  const setOpen = useUIStore(s => s.setTasksInspectorOpen);
  const taskHistory = useChatStore(s => s.taskHistory);
  const clearTaskHistory = useChatStore(s => s.clearTaskHistory);

  const close = useCallback(() => setOpen(false), [setOpen]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  const sorted = [...taskHistory].reverse();

  const totalCost = taskHistory.reduce((s, t) => s + (t.cost ?? 0), 0);
  const totalTokens = taskHistory.reduce((s, t) => s + (t.inputTokens ?? 0) + (t.outputTokens ?? 0), 0);

  return (
    <div
      className="tski-backdrop"
      onClick={e => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="tski-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="tski-header">
          <span className="tski-header-label">Tasks Inspector</span>
          <div className="tski-header-actions">
            {taskHistory.length > 0 && (
              <button className="tski-clear" onClick={clearTaskHistory} title="Clear task history">Clear</button>
            )}
            <button className="tski-close" onClick={close} title="Close (Esc)">&times;</button>
          </div>
        </div>
        <div className="tski-summary">
          {taskHistory.length} task{taskHistory.length !== 1 ? 's' : ''}
          {totalTokens > 0 && <> &middot; {totalTokens.toLocaleString()} tokens</>}
          {totalCost > 0 && <> &middot; {totalCost < 0.01 ? `$${totalCost.toFixed(4)}` : `$${totalCost.toFixed(3)}`}</>}
        </div>
        <div className="tski-body">
          {sorted.length === 0 ? (
            <div className="tski-empty">No tasks dispatched yet.</div>
          ) : (
            <>
              <div className="tski-col-headers">
                <span />
                <span className="tski-col-h">Task</span>
                <span className="tski-col-h">Date</span>
                <span className="tski-col-h">Model</span>
                <span className="tski-col-h tski-col-r">Tokens</span>
                <span className="tski-col-h tski-col-r">Cost</span>
                <span />
              </div>
              {sorted.map(t => <TaskRow key={t.id} task={t} />)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
