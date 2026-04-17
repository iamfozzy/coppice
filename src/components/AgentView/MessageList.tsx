import { useRef, useEffect, useMemo } from "react";
import type { AgentMessage, AgentStatus } from "../../lib/types";
import { MessageBubble, MarkdownContent } from "./MessageBubble";
import { ToolGroup, type GroupedTool } from "./ToolGroup";
import { AnimatedRobotIcon, AnimatedToolIcon, useRotatingThinkingPhrase } from "./AgentStatusIcons";

interface Props {
  messages: AgentMessage[];
  streamingText: string;
  status: AgentStatus;
}

interface ToolGroupItem {
  kind: "tool_group";
  tools: GroupedTool[];
  key: string;
}

interface PlainItem {
  kind: "plain";
  msg: AgentMessage;
}

type RenderItem = ToolGroupItem | PlainItem;

/**
 * Collapse adjacent tool_call + tool_result pairs into a single visual group
 * per assistant turn. A run of consecutive tool_calls (with their results
 * attached by toolUseId) becomes one ToolGroup; any non-tool message breaks
 * the run. tool_results don't break the run — they just get attached to their
 * matching call inside whichever group is still open or already closed.
 */
function mergeMessages(messages: AgentMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  const toolLoc = new Map<string, { groupIdx: number; toolIdx: number }>();
  let currentGroup: ToolGroupItem | null = null;

  for (const msg of messages) {
    if (msg.type === "tool_call" && msg.toolUseId) {
      if (!currentGroup) {
        currentGroup = { kind: "tool_group", tools: [], key: msg.id };
        items.push(currentGroup);
      }
      currentGroup.tools.push({ callMsg: msg, resultMsg: null });
      toolLoc.set(msg.toolUseId, {
        groupIdx: items.length - 1,
        toolIdx: currentGroup.tools.length - 1,
      });
    } else if (msg.type === "tool_result" && msg.toolUseId && toolLoc.has(msg.toolUseId)) {
      const loc = toolLoc.get(msg.toolUseId)!;
      const group = items[loc.groupIdx] as ToolGroupItem;
      group.tools[loc.toolIdx].resultMsg = msg;
    } else {
      currentGroup = null;
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
        if (item.kind === "tool_group") {
          return <ToolGroup key={item.key} tools={item.tools} />;
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
        <StatusIndicator status={status} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline status indicator with animated icons and rotating phrases
// ---------------------------------------------------------------------------
function StatusIndicator({ status }: { status: "thinking" | "tool_use" }) {
  const thinkingPhrase = useRotatingThinkingPhrase();

  return (
    <div className="flex items-center gap-2 py-1">
      {status === "tool_use" ? (
        <AnimatedToolIcon size={14} className="text-accent" />
      ) : (
        <AnimatedRobotIcon size={14} className="text-accent" />
      )}
      <span className="text-[11px] text-text-tertiary">
        {status === "tool_use" ? "Running tool..." : thinkingPhrase}
      </span>
    </div>
  );
}
