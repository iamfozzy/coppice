import { useRef, useEffect, useMemo } from "react";
import type { AgentMessage, AgentStatus, AgentPendingPermission } from "../../lib/types";
import { MessageBubble } from "./MessageBubble";
import { ToolGroup, type GroupedTool } from "./ToolGroup";
import { PlanApprovalDialog } from "./PlanApprovalDialog";
import { AnimatedRobotIcon, AnimatedToolIcon, useRotatingThinkingPhrase } from "./AgentStatusIcons";

interface Props {
  messages: AgentMessage[];
  streamingText: string;
  streamingThinkingText: string;
  status: AgentStatus;
  stalled?: boolean;
  onCancelQueued?: (messageId: string) => void;
  /** When set, the plan approval UI renders inline at the bottom of the chat. */
  pendingPlan?: AgentPendingPermission | null;
  onPlanApprove?: (updatedInput: unknown) => void;
  onPlanRequestChanges?: (feedback: string) => void;
  onPlanDeny?: () => void;
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
 *
 * Queued messages are excluded — they're rendered separately at the bottom.
 */
function mergeMessages(messages: AgentMessage[]): { items: RenderItem[]; queued: AgentMessage[] } {
  const items: RenderItem[] = [];
  const queued: AgentMessage[] = [];
  const toolLoc = new Map<string, { groupIdx: number; toolIdx: number }>();
  let currentGroup: ToolGroupItem | null = null;

  for (const msg of messages) {
    if (msg.isQueued) {
      queued.push(msg);
      continue;
    }
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

  return { items, queued };
}

export function MessageList({
  messages, streamingText, streamingThinkingText, status, stalled, onCancelQueued,
  pendingPlan, onPlanApprove, onPlanRequestChanges, onPlanDeny,
}: Props) {
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
  }, [messages.length, streamingText, streamingThinkingText, pendingPlan]);

  const { items, queued } = useMemo(() => mergeMessages(messages), [messages]);

  const showPlanInline = pendingPlan && onPlanApprove && onPlanRequestChanges && onPlanDeny;

  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3"
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

      {/* Live streaming thinking — shown while thinking deltas arrive */}
      {streamingThinkingText && (
        <div className="pr-8">
          <div className="mb-2">
            <div className="flex items-center gap-1.5 text-[11px] text-text-tertiary mb-1.5">
              <AnimatedRobotIcon size={12} className="text-accent" />
              <span>Thinking...</span>
            </div>
            <div className="pl-3 border-l-2 border-accent/30 text-xs text-text-tertiary/80 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
              {streamingThinkingText}
              <span className="inline-block w-1 h-3 bg-accent/30 animate-pulse rounded-sm ml-0.5 -mb-0.5" />
            </div>
          </div>
        </div>
      )}

      {/* Live streaming text — keep rendering cheap while deltas arrive.
          The finalized assistant message is rendered with full markdown once. */}
      {streamingText && (
        <div className="pr-8 text-[13px] text-text-primary break-words leading-relaxed whitespace-pre-wrap">
          {streamingText}
          <span className="inline-block w-1.5 h-3.5 bg-accent/50 animate-pulse rounded-sm ml-0.5 -mb-0.5" />
        </div>
      )}

      {/* Inline plan approval — renders as part of the chat flow */}
      {showPlanInline && (
        <PlanApprovalDialog
          pending={pendingPlan}
          onApprove={onPlanApprove}
          onRequestChanges={onPlanRequestChanges}
          onDeny={onPlanDeny}
        />
      )}

      {/* Status indicator — shown when agent is active but no streaming text yet.
          Suppressed when a plan is shown inline (the plan UI is self-explanatory). */}
      {!streamingText && !streamingThinkingText && !showPlanInline && (status === "thinking" || status === "tool_use" || status === "waiting_permission" || status === "waiting_input") && (
        <StatusIndicator status={status} stalled={stalled} />
      )}

      {/* Queued messages — always at bottom until sent */}
      {queued.map((msg) => (
        <MessageBubble key={msg.id} message={msg} onCancel={onCancelQueued} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline status indicator with animated icons and rotating phrases
// ---------------------------------------------------------------------------
function StatusIndicator({ status, stalled }: { status: "thinking" | "tool_use" | "waiting_permission" | "waiting_input"; stalled?: boolean }) {
  const thinkingPhrase = useRotatingThinkingPhrase();

  if (status === "waiting_permission") {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
        <span className="text-[11px] text-warning">Waiting for approval...</span>
      </div>
    );
  }

  if (status === "waiting_input") {
    return (
      <div className="flex items-center gap-2 py-1">
        <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
        <span className="text-[11px] text-text-tertiary">Waiting for your response...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 py-1">
      <div className="flex items-center gap-2">
        {status === "tool_use" ? (
          <AnimatedToolIcon size={14} className="text-accent" />
        ) : (
          <AnimatedRobotIcon size={14} className="text-accent" />
        )}
        <span className="text-[11px] text-text-tertiary">
          {status === "tool_use" ? "Running tool..." : thinkingPhrase}
        </span>
      </div>
      {stalled && (
        <div className="flex items-center gap-2 ml-0.5">
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          <span className="text-[11px] text-warning">
            No response from API — check your network connection
          </span>
        </div>
      )}
    </div>
  );
}
