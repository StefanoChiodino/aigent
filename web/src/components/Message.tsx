import React, { useMemo, useState, useCallback } from 'react';
import type { DisplayMessage } from '../types';
import { renderMarkdown, extractSpeakContent, stripSpeakTag } from '../lib/markdown';
import { useVoiceStore } from '../stores/voice';
import { useTTS } from '../hooks/useTTS';
import { TraceBlock } from './TraceBlock';
import { SpeakPreview } from './SpeakPreview';
import { RatingWidget } from './RatingWidget';

interface Props {
  message: DisplayMessage;
}

const SPEAK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const STOP_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;
const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const CHECK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function TTSButton({ text, messageId }: { text: string; messageId: string }) {
  const isSpeaking = useVoiceStore(s => s.ttsSpeakingId === messageId);
  const { speakText, stopAll } = useTTS();

  const handleClick = useCallback(() => {
    if (isSpeaking) {
      stopAll();
      return;
    }
    // speakText calls stopAll internally, so clicking a different message
    // while one is already playing stops the old and starts the new.
    speakText(text, undefined, messageId);
  }, [isSpeaking, text, messageId, speakText, stopAll]);

  return (
    <button className={`tts-btn${isSpeaking ? ' speaking' : ''}`} title={isSpeaking ? 'Stop' : 'Speak'} onClick={handleClick}>
      <span className={`icon-speak${isSpeaking ? ' hidden' : ''}`} dangerouslySetInnerHTML={{ __html: SPEAK_ICON }} />
      <span className={`icon-stop-tts${isSpeaking ? '' : ' hidden'}`} dangerouslySetInnerHTML={{ __html: STOP_ICON }} />
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleClick = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);
  return (
    <button className={`copy-btn${copied ? ' copied' : ''}`} title={copied ? 'Copied!' : 'Copy markdown'} onClick={handleClick}>
      <span dangerouslySetInnerHTML={{ __html: copied ? CHECK_ICON : COPY_ICON }} />
    </button>
  );
}

function MessageTraces({ traces }: { traces: NonNullable<DisplayMessage['traces']> }) {
  const [expanded, setExpanded] = useState(false);
  if (traces.length === 0) return null;

  const toolCount = traces.filter(t => t.type === 'tool').length;
  const hasThinking = traces.some(t => t.type === 'thinking');

  const summaryLabel = toolCount > 0
    ? `${toolCount} tool${toolCount > 1 ? 's' : ''}`
    : hasThinking ? '💭 reasoned' : 'reasoning';

  return (
    <div className="message-traces">
      <button className="traces-summary" onClick={() => setExpanded(e => !e)}>
        {summaryLabel} <span className="trace-expand-hint">{expanded ? '⌄' : '›'}</span>
      </button>
      <div className={`traces-inner${expanded ? '' : ' hidden'}`}>
        {traces.map(trace => (
          <TraceBlock key={trace.id} trace={trace} />
        ))}
      </div>
    </div>
  );
}

function MessageAttachments({ attachments }: { attachments: NonNullable<DisplayMessage['attachments']> }) {
  const images = attachments.filter(a => a.thumbnail && a.mediaType.startsWith('image/'));
  const files = attachments.filter(a => !a.mediaType.startsWith('image/'));

  return (
    <>
      {images.length > 0 && (
        <div className="message-images">
          {images.map((att, i) => (
            <img key={i} className="message-image-thumb" src={att.thumbnail} alt={att.name} title={att.name} />
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="message-attachments">
          {files.map((att, i) => (
            <span key={i} className="message-file-badge" title={att.mediaType}>
              {att.mediaType === 'application/pdf' ? '📑' : '📄'} {att.name}
            </span>
          ))}
        </div>
      )}
    </>
  );
}

export const Message = React.memo(function Message({ message }: Props) {
  const rendered = useMemo(() => {
    if (message.role === 'system') return null;
    return renderMarkdown(stripSpeakTag(message.content));
  }, [message.content, message.role]);

  const speakContent = message.role === 'assistant' ? extractSpeakContent(message.content) : null;
  const ttsText = speakContent ?? message.content;

  return (
    <div className={`message ${message.role}`}>
      <div className="role-label">
        {message.role === 'assistant' ? 'aigent' : message.role}
        {message.id && (
          <span
            className="msg-id"
            title={`Click to copy: ${message.id}`}
            onClick={() => { navigator.clipboard.writeText(message.id!); }}
          >{message.id.slice(0, 6)}</span>
        )}
        {message.elapsed !== undefined && (
          <span className="elapsed">{message.elapsed.toFixed(1)}s</span>
        )}
        {message.role === 'assistant' && <TTSButton text={ttsText} messageId={message.id} />}
        {message.role === 'assistant' && <CopyButton text={stripSpeakTag(message.content)} />}
        {message.role === 'assistant' && <RatingWidget messageId={message.id} />}
        {speakContent && <SpeakPreview content={speakContent} />}
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <MessageAttachments attachments={message.attachments} />
      )}
      {message.traces && message.traces.length > 0 && (
        <MessageTraces traces={message.traces} />
      )}
      {message.role === 'system' ? (
        <div className="message-content">{message.content}</div>
      ) : (
        <div className="message-content" dangerouslySetInnerHTML={{ __html: rendered ?? '' }} />
      )}
    </div>
  );
});
