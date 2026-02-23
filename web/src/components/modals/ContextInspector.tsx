import React, { useEffect, useState } from 'react';
import { useUIStore } from '../../stores/ui';
import { useConnectionStore } from '../../stores/connection';
import type { ContextBreakdown, ToolSummaryRecord } from '../../types';

const COLORS = ['#7c6ef0', '#40b080', '#e0a040', '#58a6ff'];
const LABELS = ['System prompt', 'Workspace', 'Tool definitions', 'Messages'];
const CONTEXT_WINDOW = 200_000;
const MAX_VISIBLE_MESSAGES = 20;

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function looksLikeMarkdown(text: string): boolean {
  return /^(#{1,6} |```|> |\* |- |\d+\. )/m.test(text);
}

function inlineMarkdown(line: string): string {
  return line
    .replace(/`([^`]+)`/g, '<span class="ctx-hl-icode">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<span class="ctx-hl-bold">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="ctx-hl-link-label">[$1]</span><span class="ctx-hl-link-url">($2)</span>');
}

function highlightMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = escHtml(rawLine);
    const fenceMatch = rawLine.match(/^(`{3,}|~{3,})([\w-]*)/);
    if (fenceMatch) {
      inFence = !inFence;
      out.push(`<span class="ctx-hl-fence">${escHtml(fenceMatch[1]!)}</span>`);
      continue;
    }
    if (inFence) { out.push(`<span class="ctx-hl-code">${line}</span>`); continue; }
    const hMatch = rawLine.match(/^(#{1,6}) (.+)/);
    if (hMatch) {
      out.push(`<span class="ctx-hl-h ctx-hl-h${hMatch[1]!.length}">${escHtml(hMatch[1]!)} ${inlineMarkdown(escHtml(hMatch[2]!))}</span>`);
      continue;
    }
    const bMatch = rawLine.match(/^(\s*)([-*+]|\d+\.) (.+)/);
    if (bMatch) {
      out.push(`${escHtml(bMatch[1]!)}<span class="ctx-hl-bullet">${escHtml(bMatch[2]!)}</span> ${inlineMarkdown(escHtml(bMatch[3]!))}`);
      continue;
    }
    out.push(inlineMarkdown(line));
  }
  return out.join('\n');
}

function highlightContent(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const pretty = JSON.stringify(parsed, null, 2);
    const esc = pretty.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc
      .replace(/\\n/g, '\n')
      .replace(/^("(?:\\.|[^"\\])*")(\s*:)/gm, '<span class="ctx-hl-key">$1</span>$2')
      .replace(/:\s*("(?:[^"\\]|\\.)*")/g, (_m, s) => ': <span class="ctx-hl-str">' + s + '</span>')
      .replace(/:\s*(-?\d+(?:\.\d+)?)/g, ': <span class="ctx-hl-num">$1</span>')
      .replace(/:\s*(true|false|null)\b/g, ': <span class="ctx-hl-kw">$1</span>');
  } catch {
    if (looksLikeMarkdown(text)) return highlightMarkdown(text);
    return escHtml(text);
  }
}

