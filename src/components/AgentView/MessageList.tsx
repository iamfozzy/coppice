import { useRef, useEffect, useMemo } from "react";
import type { AgentMessage, AgentStatus } from "../../lib/types";
import { MessageBubble, MarkdownContent } from "./MessageBubble";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  messages: AgentMessage[];
  streamingText: string;
  status: AgentStatus;
}

/**
 * Merge adjacent tool_call + tool_result with the same toolUseId into a single
 * render item so they appear as one unified card.
 */
interface MergedToolItem {
  kind: "merged_tool";
  callMsg: AgentMessage;
  resultMsg: AgentMessage | null; // null if result hasn't arrived yet
}

interface PlainItem {
  kind: "plain";
  msg: AgentMessage;
}

type RenderItem = MergedToolItem | PlainItem;

function mergeMessages(messages: AgentMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  // Index of tool_call items by toolUseId so we can patch them when results arrive
  const callMap = new Map<string, MergedToolItem>();

  for (const msg of messages) {
    if (msg.type === "tool_call" && msg.toolUseId) {
      const merged: MergedToolItem = { kind: "merged_tool", callMsg: msg, resultMsg: null };
      callMap.set(msg.toolUseId, merged);
      items.push(merged);
    } else if (msg.type === "tool_result" && msg.toolUseId && callMap.has(msg.toolUseId)) {
      // Attach result to the existing call entry — don't create a new item
      callMap.get(msg.toolUseId)!.resultMsg = msg;
    } else {
      items.push({ kind: "plain", msg });
    }
  }

  return items;
}

export function MessageList({ messages, streamingText, status }: Props) {
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

  const items = useMemo(() => mergeMessages(messages), [messages]);

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-4 py-4 space-y-3"
      onScroll={handleScroll}
    >
      {messages.length === 0 && !streamingText && (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-text-tertiary">
            <div className="mb-3 opacity-15">
              <svg width="40" height="40" viewBox="0 0 48 48" fill="none" className="mx-auto">
                <rect x="8" y="18" width="32" height="22" rx="6" stroke="currentColor" strokeWidth="2" />
                <line x1="24" y1="10" x2="24" y2="18" stroke="currentColor" strokeWidth="2" />
                <circle cx="24" cy="8" r="3" stroke="currentColor" strokeWidth="2" />
                <circle cx="17" cy="29" r="2.5" fill="currentColor" />
                <circle cx="31" cy="29" r="2.5" fill="currentColor" />
                <line x1="4" y1="26" x2="8" y2="26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <line x1="40" y1="26" x2="44" y2="26" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-xs">Send a message to start a session</p>
          </div>
        </div>
      )}

      {items.map((item) => {
        if (item.kind === "merged_tool") {
          const call = item.callMsg;
          const result = item.resultMsg;
          return (
            <ToolCallCard
              key={call.id}
              toolName={call.toolName || "Unknown"}
              toolInput={call.toolInput}
              toolOutput={result?.toolOutput || result?.content}
              isError={result?.isError}
              isActive={!result}
            />
          );
        }
        return <MessageBubble key={item.msg.id} message={item.msg} />;
      })}

      {/* Live streaming text — render with markdown */}
      {streamingText && (
        <div className="pr-8">
          <MarkdownContent text={streamingText} />
          <span className="inline-block w-1.5 h-3.5 bg-accent/50 animate-pulse rounded-sm ml-0.5 -mb-0.5" />
        </div>
      )}

      {/* Thinking/working indicator — shown when agent is active but no streaming text yet */}
      {!streamingText && (status === "thinking" || status === "tool_use") && (
        <div className="flex items-center gap-2 py-1">
          <div className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse [animation-delay:300ms]" />
          </div>
          <span className="text-[11px] text-text-tertiary">
            {status === "tool_use" ? "Running tool..." : "Thinking..."}
          </span>
        </div>
      )}
    </div>
  );
}
