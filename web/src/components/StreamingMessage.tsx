import React from 'react';
import { useChatStore } from '../stores/chat';
import { useVoiceStore } from '../stores/voice';
import { useTTS } from '../hooks/useTTS';
import { stripSpeakTag } from '../lib/markdown';
import { TraceBlock } from './TraceBlock';

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
  const traces = useChatStore(s => s.streaming.traces);
  const isThinking = useChatStore(s => s.streaming.isThinking);
  const ttsPlaying = useVoiceStore(s => s.ttsPlaying);
  const { stopAll } = useTTS();

  const handleStopTTS = () => {
    stopAll();
  };

  const displayText = stripSpeakTag(text);
  const activity = !displayText ? activityLabel(isThinking, traces) : null;

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
      <div className="message-content">
        {displayText || (
          activity
            ? <span className="streaming-activity">{activity}</span>
            : null
        )}
      </div>
    </div>
  );
});
