import React, { useMemo, useState, useCallback } from 'react';
import type { DisplayMessage } from '../types';
import { renderMarkdown, extractSpeakContent, stripSpeakTag } from '../lib/markdown';
import { useVoiceStore } from '../stores/voice';
import { useTTS } from '../hooks/useTTS';
import { TraceBlock } from './TraceBlock';

interface Props {
  message: DisplayMessage;
}

const SPEAK_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const STOP_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

function TTSButton({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false);
  const ttsPlaying = useVoiceStore(s => s.ttsPlaying);
  const { stopAll: ttsStopAll } = useTTS();
  const abortRef = React.useRef<AbortController | null>(null);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  const showStop = speaking || ttsPlaying;

  const handleClick = useCallback(() => {
    // Global TTS (auto-speak) is playing — stop it
    if (ttsPlaying && !speaking) {
      ttsStopAll();
      return;
    }
    if (speaking) {
      abortRef.current?.abort();
      audioRef.current?.pause();
      setSpeaking(false);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setSpeaking(true);

    // Strip markdown for TTS
    const stripped = text.replace(/```[\s\S]*?```/g, ' code block. ').replace(/`([^`]+)`/g, '$1').replace(/^#+\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').trim();

    fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: stripped,
      signal: ctrl.signal,
    }).then(async r => {
      if (!r.ok) throw new Error('tts error');
      const blobUrl = URL.createObjectURL(await r.blob());
      if (abortRef.current !== ctrl) { URL.revokeObjectURL(blobUrl); return; }
      const audio = new Audio(blobUrl);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(blobUrl); setSpeaking(false); };
      audio.onerror = () => { setSpeaking(false); };
      void audio.play();
    }).catch(() => setSpeaking(false));
  }, [speaking, text, ttsPlaying, ttsStopAll]);

  return (
    <button className={`tts-btn${showStop ? ' speaking' : ''}`} title={showStop ? 'Stop' : 'Speak'} onClick={handleClick}>
      <span className={`icon-speak${showStop ? ' hidden' : ''}`} dangerouslySetInnerHTML={{ __html: SPEAK_ICON }} />
      <span className={`icon-stop-tts${showStop ? '' : ' hidden'}`} dangerouslySetInnerHTML={{ __html: STOP_ICON }} />
    </button>
  );
}

function MessageTraces({ traces }: { traces: NonNullable<DisplayMessage['traces']> }) {
  const [expanded, setExpanded] = useState(false);
  if (traces.length === 0) return null;

  const thinkingCount = traces.filter(t => t.type === 'thinking').length;
  const toolCount = traces.filter(t => t.type === 'tool').length;

  const summaryParts: string[] = [];
  if (thinkingCount > 0) summaryParts.push('💭 reasoned');
  if (toolCount > 0) summaryParts.push(`${toolCount} tool${toolCount > 1 ? 's' : ''}`);
  const summaryLabel = summaryParts.join(' · ');

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
        {message.elapsed !== undefined && (
          <span className="elapsed">{message.elapsed.toFixed(1)}s</span>
        )}
        {message.role === 'assistant' && <TTSButton text={ttsText} />}
        {speakContent && (
          <span className="speak-preview" title={speakContent}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
        )}
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
