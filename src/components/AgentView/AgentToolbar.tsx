import type { AgentSessionState, EffortLevel, AgentPermissionMode } from "../../lib/types";

interface Props {
  session: AgentSessionState;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  onInterrupt: () => void;
}

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

const MODELS = [
  { value: "", label: "Default" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export function AgentToolbar({
  session,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onInterrupt,
}: Props) {
  const isWorking = session.status === "thinking" || session.status === "tool_use";
  const isPlanMode = session.permissionMode === "plan";

  return (
    <div className="flex items-center gap-3 px-4 py-2 border-b border-border-primary bg-bg-secondary text-xs shrink-0">
      {/* Model selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-text-tertiary">Model</span>
        <select
          className="bg-bg-tertiary border border-border-primary rounded px-1.5 py-0.5 text-text-primary text-xs focus:outline-none focus:border-accent cursor-pointer"
          value={session.model}
          onChange={(e) => onModelChange(e.target.value)}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Effort selector */}
      <div className="flex items-center gap-1">
        <span className="text-text-tertiary">Effort</span>
        <div className="flex rounded overflow-hidden border border-border-primary">
          {EFFORT_LEVELS.map((level) => (
            <button
              key={level}
              className={`px-1.5 py-0.5 text-[10px] transition-colors ${
                session.effort === level
                  ? "bg-accent text-white"
                  : "bg-bg-tertiary text-text-secondary hover:bg-bg-hover"
              }`}
              onClick={() => onEffortChange(level)}
            >
              {level}
            </button>
          ))}
        </div>
      </div>

      {/* Plan mode toggle */}
      <button
        className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${
          isPlanMode
            ? "border-accent bg-accent/10 text-accent"
            : "border-border-primary bg-bg-tertiary text-text-secondary hover:bg-bg-hover"
        }`}
        onClick={() =>
          onPermissionModeChange(isPlanMode ? "acceptEdits" : "plan")
        }
        title={isPlanMode ? "Exit plan mode" : "Enter plan mode (read-only analysis)"}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 2h6M2 5h6M2 8h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
        Plan
      </button>

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
