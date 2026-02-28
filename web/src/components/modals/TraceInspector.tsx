import React, { useEffect, useCallback } from 'react';
import { useUIStore } from '../../stores/ui';
import type { TraceEntry } from '../../types';

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
  return '🛠️';
}

function prettyToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);

  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button className="trace-inspector-copy" onClick={copy} title="Copy to clipboard">
      {copied ? '✓ Copied' : 'Copy'}
    </button>
  );
}

function Section({ label, text, mono = true }: { label: string; text: string; mono?: boolean }) {
  if (!text.trim()) return null;
  return (
    <div className="ti-section">
      <div className="ti-section-header">
        <span className="ti-section-label">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className={`ti-section-body${mono ? '' : ' ti-prose'}`}>{text}</pre>
    </div>
  );
}

function TraceInspectorContent({ trace }: { trace: TraceEntry }) {
  if (trace.type === 'thinking') {
    return (
      <>
        <div className="ti-title">
          <span className="ti-icon">💭</span>
          <span className="ti-name">Reasoning</span>
        </div>
        <Section label="Thinking" text={trace.text} />
      </>
    );
  }

  const inputFormatted = (() => {
    try { return JSON.stringify(JSON.parse(trace.toolInput), null, 2); }
    catch { return trace.toolInput; }
  })();

  return (
    <>
      <div className="ti-title">
        <span className="ti-icon">{toolIcon(trace.toolName)}</span>
        <span className="ti-name">{prettyToolName(trace.toolName)}</span>
        {trace.toolSummary && trace.toolSummary !== trace.toolName && (
          <span className="ti-summary">{trace.toolSummary}</span>
        )}
      </div>
      {inputFormatted && <Section label="Input" text={inputFormatted} />}
      {trace.toolOutput.trim() && <Section label="Output" text={trace.toolOutput} />}
      {trace.images && trace.images.length > 0 && (
        <div className="ti-section">
          <div className="ti-section-header">
            <span className="ti-section-label">Images ({trace.images.length})</span>
          </div>
          <div className="ti-images">
            {trace.images.map((img, i) => (
              <img
                key={i}
                className="ti-image"
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={`${trace.toolName} result ${i + 1}`}
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
        </div>
      )}
    </>
  );
}

export function TraceInspector() {
  const trace = useUIStore(s => s.traceInspectorTrace);
  const setTrace = useUIStore(s => s.setTraceInspectorTrace);

  const close = useCallback(() => setTrace(null), [setTrace]);

  useEffect(() => {
    if (!trace) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [trace, close]);

  if (!trace) return null;

  return (
    <div className="ti-backdrop" onClick={close}>
      <div className="ti-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="ti-header">
          <span className="ti-header-label">Tool Inspector</span>
          <button className="ti-close" onClick={close} title="Close (Esc)">×</button>
        </div>
        <div className="ti-body">
          <TraceInspectorContent trace={trace} />
        </div>
      </div>
    </div>
  );
}
