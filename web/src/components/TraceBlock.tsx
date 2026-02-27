import React, { useState } from 'react';
import type { TraceEntry } from '../types';

function toolIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('read') || n.includes('view') || n.includes('cat')) return '📄';
  if (n.includes('write') || n.includes('create') || n.includes('save')) return '✏️';
  if (n.includes('edit') || n.includes('patch') || n.includes('replace')) return '🔧';
  if (n.includes('exec') || n.includes('run') || n.includes('bash') || n.includes('shell')) return '⚡';
  if (n.includes('search') || n.includes('grep') || n.includes('find') || n.includes('glob')) return '🔍';
  if (n.includes('fetch') || n.includes('http') || n.includes('web') || n.includes('url')) return '🌐';
  if (n.includes('list') || n.includes('ls') || n.includes('dir')) return '📂';
  if (n.includes('delete') || n.includes('remove') || n.includes('rm')) return '🗑️';
  if (n.includes('move') || n.includes('rename') || n.includes('mv')) return '📦';
  if (n.includes('git')) return '🔀';
  if (n.includes('agent') || n.includes('task') || n.includes('spawn')) return '🤖';
  if (n.includes('think') || n.includes('reason')) return '💭';
  return '🛠️';
}

function prettyToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function classifierBadge(meta: { tier: number; action: string; reason: string }): { icon: string; label: string } {
  const tierLabel = `T${meta.tier}`;
  if (meta.action === 'allow') return { icon: '🛡️', label: `${tierLabel}: ${meta.reason}` };
  if (meta.action === 'block') return { icon: '🚫', label: `${tierLabel} blocked: ${meta.reason}` };
  return { icon: '⚠️', label: `${tierLabel}: ${meta.reason}` };
}

/** Shorten a full model ID to a readable name, e.g. "claude-sonnet-4-6" → "sonnet 4.6" */
function shortModelName(model: string): string {
  const m = model.replace(/^claude-/, '');
  // Match pattern like "opus-4-6", "sonnet-4-6", "haiku-4-5-20251001"
  const match = m.match(/^(\w+)-(\d+)-(\d+)/);
  if (match) return `${match[1]} ${match[2]}.${match[3]}`;
  return m;
}

interface Props {
  trace: TraceEntry;
}

export function TraceBlock({ trace }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (trace.type === 'thinking') {
    return (
      <div className={`thinking-block${trace.running ? ' running' : ' done'}${expanded ? ' expanded' : ''}`}>
        <button className="thinking-toggle" onClick={() => setExpanded(e => !e)}>
          {trace.running ? (
            <><span className="thinking-anim"><span/><span/><span/></span>Reasoning…</>
          ) : (
            <>💭 Reasoned <span className="trace-expand-hint">▸</span></>
          )}
        </button>
        <div className={`thinking-body${expanded ? '' : ' hidden'}`}>
          {trace.text}
        </div>
      </div>
    );
  }

  // tool trace
  const inputFormatted = (() => {
    try { return JSON.stringify(JSON.parse(trace.toolInput), null, 2); }
    catch { return trace.toolInput; }
  })();

  const isDispatchTask = trace.toolName === 'dispatch_task';
  const isAgentTool = trace.toolName === 'spawn_agent' || isDispatchTask;
  const blockClass = isDispatchTask ? 'task-block' : 'tool-block';
  const hasAgentMeta = isAgentTool && (trace.model || (trace.thinking && trace.thinking !== 'off'));

  return (
    <div className={`${blockClass}${trace.running ? ' running' : ' done'}${expanded ? ' expanded' : ''}`}>
      <button className="tool-header" onClick={() => setExpanded(e => !e)}>
        <span className="tool-icon">{toolIcon(trace.toolName)}</span>
        <span className="tool-status-icon">
          {trace.running
            ? <span className="tool-mini-spinner" />
            : <span className="tool-checkmark">✓</span>
          }
        </span>
        <span className="tool-name">{prettyToolName(trace.toolName)}</span>
        {trace.toolSummary && trace.toolSummary !== trace.toolName && (
          <span className="tool-summary">{trace.toolSummary}</span>
        )}
        {trace.classifierMeta && (() => {
          const badge = classifierBadge(trace.classifierMeta);
          return (
            <span className={`classifier-badge classifier-${trace.classifierMeta.action}`} title={badge.label}>
              {badge.icon}
            </span>
          );
        })()}
        <span className="trace-expand-hint">▸</span>
      </button>
      <div className={`tool-body${expanded ? '' : ' hidden'}`}>
        {hasAgentMeta && (
          <div className="agent-meta">
            {trace.model && (
              <span className="agent-meta-item">
                <span className="agent-meta-label">model</span>
                <span className="agent-meta-value">{shortModelName(trace.model)}</span>
              </span>
            )}
            {trace.thinking && trace.thinking !== 'off' && (
              <span className="agent-meta-item">
                <span className="agent-meta-label">reasoning</span>
                <span className="agent-meta-value">{trace.thinking}</span>
              </span>
            )}
          </div>
        )}
        {inputFormatted && (
          <pre className="tool-input">{inputFormatted}</pre>
        )}
        {!trace.running && trace.toolOutput.trim() && (
          <pre className="tool-output">
            {trace.toolOutput.length > 2000
              ? trace.toolOutput.slice(0, 2000) + '\n… (truncated)'
              : trace.toolOutput}
          </pre>
        )}
        {trace.images && trace.images.length > 0 && (
          <div className="tool-images">
            {trace.images.map((img, i) => (
              <img
                key={i}
                className="tool-result-image"
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={`${trace.toolName} result`}
                onClick={() => {
                  const w = window.open();
                  if (w) {
                    w.document.write(`<img src="data:${img.mediaType};base64,${img.data}" style="max-width:100%;background:#111">`);
                    w.document.title = `${trace.toolName} result`;
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
