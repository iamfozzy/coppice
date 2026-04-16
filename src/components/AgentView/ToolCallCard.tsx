import { useState } from "react";

interface Props {
  toolName: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
  isActive?: boolean;
}

export function ToolCallCard({ toolName, toolInput, toolOutput, isError, isActive }: Props) {
  const [expanded, setExpanded] = useState(isActive ?? false);

  return (
    <div className={`rounded border text-xs ${
      isError ? "border-error/30 bg-error/5" : "border-border-primary bg-bg-tertiary"
    }`}>
      <button
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-bg-hover/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {/* Status indicator */}
        {isActive ? (
          <span className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
        ) : isError ? (
          <span className="w-2 h-2 rounded-full bg-error shrink-0" />
        ) : (
          <span className="w-2 h-2 rounded-full bg-success shrink-0" />
        )}

        <span className="font-mono text-text-primary font-medium">{toolName}</span>

        {/* Brief summary */}
        {toolInput != null && !expanded && (
          <span className="text-text-tertiary truncate ml-1">
            {summarizeInput(toolName, toolInput)}
          </span>
        )}

        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          className={`ml-auto shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 pb-2 space-y-2">
          {/* Input */}
          {toolInput != null && (
            <div>
              <span className="text-text-tertiary text-[10px] uppercase tracking-wider">Input</span>
              <pre className="mt-0.5 text-text-secondary font-mono text-[11px] whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2)}
              </pre>
            </div>
          )}

          {/* Output */}
          {toolOutput && (
            <div>
              <span className={`text-[10px] uppercase tracking-wider ${isError ? "text-error" : "text-text-tertiary"}`}>
                {isError ? "Error" : "Output"}
              </span>
              <pre className={`mt-0.5 font-mono text-[11px] whitespace-pre-wrap break-all max-h-40 overflow-y-auto ${
                isError ? "text-error/80" : "text-text-secondary"
              }`}>
                {toolOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function summarizeInput(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return String(obj.file_path || "");
    case "Bash":
      return String(obj.command || "").slice(0, 80);
    case "Glob":
      return String(obj.pattern || "");
    case "Grep":
      return String(obj.pattern || "");
    case "WebSearch":
      return String(obj.query || "");
    case "WebFetch":
      return String(obj.url || "");
    default:
      return "";
  }
}
