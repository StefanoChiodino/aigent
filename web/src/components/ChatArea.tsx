import React, { useEffect, useRef, useCallback } from 'react';
import { useChatStore } from '../stores/chat';
import { Message } from './Message';
import { StreamingMessage } from './StreamingMessage';

export function ChatArea() {
  const messages = useChatStore(s => s.messages);
  const streamingActive = useChatStore(s => s.streaming.active);
  const streamingTextLen = useChatStore(s => s.streaming.text.length);
  const traceCount = useChatStore(s => s.streaming.traces.length);
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLElement>(null);
  const userScrolledUp = useRef(false);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // "near bottom" = within 150px of the bottom edge
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    userScrolledUp.current = !atBottom;
  }, []);

  // Reset scroll lock when a new response starts
  useEffect(() => {
    if (streamingActive) userScrolledUp.current = false;
  }, [streamingActive]);

  useEffect(() => {
    if (!userScrolledUp.current) {
      endRef.current?.scrollIntoView({ behavior: 'instant' });
    }
  });

  // Group consecutive system messages
  const grouped: Array<{ type: 'system-group'; items: typeof messages } | { type: 'single'; msg: typeof messages[0] }> = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      const last = grouped[grouped.length - 1];
      if (last?.type === 'system-group') {
        last.items.push(msg);
      } else {
        grouped.push({ type: 'system-group', items: [msg] });
      }
    } else {
      grouped.push({ type: 'single', msg });
    }
  }

  return (
    <main id="messages" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && !streamingActive && (
        <div id="empty-state">
          <div className="empty-icon">🤖</div>
          <div className="empty-title">Ready to go</div>
          <div className="empty-subtitle">Start a conversation below</div>
        </div>
      )}
      {grouped.map((g, i) => {
        if (g.type === 'system-group') {
          return (
            <div key={`sys-${i}`} className="message system">
              <div className="role-label">system</div>
              <div className="message-content">
                {g.items.map((m, j) => (
                  <React.Fragment key={j}>
                    {j > 0 && <div className="system-separator" />}
                    <div>{m.content}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          );
        }
        return <Message key={g.msg.id} message={g.msg} />;
      })}
      {streamingActive && <StreamingMessage />}
      <div ref={endRef} />
    </main>
  );
}
