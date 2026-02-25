import React from 'react';
import { useChatStore } from '../stores/chat';
import { useVoiceStore } from '../stores/voice';
import { useTTS } from '../hooks/useTTS';
import { stripSpeakTag } from '../lib/markdown';
import { TraceBlock } from './TraceBlock';

const STOP_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

export const StreamingMessage = React.memo(function StreamingMessage() {
  const text = useChatStore(s => s.streaming.text);
  const traces = useChatStore(s => s.streaming.traces);
  const ttsPlaying = useVoiceStore(s => s.ttsPlaying);
  const { stopAll } = useTTS();

  const handleStopTTS = () => {
    stopAll();
  };

  const displayText = stripSpeakTag(text);

  return (
    <div className="message assistant streaming">
      <div className="role-label">
        aigent
        {ttsPlaying && (
          <button
            className="tts-btn speaking"
            title="Stop speaking"
            onClick={handleStopTTS}
            dangerouslySetInnerHTML={{ __html: STOP_ICON }}
          />
        )}
      </div>
      {traces.length > 0 && (
        <div className="message-traces">
          <div className="traces-inner">
            {traces.map(trace => (
              <TraceBlock key={trace.id} trace={trace} />
            ))}
          </div>
        </div>
      )}
      <div className="message-content">{displayText}</div>
    </div>
  );
});
