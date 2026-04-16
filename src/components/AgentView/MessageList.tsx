import { useRef, useEffect } from "react";
import type { AgentMessage } from "../../lib/types";
import { MessageBubble } from "./MessageBubble";

interface Props {
  messages: AgentMessage[];
  streamingText: string;
}

export function MessageList({ messages, streamingText }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // Auto-scroll to bottom when new messages arrive (if user is at bottom)
  useEffect(() => {
    if (isAtBottomRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [messages.length, streamingText]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
      onScroll={handleScroll}
    >
      {messages.length === 0 && !streamingText && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-text-tertiary">
            <div className="text-3xl mb-2 opacity-20">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" className="mx-auto">
                <rect x="8" y="18" width="32" height="22" rx="6" stroke="currentColor" strokeWidth="2" />
                <line x1="24" y1="10" x2="24" y2="18" stroke="currentColor" strokeWidth="2" />
                <circle cx="24" cy="8" r="3" stroke="currentColor" strokeWidth="2" />
                <circle cx="17" cy="29" r="2.5" fill="currentColor" />
                <circle cx="31" cy="29" r="2.5" fill="currentColor" />
                <line x1="4" y1="26" x2="8" y2="26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <line x1="40" y1="26" x2="44" y2="26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-sm">Type a message to start</p>
          </div>
        </div>
      )}

      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* Live streaming text */}
      {streamingText && (
        <div className="max-w-[90%]">
          <div className="text-sm text-text-primary whitespace-pre-wrap break-words">
            {streamingText}
            <span className="inline-block w-1.5 h-4 bg-accent/60 animate-pulse ml-0.5 align-text-bottom" />
          </div>
        </div>
      )}
    </div>
  );
}
