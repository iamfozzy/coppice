import { useState } from "react";
import type { AgentMessage } from "../../lib/types";
import { ToolCallCard } from "./ToolCallCard";

export interface GroupedTool {
  callMsg: AgentMessage;
  resultMsg: AgentMessage | null;
}

interface Props {
  tools: GroupedTool[];
}

/**
 * Groups a run of consecutive tool calls from the same assistant turn into a
 * single collapsible block. While any tool is still running, the group is
 * auto-expanded so the user can see progress; once all tools finish it
 * auto-collapses to a one-line summary. Manual toggle overrides the auto
 * behavior.
 *
 * Single-tool groups render inline as a plain row (no group chrome).
 */
export function ToolGroup({ tools }: Props) {
  const anyActive = tools.some((t) => t.resultMsg === null);
  const anyError = tools.some((t) => t.resultMsg?.isError);

  const [manualOverride, setManualOverride] = useState<boolean | null>(null);
  const expanded = manualOverride ?? false;

  if (tools.length === 1) {
    const t = tools[0];
    return (
      <ToolCallCard
        toolName={t.callMsg.toolName || "Unknown"}
        toolInput={t.callMsg.toolInput}
        toolOutput={t.resultMsg?.toolOutput || t.resultMsg?.content}
        isError={t.resultMsg?.isError}
        isActive={!t.resultMsg}
      />
    );
  }

  // Build "Read×3, Grep×2" summary
  const counts = new Map<string, number>();
  for (const t of tools) {
    const n = t.callMsg.toolName || "Tool";
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(", ");

  const headerLabel = anyActive
    ? `Running ${tools.length} tools`
    : `Used ${tools.length} tools`;

  return (
    <div className="text-xs">
      <button
        type="button"
        className="flex items-center gap-2 w-full text-left px-1.5 py-0.5 rounded hover:bg-bg-hover/40 transition-colors"
        onClick={() => setManualOverride(!expanded)}
      >
        {anyActive ? (
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${anyError ? "bg-error" : "bg-success"}`} />
        )}

        <span className="text-text-secondary font-medium">{headerLabel}</span>
        <span className="text-text-tertiary truncate font-mono min-w-0">{summary}</span>

        <svg
          width="9" height="9" viewBox="0 0 10 10" fill="none"
          className={`ml-auto shrink-0 text-text-tertiary/70 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div className="mt-0.5 ml-[6px] pl-2 border-l border-border-primary/60 space-y-0.5">
          {tools.map((t) => (
            <ToolCallCard
              key={t.callMsg.id}
              toolName={t.callMsg.toolName || "Unknown"}
              toolInput={t.callMsg.toolInput}
              toolOutput={t.resultMsg?.toolOutput || t.resultMsg?.content}
              isError={t.resultMsg?.isError}
              isActive={!t.resultMsg}
            />
          ))}
        </div>
      )}
    </div>
  );
}
