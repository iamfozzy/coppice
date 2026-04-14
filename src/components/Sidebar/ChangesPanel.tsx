import { useState, useEffect, useRef, memo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
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
  const appSettings = useAppStore((s) => s.appSettings);

  const project = projects.find((p) => p.id === selectedProjectId);
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);

  const [tab, setTab] = useState<Tab>("uncommitted");

  // Delay content rendering after worktree switch to prevent UI blocking
  const [contentReady, setContentReady] = useState(false);
  const prevWtId = useRef(worktree?.id);
  useEffect(() => {
    if (worktree?.id !== prevWtId.current) {
      prevWtId.current = worktree?.id;
      setContentReady(false);
      const raf = requestAnimationFrame(() => {
        setContentReady(true);
      });
      return () => cancelAnimationFrame(raf);
    } else {
      setContentReady(true);
    }
  }, [worktree?.id]);

  const [uncommittedFiles, setUncommittedFiles] = useState<GitFileStatus[]>([]);
  const [prFiles, setPrFiles] = useState<GitFileStatus[]>([]);
  const [loadingUncommitted, setLoadingUncommitted] = useState(false);
  const [loadingPr, setLoadingPr] = useState(false);
  const [unpushedCount, setUnpushedCount] = useState(0);
  const [revertingFile, setRevertingFile] = useState<string | null>(null);

  // Use refs for async operations to avoid stale closures and dependency churn
  const wtPathRef = useRef(worktree?.path);
  const wtIdRef = useRef(worktree?.id);
  const baseBranchRef = useRef(worktree?.target_branch || project?.base_branch || "main");
  wtPathRef.current = worktree?.path;
  wtIdRef.current = worktree?.id;
  baseBranchRef.current = worktree?.target_branch || project?.base_branch || "main";

  // Deferred uncommitted refresh + unpushed count
  useEffect(() => {
    if (!worktree) return;
    let cancelled = false;

    const refresh = async () => {
      if (!wtPathRef.current) return;
      setLoadingUncommitted(true);
      try {
        const [status, count] = await Promise.all([
          commands.getGitStatus(wtPathRef.current),
          commands.getUnpushedCount(wtPathRef.current).catch(() => 0),
        ]);
        if (!cancelled) {
          setUncommittedFiles(status);
          setUnpushedCount(count);
        }
      } catch {
        if (!cancelled) {
          setUncommittedFiles([]);
          setUnpushedCount(0);
        }
      } finally {
        if (!cancelled) setLoadingUncommitted(false);
      }
    };

    const timer = setTimeout(refresh, 500);
    const interval = setInterval(refresh, 5000);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); };
  }, [worktree?.id]);

  // PR files — always fetch so tab count stays current
  useEffect(() => {
    if (!worktree) return;
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

    const timer = setTimeout(refresh, 500);
    const interval = setInterval(refresh, 5000);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); };
  }, [worktree?.id]);

  if (!worktree || !project) return null;

  const baseBranch = baseBranchRef.current;
  const claudeCmd = project.claude_command || appSettings?.claude_command || "claude";
  const hasLocalChanges = uncommittedFiles.length > 0 || unpushedCount > 0;

  const handleRevert = async (file: string, status: string) => {
    if (!worktree) return;
    const action = status === "??" ? "delete" : "revert";
    const confirmed = await ask(`Are you sure you want to ${action} "${file}"?`, { title: "Revert changes", kind: "warning" });
    if (!confirmed) return;
    const wtPath = worktree.path;
    setRevertingFile(file);
    try {
      await commands.revertFile(wtPath, file, status);
      // Refresh status from git to get the real state
      const [freshStatus, freshCount] = await Promise.all([
        commands.getGitStatus(wtPath),
        commands.getUnpushedCount(wtPath).catch(() => 0),
      ]);
      setUncommittedFiles(freshStatus);
      setUnpushedCount(freshCount);
    } catch (e) {
      console.error("Failed to revert file:", e);
    } finally {
      setRevertingFile(null);
    }
  };

  const handlePush = () => {
    if (uncommittedFiles.length > 0) {
      requestClaudeTab(
        `${claudeCmd} "Commit all the changes in this worktree with a clear, descriptive commit message, then push to origin."`
      );
    } else {
      requestClaudeTab(
        `${claudeCmd} "Push the current branch to origin."`
      );
    }
  };

  return (
    <div className="border-t border-border-primary flex flex-col min-h-0 shrink-0" style={{ maxHeight: "40%" }}>
      <div className="flex items-center gap-0 px-2 h-7 bg-bg-tertiary shrink-0 overflow-hidden">
        <div className="flex items-center min-w-0 shrink">
          <TabButton label={`Changes${uncommittedFiles.length > 0 ? ` (${uncommittedFiles.length})` : ""}`} active={tab === "uncommitted"} onClick={() => setTab("uncommitted")} />
          <TabButton label={`Files${prFiles.length > 0 ? ` (${prFiles.length})` : ""}`} active={tab === "pr-changes"} onClick={() => setTab("pr-changes")} />
          <TabButton
            label="PR"
            active={tab === "pr-status"}
            onClick={() => setTab("pr-status")}
          />
        </div>
        {hasLocalChanges && (
          <button
            className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-secondary hover:text-text-primary hover:bg-bg-active transition-colors whitespace-nowrap shrink-0"
            onClick={handlePush}
          >
            {uncommittedFiles.length > 0 ? "Commit & Push" : `Push (${unpushedCount})`}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "uncommitted" && (
          <FileList
            files={uncommittedFiles}
            loading={loadingUncommitted}
            emptyMessage="No uncommitted changes"
            onFileClick={(f) => openDiffTab(worktree.id, f, worktree.path, "uncommitted")}
            onRevert={handleRevert}
            revertingFile={revertingFile}
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
        {tab === "pr-status" && contentReady && (
          <PRPanel
            projectId={project.id}
            branch={worktree.branch}
            worktreePath={worktree.path}
            onFixWithClaude={(context) => {
              requestClaudeTab(
                `${claudeCmd} "The CI checks have failed. Here are the logs:\n\n${context
                  .replace(/"/g, '\\"')
                  .substring(0, 5000)}\n\nPlease analyze and fix the failures."`
              );
            }}
            onOpenFile={(file) => openDiffTab(worktree.id, file, worktree.path, "pr", baseBranch)}
            onCreatePrWithClaude={() => {
              if (project.pr_create_skill) {
                requestClaudeTab(project.pr_create_skill);
              } else {
                requestClaudeTab(
                  `${claudeCmd} "Please look at the changes on this branch compared to the ${baseBranch} branch (the target branch). Push the branch to origin if needed, then create a well-written pull request targeting the ${baseBranch} branch, with a clear title and description summarizing the changes. Use: gh pr create --base ${baseBranch}"`
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
      className={`px-2 py-0.5 text-[11px] rounded-t transition-colors whitespace-nowrap truncate ${
        active ? "text-text-primary bg-bg-secondary" : "text-text-tertiary hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FileList({ files, loading, emptyMessage, onFileClick, onRevert, revertingFile }: {
  files: GitFileStatus[];
  loading: boolean;
  emptyMessage: string;
  onFileClick: (file: string) => void;
  onRevert?: (file: string, status: string) => void;
  revertingFile?: string | null;
}) {
  if (loading && files.length === 0) return <div className="px-3 py-2 text-[11px] text-text-tertiary">Loading...</div>;
  if (files.length === 0) return <div className="px-3 py-2 text-[11px] text-text-tertiary">{emptyMessage}</div>;
  return (
    <div className="py-0.5">
      {files.map((f) => (
        <div
          key={f.file}
          className="group w-full flex items-center gap-2 px-3 py-0.5 text-[11px] hover:bg-bg-hover transition-colors"
        >
          <button
            className="flex items-center gap-2 min-w-0 flex-1 text-left"
            onClick={() => onFileClick(f.file)}
          >
            <StatusBadge status={f.status} />
            <span className="truncate text-text-secondary font-mono">{f.file}</span>
          </button>
          {onRevert && (
            <button
              className="opacity-0 group-hover:opacity-100 shrink-0 px-1 py-0.5 text-[10px] text-text-tertiary hover:text-error transition-all"
              title="Revert changes"
              disabled={revertingFile === f.file}
              onClick={(e) => {
                e.stopPropagation();
                onRevert(f.file, f.status);
              }}
            >
              {revertingFile === f.file ? "..." : "\u21A9"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { M: "text-warning", A: "text-success", D: "text-error", R: "text-accent", "??": "text-text-tertiary" };
  return <span className={`${colors[status] ?? "text-text-tertiary"} font-mono w-4 text-center shrink-0`}>{status}</span>;
}
