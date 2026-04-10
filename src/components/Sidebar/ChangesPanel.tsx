import { useState, useEffect, useRef, memo, useDeferredValue } from "react";
import { useAppStore } from "../../stores/appStore";
import { PRPanel } from "../PRStatus/PRPanel";
import * as commands from "../../lib/commands";
import type { GitFileStatus } from "../../lib/commands";

type Tab = "uncommitted" | "pr-changes" | "pr-status";

export const ChangesPanel = memo(function ChangesPanel() {
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

  // Defer the worktree ID so heavy content (PR panel) renders after the UI updates
  const deferredWtId = useDeferredValue(worktree?.id);
  const isStale = deferredWtId !== worktree?.id;
  const [uncommittedFiles, setUncommittedFiles] = useState<GitFileStatus[]>([]);
  const [prFiles, setPrFiles] = useState<GitFileStatus[]>([]);
  const [loadingUncommitted, setLoadingUncommitted] = useState(false);
  const [loadingPr, setLoadingPr] = useState(false);

  // Use refs for async operations to avoid stale closures and dependency churn
  const wtPathRef = useRef(worktree?.path);
  const wtIdRef = useRef(worktree?.id);
  const baseBranchRef = useRef(worktree?.target_branch || project?.base_branch || "main");
  wtPathRef.current = worktree?.path;
  wtIdRef.current = worktree?.id;
  baseBranchRef.current = worktree?.target_branch || project?.base_branch || "main";

  // Deferred uncommitted refresh
  useEffect(() => {
    if (!worktree) return;
    let cancelled = false;

    const refresh = async () => {
      if (!wtPathRef.current) return;
      setLoadingUncommitted(true);
      try {
        const status = await commands.getGitStatus(wtPathRef.current);
        if (!cancelled) setUncommittedFiles(status);
      } catch {
        if (!cancelled) setUncommittedFiles([]);
      } finally {
        if (!cancelled) setLoadingUncommitted(false);
      }
    };

    const timer = setTimeout(refresh, 500);
    const interval = setInterval(refresh, 5000);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); };
  }, [worktree?.id]);

  // PR files — only when tab is active
  useEffect(() => {
    if (tab !== "pr-changes" || !worktree) return;
    let cancelled = false;

    const refresh = async () => {
      if (!wtPathRef.current) return;
      setLoadingPr(true);
      try {
        const files = await commands.getPrDiffFiles(wtPathRef.current, baseBranchRef.current);
        if (!cancelled) setPrFiles(files);
      } catch {
        if (!cancelled) setPrFiles([]);
      } finally {
        if (!cancelled) setLoadingPr(false);
      }
    };

    const timer = setTimeout(refresh, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tab, worktree?.id]);

  if (!worktree || !project) return null;

  const baseBranch = baseBranchRef.current;

  return (
    <div className="border-t border-border-primary flex flex-col min-h-0 shrink-0" style={{ maxHeight: "40%" }}>
      <div className="flex items-center gap-0 px-2 h-7 bg-bg-tertiary shrink-0">
        <TabButton label={`Changes${uncommittedFiles.length > 0 ? ` (${uncommittedFiles.length})` : ""}`} active={tab === "uncommitted"} onClick={() => setTab("uncommitted")} />
        <TabButton label={`PR Files${prFiles.length > 0 ? ` (${prFiles.length})` : ""}`} active={tab === "pr-changes"} onClick={() => setTab("pr-changes")} />
        <TabButton
          label="PR"
          active={tab === "pr-status"}
          onClick={() => setTab("pr-status")}
        />
      </div>

      <div className="flex-1 overflow-y-auto min-h-0" style={{ opacity: isStale ? 0.5 : 1, transition: "opacity 100ms" }}>
        {tab === "uncommitted" && (
          <FileList
            files={uncommittedFiles}
            loading={loadingUncommitted}
            emptyMessage="No uncommitted changes"
            onFileClick={(f) => openDiffTab(worktree.id, f, worktree.path, "uncommitted")}
          />
        )}
        {tab === "pr-changes" && (
          <FileList
            files={prFiles}
            loading={loadingPr}
            emptyMessage={`No PR changes (or no common ancestor with ${baseBranch})`}
            onFileClick={(f) => openDiffTab(worktree.id, f, worktree.path, "pr", baseBranch)}
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
});

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`px-2 py-0.5 text-[11px] rounded-t transition-colors ${
        active ? "text-text-primary bg-bg-secondary" : "text-text-tertiary hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FileList({ files, loading, emptyMessage, onFileClick }: {
  files: GitFileStatus[];
  loading: boolean;
  emptyMessage: string;
  onFileClick: (file: string) => void;
}) {
  if (loading && files.length === 0) return <div className="px-3 py-2 text-[11px] text-text-tertiary">Loading...</div>;
  if (files.length === 0) return <div className="px-3 py-2 text-[11px] text-text-tertiary">{emptyMessage}</div>;
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
  const colors: Record<string, string> = { M: "text-warning", A: "text-success", D: "text-error", R: "text-accent", "??": "text-text-tertiary" };
  return <span className={`${colors[status] ?? "text-text-tertiary"} font-mono w-4 text-center shrink-0`}>{status}</span>;
}
