import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { PRPanel } from "../PRStatus/PRPanel";
import * as commands from "../../lib/commands";
import type { GitFileStatus } from "../../lib/commands";

type Tab = "changes" | "pr";

export function ChangesPanel() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const requestClaudeTab = useAppStore((s) => s.requestClaudeTab);

  const project = projects.find((p) => p.id === selectedProjectId);
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);

  const [tab, setTab] = useState<Tab>("changes");
  const [files, setFiles] = useState<GitFileStatus[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!worktree) return;
    setLoading(true);
    try {
      const status = await commands.getGitStatus(worktree.path);
      setFiles(status);
    } catch {
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [worktree?.path]);

  // Auto-refresh on worktree change and every 5 seconds
  useEffect(() => {
    if (!worktree) return;
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [worktree?.id, refresh]);

  if (!worktree || !project) return null;

  return (
    <div className="border-t border-border-primary flex flex-col min-h-0 shrink-0" style={{ maxHeight: "40%" }}>
      {/* Tab bar */}
      <div className="flex items-center gap-0 px-2 h-7 bg-bg-tertiary shrink-0">
        <button
          className={`px-2 py-0.5 text-[11px] rounded-t transition-colors ${
            tab === "changes"
              ? "text-text-primary bg-bg-secondary"
              : "text-text-tertiary hover:text-text-secondary"
          }`}
          onClick={() => setTab("changes")}
        >
          Changes{files.length > 0 ? ` (${files.length})` : ""}
        </button>
        <button
          className={`px-2 py-0.5 text-[11px] rounded-t transition-colors ${
            tab === "pr"
              ? "text-text-primary bg-bg-secondary"
              : "text-text-tertiary hover:text-text-secondary"
          }`}
          onClick={() => setTab("pr")}
        >
          PR
        </button>
        {tab === "changes" && (
          <button
            onClick={refresh}
            className="ml-auto text-text-tertiary hover:text-text-secondary transition-colors"
            title="Refresh"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M1 6a5 5 0 019-3M11 6a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "changes" ? (
          loading && files.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-text-tertiary">Loading...</div>
          ) : files.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-text-tertiary">No changes</div>
          ) : (
            <div className="py-0.5">
              {files.map((f) => (
                <div
                  key={f.file}
                  className="flex items-center gap-2 px-3 py-0.5 text-[11px] hover:bg-bg-hover transition-colors"
                >
                  <StatusBadge status={f.status} />
                  <span className="truncate text-text-secondary font-mono">{f.file}</span>
                </div>
              ))}
            </div>
          )
        ) : (
          <PRPanel
            projectId={project.id}
            branch={worktree.branch}
            worktreePath={worktree.path}
            onFixWithClaude={(context) => {
              requestClaudeTab(
                `claude "The CI checks have failed. Here are the logs:\n\n${context
                  .replace(/"/g, '\\"')
                  .substring(0, 5000)}\n\nPlease analyze and fix the failures."`
              );
            }}
            onCreatePrWithClaude={() => {
              requestClaudeTab(
                `claude "Please look at the changes on this branch compared to the main branch. Push the branch to origin if needed, then create a well-written pull request with a clear title and description summarizing the changes. Use gh pr create."`
              );
            }}
          />
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    M: "text-warning",
    A: "text-success",
    D: "text-error",
    R: "text-accent",
    "??": "text-text-tertiary",
  };
  const color = colors[status] ?? "text-text-tertiary";

  return (
    <span className={`${color} font-mono w-4 text-center shrink-0`}>
      {status}
    </span>
  );
}
