import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { PRPanel } from "../PRStatus/PRPanel";
import * as commands from "../../lib/commands";
import type { GitFileStatus } from "../../lib/commands";

type Tab = "uncommitted" | "pr-changes" | "pr-status";

export function ChangesPanel() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const requestClaudeTab = useAppStore((s) => s.requestClaudeTab);
  const openDiffTab = useAppStore((s) => s.openDiffTab);

  const project = projects.find((p) => p.id === selectedProjectId);
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);

  const [tab, setTab] = useState<Tab>("uncommitted");
  const [uncommittedFiles, setUncommittedFiles] = useState<GitFileStatus[]>([]);
  const [prFiles, setPrFiles] = useState<GitFileStatus[]>([]);
  const [loadingUncommitted, setLoadingUncommitted] = useState(false);
  const [loadingPr, setLoadingPr] = useState(false);

  const refreshUncommitted = useCallback(async () => {
    if (!worktree) return;
    setLoadingUncommitted(true);
    try {
      const status = await commands.getGitStatus(worktree.path);
      setUncommittedFiles(status);
    } catch {
      setUncommittedFiles([]);
    } finally {
      setLoadingUncommitted(false);
    }
  }, [worktree?.path]);

  const baseBranch = worktree?.target_branch || project?.base_branch || "main";

  const refreshPrFiles = useCallback(async () => {
    if (!worktree) return;
    setLoadingPr(true);
    try {
      const files = await commands.getPrDiffFiles(worktree.path, baseBranch);
      setPrFiles(files);
    } catch {
      setPrFiles([]);
    } finally {
      setLoadingPr(false);
    }
  }, [worktree?.path, baseBranch]);

  // Auto-refresh uncommitted on worktree change and every 5 seconds
  useEffect(() => {
    if (!worktree) return;
    refreshUncommitted();
    const interval = setInterval(refreshUncommitted, 5000);
    return () => clearInterval(interval);
  }, [worktree?.id, refreshUncommitted]);

  // Load PR files when that tab is selected
  useEffect(() => {
    if (tab === "pr-changes" && worktree) {
      refreshPrFiles();
    }
  }, [tab, worktree?.id]);

  if (!worktree || !project) return null;

  const handleFileClick = (file: string, mode: "uncommitted" | "pr") => {
    openDiffTab(worktree.id, file, worktree.path, mode, mode === "pr" ? baseBranch : undefined);
  };

  return (
    <div className="border-t border-border-primary flex flex-col min-h-0 shrink-0" style={{ maxHeight: "40%" }}>
      {/* Tab bar */}
      <div className="flex items-center gap-0 px-2 h-7 bg-bg-tertiary shrink-0">
        <TabButton
          label={`Changes${uncommittedFiles.length > 0 ? ` (${uncommittedFiles.length})` : ""}`}
          active={tab === "uncommitted"}
          onClick={() => setTab("uncommitted")}
        />
        <TabButton
          label={`PR Files${prFiles.length > 0 ? ` (${prFiles.length})` : ""}`}
          active={tab === "pr-changes"}
          onClick={() => setTab("pr-changes")}
        />
        <TabButton
          label="PR"
          active={tab === "pr-status"}
          onClick={() => setTab("pr-status")}
        />
        {tab === "uncommitted" && (
          <button
            onClick={refreshUncommitted}
            className="ml-auto text-text-tertiary hover:text-text-secondary transition-colors"
            title="Refresh"
          >
            <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
              <path d="M1 6a5 5 0 019-3M11 6a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        )}
        {tab === "pr-changes" && (
          <button
            onClick={refreshPrFiles}
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
        {tab === "uncommitted" && (
          <FileList
            files={uncommittedFiles}
            loading={loadingUncommitted}
            emptyMessage="No uncommitted changes"
            onFileClick={(f) => handleFileClick(f, "uncommitted")}
          />
        )}
        {tab === "pr-changes" && (
          <FileList
            files={prFiles}
            loading={loadingPr}
            emptyMessage={`No PR changes (or no common ancestor with ${baseBranch})`}
            onFileClick={(f) => handleFileClick(f, "pr")}
          />
        )}
        {tab === "pr-status" && (
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
              if (project.pr_create_skill) {
                // Use custom skill/command
                requestClaudeTab(project.pr_create_skill);
              } else {
                requestClaudeTab(
                  `claude "Please look at the changes on this branch compared to the ${baseBranch} branch (the target branch). Push the branch to origin if needed, then create a well-written pull request targeting the ${baseBranch} branch, with a clear title and description summarizing the changes. Use: gh pr create --base ${baseBranch}"`
                );
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`px-2 py-0.5 text-[11px] rounded-t transition-colors ${
        active
          ? "text-text-primary bg-bg-secondary"
          : "text-text-tertiary hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FileList({
  files,
  loading,
  emptyMessage,
  onFileClick,
}: {
  files: GitFileStatus[];
  loading: boolean;
  emptyMessage: string;
  onFileClick: (file: string) => void;
}) {
  if (loading && files.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-text-tertiary">Loading...</div>;
  }
  if (files.length === 0) {
    return <div className="px-3 py-2 text-[11px] text-text-tertiary">{emptyMessage}</div>;
  }
  return (
    <div className="py-0.5">
      {files.map((f) => (
        <button
          key={f.file}
          className="w-full flex items-center gap-2 px-3 py-0.5 text-[11px] hover:bg-bg-hover transition-colors text-left"
          onClick={() => onFileClick(f.file)}
        >
          <StatusBadge status={f.status} />
          <span className="truncate text-text-secondary font-mono">{f.file}</span>
        </button>
      ))}
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
