import type { AgentSessionState } from "../../lib/types";

interface Props {
  session: AgentSessionState;
  onInterrupt: () => void;
}

export function AgentToolbar({
  session,
  onInterrupt,
}: Props) {
  const isWorking = session.status === "thinking" || session.status === "tool_use";

  // Only show the toolbar when there is something to display
  const hasCost = !!session.cost;
  const hasStatus = isWorking || session.status === "waiting_permission" || session.status === "done";
  if (!hasCost && !hasStatus) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-t border-border-primary bg-bg-secondary text-xs shrink-0">
      {/* Status indicator */}
      {isWorking && (
        <div className="flex items-center gap-1.5 text-accent">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
          </span>
          <span className="text-[10px] font-medium">
            {session.status === "tool_use" ? "Running tool" : "Thinking"}
          </span>
        </div>
      )}
      {session.status === "waiting_permission" && (
        <div className="flex items-center gap-1.5 text-warning">
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          <span className="text-[10px] font-medium">Waiting for approval</span>
        </div>
      )}
      {session.status === "done" && (
        <div className="flex items-center gap-1.5 text-success">
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-[10px] font-medium">Done</span>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Cost display */}
      {session.cost && (
        <span className="text-text-tertiary font-mono">
          ${session.cost.totalCostUsd.toFixed(3)}
          <span className="mx-1 opacity-50">|</span>
          {formatTokens(session.cost.inputTokens)} in / {formatTokens(session.cost.outputTokens)} out
        </span>
      )}

      {/* Interrupt button */}
      {isWorking && (
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-error/10 border border-error/30 text-error hover:bg-error/20 transition-colors"
          onClick={onInterrupt}
          title="Stop Claude"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
            <rect x="0" y="0" width="8" height="8" rx="1" />
          </svg>
          Stop
        </button>
      )}
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
