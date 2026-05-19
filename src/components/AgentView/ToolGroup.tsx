import { memo, useState } from "react";
import type { AgentMessage } from "../../lib/types";
import { ToolCallCard, normalizeToolName } from "./ToolCallCard";

export interface GroupedTool {
  callMsg: AgentMessage;
  resultMsg: AgentMessage | null;
}

interface Props {
  tools: GroupedTool[];
  worktreePath?: string;
}

export const ToolGroup = memo(function ToolGroup({ tools, worktreePath }: Props) {
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
        worktreePath={worktreePath}
      />
    );
  }

  // Build "Read×3, Grep×2" summary
  const counts = new Map<string, number>();
  for (const t of tools) {
    const n = normalizeToolName(t.callMsg.toolName || "Tool");
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n}×${c}` : n))
    .join(", ");

  // If a TodoWrite call sits inside this group, surface its latest progress so
  // the user sees plan updates without having to expand the whole group.
  const planProgress = latestTodoProgress(tools);

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

        {planProgress && (
          <span className="shrink-0 px-1.5 py-px rounded-sm bg-accent/10 text-accent font-mono text-[length:var(--app-font-10)]">
            {planProgress.isDraft
              ? `Draft · ${planProgress.total} step${planProgress.total === 1 ? "" : "s"}`
              : `Plan ${planProgress.done}/${planProgress.total}`}
          </span>
        )}

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
              worktreePath={worktreePath}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function latestTodoProgress(
  tools: GroupedTool[],
): { done: number; total: number; isDraft: boolean } | null {
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i];
    if (normalizeToolName(t.callMsg.toolName || "") !== "TodoWrite") continue;
    const input = t.callMsg.toolInput;
    if (!input || typeof input !== "object") continue;
    const todos = (input as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) continue;
    const done = todos.filter(
      (todo) => todo && typeof todo === "object" && (todo as { status?: string }).status === "completed",
    ).length;
    const isDraft =
      todos.length >= 2 &&
      todos.every(
        (todo) => todo && typeof todo === "object" && (todo as { status?: string }).status === "pending",
      );
    return { done, total: todos.length, isDraft };
  }
  return null;
}
