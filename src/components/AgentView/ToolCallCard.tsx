import { useState } from "react";
import { useAppStore, type SubagentChild } from "../../stores/appStore";
import { MarkdownContent } from "./MarkdownContent";

/** Stable reference so the Zustand selector doesn't trigger infinite re-renders. */
const EMPTY_CHILDREN: SubagentChild[] = [];

interface Props {
  toolName: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
  isActive?: boolean;
  worktreePath?: string;
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function normalizeToolName(name: string): string {
  const lower = name.toLowerCase();
  const map: Record<string, string> = {
    read: "Read",
    write: "Write",
    edit: "Edit",
    bash: "Bash",
    glob: "Glob",
    grep: "Grep",
    find: "Grep",
    ls: "Bash",
    todowrite: "TodoWrite",
    websearch: "WebSearch",
    web_search: "WebSearch",
    webfetch: "WebFetch",
    fetch_content: "WebFetch",
    agent: "Agent",
    subagent: "Subagent",
    code_search: "Grep",
    get_search_content: "Read",
  };
  return map[lower] || name;
}

/** Icon for common tool types. Falls back to a generic wrench. */
function ToolIcon({ name }: { name: string }) {
  switch (normalizeToolName(name)) {
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
    case "TodoWrite":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <rect x="1" y="1" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.1" />
          <path d="M3.5 6l1.5 1.5 3.5-3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "Subagent":
    case "Agent":
      return (
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <circle cx="6" cy="4" r="2.5" stroke="currentColor" strokeWidth="1.1" />
          <path d="M2 10.5c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
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

export function ToolCallCard({ toolName, toolInput, toolOutput, isError, isActive, worktreePath }: Props) {
  const normalized = normalizeToolName(toolName);
  const richContent = getRichContent(normalized, toolInput);
  const isSubagent = normalized === "Subagent";
  const [expanded, setExpanded] = useState(richContent !== null || isSubagent);
  const summary = toolInput != null ? summarizeInput(normalized, toolInput) : "";
  const subagentChildren = useAppStore((s) => isSubagent && isActive ? s.subagentChildren : EMPTY_CHILDREN);
  const hasDetail = (toolInput != null && !isSubagent) || !!toolOutput || isSubagent;

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
        <span className="font-mono text-text-secondary font-medium">
          {richContent?.label ?? normalized}
        </span>

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
          {richContent ? (
            <RichToolContent content={richContent} worktreePath={worktreePath} />
          ) : (
            <>
              {toolInput != null && !isSubagent && (
                <div>
                  <span className="text-text-tertiary text-[length:var(--app-font-10)] uppercase tracking-wider font-medium">Input</span>
                  <pre className="mt-0.5 text-text-secondary font-mono text-[length:var(--app-font-11)] whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-bg-tertiary/60 rounded px-2 py-1.5 leading-relaxed">
                    {typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}

          {/* Subagent: live children when active, task summary when completed */}
          {isSubagent && isActive && subagentChildren.length > 0 && (
            <div className="space-y-0.5">
              {subagentChildren.map((child) => (
                <SubagentChildRow key={child.id} child={child} />
              ))}
            </div>
          )}
          {isSubagent && !isActive && toolInput != null && (
            <SubagentTaskSummary input={toolInput} />
          )}

          {toolOutput && (
            <div>
              <span className={`text-[length:var(--app-font-10)] uppercase tracking-wider font-medium ${isError ? "text-error" : "text-text-tertiary"}`}>
                {isError ? "Error" : "Output"}
              </span>
              <pre className={`mt-0.5 font-mono text-[length:var(--app-font-11)] whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-bg-tertiary/60 rounded px-2 py-1.5 leading-relaxed ${
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

// ── Subagent child row ──

function SubagentChildRow({ child }: { child: SubagentChild }) {
  const role = child.role.charAt(0).toUpperCase() + child.role.slice(1);
  const taskPreview = child.task ? truncate(child.task, 80) : "";

  return (
    <div className="flex items-center gap-2 px-1.5 py-0.5 rounded font-mono text-[length:var(--app-font-11)]">
      {child.status === "done" ? (
        <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
      ) : child.status === "error" ? (
        <span className="w-1.5 h-1.5 rounded-full bg-error shrink-0" />
      ) : (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
        </span>
      )}

      <span className={
        child.status === "done" ? "text-text-tertiary" :
        child.status === "error" ? "text-error/80" :
        "text-text-secondary font-medium"
      }>
        {role}
      </span>

      {child.status === "running" && child.lastTool && (
        <span className="text-text-tertiary">{child.lastTool}</span>
      )}

      {child.status === "done" && (
        <span className="text-success/70">done</span>
      )}

      {child.status === "error" && (
        <span className="text-error/70 truncate">{child.error}</span>
      )}

      {child.status === "running" && !child.lastTool && taskPreview && (
        <span className="text-text-tertiary truncate">{taskPreview}</span>
      )}
    </div>
  );
}

/** Compact task summary for completed subagent cards (restored from cache). */
function SubagentTaskSummary({ input }: { input: unknown }) {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  // Build list of { role, task } entries
  const entries: { role: string; task: string }[] = [];
  if (Array.isArray(obj.tasks)) {
    for (const t of obj.tasks) {
      if (t && typeof t === "object") {
        const to = t as Record<string, unknown>;
        entries.push({
          role: String(to.agent || "worker"),
          task: String(to.task || ""),
        });
      }
    }
  } else if (obj.task) {
    entries.push({
      role: String(obj.agent || "worker"),
      task: String(obj.task),
    });
  }

  if (entries.length === 0) return null;

  return (
    <div className="space-y-0.5">
      {entries.map((e, i) => {
        const label = e.role.charAt(0).toUpperCase() + e.role.slice(1);
        return (
          <div key={i} className="flex items-center gap-2 px-1.5 py-0.5 font-mono text-[length:var(--app-font-11)]">
            <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
            <span className="text-text-tertiary">{label}</span>
            <span className="text-text-tertiary truncate">{truncate(e.task, 80)}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Rich content detection ──

type RichContent =
  | { kind: "todos"; label: string; todos: TodoItem[] }
  | { kind: "plan_md"; label: string; filePath: string; markdown: string };

function getRichContent(toolName: string, toolInput: unknown): RichContent | null {
  if (!toolInput || typeof toolInput !== "object") return null;
  const obj = toolInput as Record<string, unknown>;

  if (toolName === "TodoWrite" && Array.isArray(obj.todos)) {
    return { kind: "todos", label: "Plan", todos: obj.todos as TodoItem[] };
  }

  if (toolName === "Write" && typeof obj.content === "string") {
    const fp = (obj.file_path || obj.path) as string | undefined;
    if (typeof fp === "string" && isPlanFile(fp)) {
      return { kind: "plan_md", label: "Write Plan", filePath: fp, markdown: obj.content as string };
    }
  }

  return null;
}

function isPlanFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized.includes("/plans/") || normalized.includes("/plan")) {
    return normalized.endsWith(".md");
  }
  return false;
}

// ── Rich content renderer ──

function RichToolContent({ content, worktreePath }: { content: RichContent; worktreePath?: string }) {
  if (content.kind === "todos") {
    return (
      <div className="rounded-md border border-border-primary bg-bg-secondary/60 overflow-hidden">
        <div className="px-2.5 py-1.5 border-b border-border-primary flex items-center justify-between">
          <span className="text-[length:var(--app-font-10)] uppercase tracking-wider text-text-tertiary font-medium">Tasks</span>
          <span className="text-[length:var(--app-font-10)] text-text-tertiary font-mono">
            {content.todos.filter((t) => t.status === "completed").length}/{content.todos.length} done
          </span>
        </div>
        <div className="px-1 py-1 space-y-px max-h-72 overflow-y-auto">
          {content.todos.map((todo, i) => (
            <div key={i} className="flex items-start gap-2 px-1.5 py-1 rounded hover:bg-bg-hover/30">
              <span className="mt-0.5 shrink-0">
                {todo.status === "completed" ? (
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="text-success">
                    <rect x="1" y="1" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M4 7l2 2 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : todo.status === "in_progress" ? (
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="text-accent">
                    <rect x="1" y="1" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.2" />
                    <circle cx="7" cy="7" r="2" fill="currentColor" className="animate-pulse" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="text-text-tertiary">
                    <rect x="1" y="1" width="12" height="12" rx="2.5" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                )}
              </span>
              <span className={`text-[length:var(--app-font-11)] leading-relaxed ${
                todo.status === "completed" ? "text-text-tertiary line-through" :
                todo.status === "in_progress" ? "text-text-primary" :
                "text-text-secondary"
              }`}>
                {todo.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (content.kind === "plan_md") {
    return (
      <div className="rounded-md border border-border-primary bg-bg-secondary/60 overflow-hidden">
        <div className="px-2.5 py-1.5 border-b border-border-primary flex items-center justify-between">
          <span className="text-[length:var(--app-font-10)] uppercase tracking-wider text-text-tertiary font-medium">Plan</span>
          <span className="text-[length:var(--app-font-10)] text-text-tertiary font-mono">{shortPath(content.filePath)}</span>
        </div>
        <div className="px-2.5 py-2 max-h-80 overflow-y-auto text-[length:var(--app-font-12)]">
          <MarkdownContent text={content.markdown} worktreePath={worktreePath} />
        </div>
      </div>
    );
  }

  return null;
}

function summarizeInput(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
      return shortPath(String(obj.file_path || obj.path || ""));
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
    case "Subagent": {
      const role = String(obj.agent || "worker");
      const task = obj.task ? truncate(String(obj.task), 50) : "";
      const tasks = Array.isArray(obj.tasks) ? obj.tasks : [];
      if (tasks.length > 1) return `${tasks.length} parallel tasks`;
      return task ? `${role}: ${task}` : role;
    }
    case "TodoWrite": {
      const todos = Array.isArray(obj.todos) ? obj.todos as TodoItem[] : [];
      const done = todos.filter((t) => t.status === "completed").length;
      const active = todos.find((t) => t.status === "in_progress");
      if (active) return truncate(active.activeForm || active.content, 50);
      return `${done}/${todos.length} tasks`;
    }
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
