import { useState } from "react";

interface Props {
  toolName: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
  isActive?: boolean;
}

/** Icon for common tool types. Falls back to a generic wrench. */
function ToolIcon({ name }: { name: string }) {
  switch (name) {
    case "Read":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <path d="M2 1h5l3 3v7H2V1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
          <path d="M7 1v3h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Write":
    case "Edit":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <path d="M8.5 1.5l2 2-7 7H1.5V8.5l7-7z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      );
    case "Bash":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <path d="M2 4l3 2-3 2M6 8h4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Glob":
    case "Grep":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.1" />
          <path d="M8 8l2.5 2.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <path d="M7.5 1L9 4l-3 1 1 6-3.5-4L1 8l1.5-4L0 3l3.5-.5L5 0l1 2.5 1.5-1.5z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        </svg>
      );
  }
}

export function ToolCallCard({ toolName, toolInput, toolOutput, isError, isActive }: Props) {
  const [expanded, setExpanded] = useState(false);
  const summary = toolInput != null ? summarizeInput(toolName, toolInput) : "";
  const hasDetail = toolInput != null || !!toolOutput;

  const accent = isError ? "text-error" : isActive ? "text-accent" : "text-text-tertiary";

  return (
    <div className="text-xs">
      <button
        type="button"
        className={`flex items-center gap-2 w-full text-left px-1.5 py-0.5 rounded transition-colors ${
          hasDetail ? "hover:bg-bg-hover/40 cursor-pointer" : "cursor-default"
        }`}
        onClick={hasDetail ? () => setExpanded((v) => !v) : undefined}
      >
        {/* Status dot */}
        {isActive ? (
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
          </span>
        ) : (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isError ? "bg-error" : "bg-success"}`} />
        )}

        <span className={accent}><ToolIcon name={toolName} /></span>
        <span className="font-mono text-text-secondary font-medium">{toolName}</span>

        {summary && (
          <span className="text-text-tertiary truncate font-mono min-w-0">{summary}</span>
        )}

        {hasDetail && (
          <svg
            width="9" height="9" viewBox="0 0 10 10" fill="none"
            className={`ml-auto shrink-0 text-text-tertiary/70 transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {expanded && hasDetail && (
        <div className="pl-5 pr-1 pt-1 pb-1.5 space-y-1.5">
          {toolInput != null && (
            <div>
              <span className="text-text-tertiary text-[10px] uppercase tracking-wider font-medium">Input</span>
              <pre className="mt-0.5 text-text-secondary font-mono text-[11px] whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-bg-tertiary/60 rounded px-2 py-1.5 leading-relaxed">
                {typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2)}
              </pre>
            </div>
          )}

          {toolOutput && (
            <div>
              <span className={`text-[10px] uppercase tracking-wider font-medium ${isError ? "text-error" : "text-text-tertiary"}`}>
                {isError ? "Error" : "Output"}
              </span>
              <pre className={`mt-0.5 font-mono text-[11px] whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-bg-tertiary/60 rounded px-2 py-1.5 leading-relaxed ${
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
      return shortPath(String(obj.file_path || ""));
    case "Edit":
      return shortPath(String(obj.file_path || ""));
    case "Bash":
      return truncate(String(obj.command || ""), 70);
    case "Glob":
      return String(obj.pattern || "");
    case "Grep":
      return truncate(String(obj.pattern || ""), 50);
    case "WebSearch":
      return truncate(String(obj.query || ""), 60);
    case "WebFetch":
      return truncate(String(obj.url || ""), 60);
    case "Agent":
      return truncate(String(obj.description || ""), 60);
    default:
      return "";
  }
}

/** Show only the last 2 path segments to keep the summary short. */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "..." : s;
}