function ExpandableBarRow({ label, tokens, total, color, content }: {
  label: string; tokens: number; total: number; color: string; content?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const pct = total > 0 ? (tokens / total) * 100 : 0;
  const clickable = !!content;
  return (
    <div className="ctx-bar-row-wrap">
      <div
        className={`ctx-bar-row${clickable ? ' ctx-clickable' : ''}`}
        onClick={() => clickable && setExpanded(e => !e)}
      >
        <div className="ctx-bar-label">
          <div className="ctx-bar-swatch" style={{ background: color }} />
          {label}
          {clickable && <span className="ctx-chevron">{expanded ? '⌄' : '›'}</span>}
        </div>
        <div className="ctx-bar-track">
          <div className="ctx-bar-fill" style={{ width: `${Math.min(100, pct).toFixed(1)}%`, background: color }} />
        </div>
        <div className="ctx-bar-tokens">{fmtTok(tokens)}</div>
        <div className="ctx-bar-pct">{pct.toFixed(0)}%</div>
      </div>
      {expanded && content && (
        <pre
          className="ctx-expand-panel"
          dangerouslySetInnerHTML={{ __html: highlightContent(content) }}
        />
      )}
    </div>
  );
}

interface MsgEntry {
  role: string;
  tokens: number;
  preview?: string;
  summaryRecord?: ToolSummaryRecord;
}

function MessageRow({ idx, msg, maxTokens }: { idx: number; msg: MsgEntry; maxTokens: number }) {
  const [expanded, setExpanded] = useState(false);
  const clickable = !!msg.preview;
  const barPct = maxTokens > 0 ? (msg.tokens / maxTokens) * 100 : 0;
  const roleLabel = msg.role === 'tool_result' ? 'tool' : msg.role;
  return (
    <div className="ctx-msg-row-wrap">
      <div
        className={`ctx-msg-row${clickable ? ' ctx-clickable' : ''}`}
        onClick={() => clickable && setExpanded(e => !e)}
      >
        <div className="ctx-msg-idx">{idx + 1}</div>
        <div className={`ctx-msg-role ${msg.role}`}>
          {roleLabel}{msg.summaryRecord ? ' ✦' : ''}
          {clickable && <span className="ctx-msg-chevron">{expanded ? ' ⌄' : ' ›'}</span>}
        </div>
        <div className="ctx-msg-bar-wrap">
          <div className="ctx-msg-bar-fill" style={{ width: `${Math.min(100, barPct).toFixed(1)}%` }} />
        </div>
        <div className="ctx-msg-tokens">{fmtTok(msg.tokens)}</div>
      </div>
      {msg.summaryRecord && (
        <div className="ctx-msg-summary-info">
          {msg.summaryRecord.toolName}: {fmtTok(msg.summaryRecord.originalTokens)} → {fmtTok(msg.summaryRecord.summarizedTokens)} (saved {fmtTok(msg.summaryRecord.savedTokens)})
        </div>
      )}
      {expanded && msg.preview && (
        <pre
          className="ctx-expand-panel"
          dangerouslySetInnerHTML={{
            __html: highlightContent(
              msg.summaryRecord
                ? `${msg.summaryRecord.summary}\n\n[Full output at ${msg.summaryRecord.fullOutputPath}]`
                : msg.preview
            )
          }}
        />
      )}
    </div>
  );
}

function InspectorBody({ bd }: { bd: ContextBreakdown }) {
  const total = bd.total || 1;
  const windowPct = Math.round((bd.total / CONTEXT_WINDOW) * 100);

  const segments = [bd.systemBase, bd.workspaceContext, bd.toolDefs, bd.messagesTotal];
  const contents = [bd.systemBaseContent, bd.workspaceContent, bd.toolDefsContent, undefined];

  const msgs = bd.messages;
  const omitted = Math.max(0, msgs.length - MAX_VISIBLE_MESSAGES);
  const shown = msgs.slice(omitted);
  const maxMsgTokens = Math.max(...shown.map(m => m.tokens), 1);
  const skippedTok = omitted > 0 ? msgs.slice(0, omitted).reduce((s, m) => s + m.tokens, 0) : 0;

  return (
    <>
      <div className="ctx-inspector-summary" id="ctx-inspector-summary">
        <strong>~{fmtTok(bd.total)}</strong> tokens estimated — {windowPct}% of 200k window
        {bd.totalSummarySavedTokens && bd.toolSummariesCount ? (
          <> · saved <strong>~{fmtTok(bd.totalSummarySavedTokens)}</strong> via {bd.toolSummariesCount} summarization{bd.toolSummariesCount > 1 ? 's' : ''}</>
        ) : null}
      </div>

      <div className="ctx-stacked-bar" id="ctx-stacked-bar">
        {segments.map((val, i) => (
          <div
            key={i}
            className="ctx-stacked-segment"
            style={{ width: `${Math.max(0, val / total * 100).toFixed(1)}%`, background: COLORS[i] }}
          />
        ))}
      </div>

      <div id="ctx-inspector-bars">
        {segments.map((val, i) => (
          <ExpandableBarRow
            key={i}
            label={LABELS[i]!}
            tokens={val}
            total={total}
            color={COLORS[i]!}
            content={contents[i]}
          />
        ))}
      </div>

      <div className="ctx-messages-header" id="ctx-inspector-messages-header">
        {msgs.length > 0
          ? `Messages in context (${msgs.length} — click any row to inspect)`
          : 'Messages in context'}
      </div>
      <div className="ctx-messages-table" id="ctx-inspector-messages">
        {omitted > 0 && (
          <div className="ctx-omitted-row">
            … {omitted} earlier messages ({fmtTok(skippedTok)} tokens)
          </div>
        )}
        {shown.map((m, i) => (
          <MessageRow key={omitted + i} idx={omitted + i} msg={m} maxTokens={maxMsgTokens} />
        ))}
      </div>
    </>
  );
}

export function ContextInspector() {
  const ctxInspectorOpen = useUIStore(s => s.ctxInspectorOpen);
  const setCtxInspectorOpen = useUIStore(s => s.setCtxInspectorOpen);
  const contextBreakdown = useUIStore(s => s.contextBreakdown);
  const send = useConnectionStore(s => s.send);

  useEffect(() => {
    if (!ctxInspectorOpen) return;
    send({ type: 'context_breakdown_request' });
  }, [ctxInspectorOpen, send]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ctxInspectorOpen) setCtxInspectorOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [ctxInspectorOpen, setCtxInspectorOpen]);

  return (
    <div
      id="ctx-inspector-overlay"
      className={ctxInspectorOpen ? '' : 'hidden'}
      onClick={e => { if (e.target === e.currentTarget) setCtxInspectorOpen(false); }}
    >
      <div className="ctx-inspector">
        <div className="ctx-inspector-header">
          <span>Context Inspector</span>
          <button id="ctx-inspector-close" onClick={() => setCtxInspectorOpen(false)}>×</button>
        </div>
        {contextBreakdown
          ? <InspectorBody bd={contextBreakdown} />
          : <div style={{ padding: 20, color: 'var(--text-dim)' }}>Loading…</div>
        }
      </div>
    </div>
  );
}
