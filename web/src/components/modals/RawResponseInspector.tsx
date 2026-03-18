import React, { useState, useEffect, useCallback } from 'react';
import { useUIStore } from '../../stores/ui';
import type { RawTurnData, RawContentBlock } from '../../types';

function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}

function BlockText({ block }: { block: Extract<RawContentBlock, { type: 'text' }> }) {
  return (
    <div className="rri-block rri-block-text">
      <div className="rri-block-label">text</div>
      <pre className="rri-block-content">{block.text}</pre>
    </div>
  );
}

function BlockThinking({ block }: { block: Extract<RawContentBlock, { type: 'thinking' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rri-block rri-block-thinking">
      <button className="rri-block-label rri-block-toggle" onClick={() => setOpen(o => !o)}>
        thinking {open ? '▲' : '▼'}
      </button>
      {open && <pre className="rri-block-content">{block.thinking}</pre>}
    </div>
  );
}

function BlockToolUse({ block }: { block: Extract<RawContentBlock, { type: 'tool_use' }> }) {
  return (
    <div className="rri-block rri-block-tool">
      <div className="rri-block-label">tool_use: <span className="rri-tool-name">{block.name}</span></div>
      <pre className="rri-block-content">{JSON.stringify(block.input, null, 2)}</pre>
    </div>
  );
}

function TurnSection({ turn, total }: { turn: RawTurnData; total: number }) {
  const { input, output, cacheRead, cacheWrite, reasoning } = turn.usage;
  return (
    <div className="rri-turn">
      <div className="rri-turn-header">
        <span className="rri-turn-label">Turn {turn.iteration} of {total}</span>
        <span className="rri-turn-model">{turn.model}</span>
        <span className="rri-turn-stop">{turn.stopReason}</span>
        <span className="rri-turn-time">{fmtTime(turn.completedAt)}</span>
      </div>
      <div className="rri-turn-usage">
        <span>in: {fmtTok(input)}</span>
        <span>out: {fmtTok(output)}</span>
        {cacheRead > 0 && <span>cache↓: {fmtTok(cacheRead)}</span>}
        {cacheWrite > 0 && <span>cache↑: {fmtTok(cacheWrite)}</span>}
        {reasoning != null && reasoning > 0 && <span>thinking: {fmtTok(reasoning)}</span>}
      </div>
      <div className="rri-blocks">
        {turn.contentBlocks.map((block, i) => {
          if (block.type === 'text') return <BlockText key={i} block={block} />;
          if (block.type === 'thinking') return <BlockThinking key={i} block={block} />;
          if (block.type === 'tool_use') return <BlockToolUse key={i} block={block} />;
          return null;
        })}
        {turn.contentBlocks.length === 0 && (
          <div className="rri-empty">No content blocks</div>
        )}
      </div>
    </div>
  );
}

export function RawResponseInspector() {
  const message = useUIStore(s => s.rawResponseMessage);
  const setRawResponseMessage = useUIStore(s => s.setRawResponseMessage);
  const [copied, setCopied] = useState(false);

  const close = useCallback(() => setRawResponseMessage(null), [setRawResponseMessage]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && message) close();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [message, close]);

  const handleCopy = useCallback(() => {
    if (!message?.rawTurns) return;
    navigator.clipboard.writeText(JSON.stringify(message.rawTurns, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [message]);

  if (!message) return null;
  const turns = message.rawTurns ?? [];

  return (
    <div
      className="rri-overlay"
      onClick={e => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="rri-modal">
        <div className="rri-header">
          <span className="rri-title">Raw Response</span>
          <button className="rri-copy" onClick={handleCopy}>{copied ? '✓ Copied' : 'Copy JSON'}</button>
          <button className="rri-close" onClick={close}>×</button>
        </div>
        <div className="rri-body">
          {turns.length === 0
            ? <div className="rri-empty">No raw turn data available.</div>
            : turns.map((turn, i) => <TurnSection key={i} turn={turn} total={turns.length} />)
          }
        </div>
      </div>
    </div>
  );
}
