import React, { useMemo } from 'react';
import { useChatStore } from '../stores/chat';
import { useVoiceStore } from '../stores/voice';
import { useTTS, TTS_STREAMING_ID } from '../hooks/useTTS';
import { renderMarkdown } from '../lib/markdown';
import { TraceBlock } from './TraceBlock';
import { SpeakPreview } from './SpeakPreview';
export const STREAMING_MESSAGE_ID = '__streaming__';

const STOP_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`;

function activityLabel(
  isThinking: boolean,
  traces: { type: string; toolName?: string; running?: boolean }[],
): string | null {
  if (isThinking) return 'reasoning…';
  const runningTool = traces.findLast(t => t.type === 'tool' && t.running);
  if (runningTool) return `${runningTool.toolName ?? 'tool'}…`;
  return null;
}

export const StreamingMessage = React.memo(function StreamingMessage() {
  const text = useChatStore(s => s.streaming.text);
  const spokenText = useChatStore(s => s.streaming.spokenText);
  const traces = useChatStore(s => s.streaming.traces);
  const isThinking = useChatStore(s => s.streaming.isThinking);
  const isSpeaking = useVoiceStore(s => s.ttsSpeakingId === TTS_STREAMING_ID);
  const { stopAll } = useTTS();

  const handleStopTTS = () => {
    stopAll();
  };

  const activity = !text ? activityLabel(isThinking, traces) : null;
  const rendered = useMemo(() => text ? renderMarkdown(text) : '', [text]);

  return (
    <div className="message assistant streaming">
      <div className="role-label">
        aigent
        {isSpeaking && (
          <button
            className="tts-btn speaking"
            title="Stop speaking"
            onClick={handleStopTTS}
            dangerouslySetInnerHTML={{ __html: STOP_ICON }}
          />
        )}
        {spokenText && <SpeakPreview content={spokenText} streaming />}
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
      <div className="message-content">
        {text ? (
          <div dangerouslySetInnerHTML={{ __html: rendered }} />
        ) : (
          <span className="streaming-activity">{activity}</span>
        )}
      </div>
    </div>
  );
});
