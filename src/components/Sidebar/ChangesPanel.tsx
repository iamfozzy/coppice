import { useState, useEffect, useRef, memo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/appStore";
import { PRPanel } from "../PRStatus/PRPanel";
import * as commands from "../../lib/commands";
import type { GitFileStatus } from "../../lib/commands";

type Tab = "uncommitted" | "pr-changes" | "pr-status";
type FileContextMenuState = {
  file: string;
  status: string;
  x: number;
  y: number;
};

function splitDisplayPath(file: string) {
  const normalized = file.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash === -1) {
    return { directory: "", fileName: normalized };
  }

  return {
    directory: normalized.slice(0, lastSlash),
    fileName: normalized.slice(lastSlash + 1),
  };
}

function buildTooltipPath(basePath: string, file: string) {
  const trimmedBase = basePath.replace(/[\\/]+$/, "");
  return `${trimmedBase}/${file}`;
}

export const ChangesPanel = memo(function ChangesPanel() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const requestClaudeTab = useAppStore((s) => s.requestClaudeTab);
  const requestAgentTab = useAppStore((s) => s.requestAgentTab);
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
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);

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

  useEffect(() => {
    if (!contextMenu) return;

    const closeMenu = () => setContextMenu(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("blur", closeMenu);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("blur", closeMenu);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

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
  const contextMenuLeft = contextMenu ? Math.max(8, Math.min(contextMenu.x, window.innerWidth - 196)) : 0;
  const contextMenuTop = contextMenu ? Math.max(8, Math.min(contextMenu.y, window.innerHeight - 120)) : 0;

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

  const handleOpenInEditor = async (file: string) => {
    if (!worktree) return;

    try {
      await commands.openWorktreeFileInEditor(worktree.path, file);
    } catch (error) {
      console.error("Failed to open file in editor:", error);
    }
  };

  const useAgent = appSettings?.default_claude_mode === "agent";
  const sendToAgent = (prompt: string, model?: string) => {
    if (useAgent) {
      requestAgentTab(prompt, model);
    } else {
      requestClaudeTab(`${claudeCmd} "${prompt}"`);
    }
  };

  const HAIKU_MODEL = "claude-haiku-4-5-20251001";

  const handlePush = () => {
    if (uncommittedFiles.length > 0) {
      sendToAgent("Commit all the changes in this worktree with a clear, descriptive commit message, then push to origin.", HAIKU_MODEL);
    } else {
      sendToAgent("Push the current branch to origin.", HAIKU_MODEL);
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
        {hasLocalChanges ? (
          <button
            className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-secondary hover:text-text-primary hover:bg-bg-active transition-colors whitespace-nowrap shrink-0"
            onClick={handlePush}
          >
            {uncommittedFiles.length > 0 ? "Commit & Push" : `Push (${unpushedCount})`}
          </button>
        ) : (
          <button
            className="ml-auto px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-secondary hover:text-text-primary hover:bg-bg-active transition-colors whitespace-nowrap shrink-0"
            onClick={() => {
              if (project.pr_create_skill && !useAgent) {
                requestClaudeTab(project.pr_create_skill);
              } else {
                sendToAgent(
                  `Please look at the changes on this branch compared to the ${baseBranch} branch (the target branch). Push the branch to origin if needed, then create a well-written pull request targeting the ${baseBranch} branch, with a clear title and description summarizing the changes. Use: gh pr create --base ${baseBranch}`,
                  HAIKU_MODEL
                );
              }
            }}
          >
            Create PR
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {tab === "uncommitted" && (
          <FileList
            files={uncommittedFiles}
            loading={loadingUncommitted}
            emptyMessage="No uncommitted changes"
            worktreePath={worktree.path}
            onFileClick={(f) => openDiffTab(worktree.id, f, worktree.path, "uncommitted")}
            onFileContextMenu={(event, file, status) => {
              event.preventDefault();
              setContextMenu({
                file,
                status,
                x: event.clientX,
                y: event.clientY,
              });
            }}
            onRevert={handleRevert}
            revertingFile={revertingFile}
          />
        )}
        {tab === "pr-changes" && (
          <FileList
            files={prFiles}
            loading={loadingPr}
            emptyMessage={`No PR changes (or no common ancestor with ${baseBranch})`}
            worktreePath={worktree.path}
            onFileClick={(f) => openDiffTab(worktree.id, f, worktree.path, "pr", baseBranch)}
          />
        )}
        {tab === "pr-status" && contentReady && (
          <PRPanel
            projectId={project.id}
            branch={worktree.branch}
            worktreePath={worktree.path}
            onFixWithClaude={(context) => {
              if (typeof context === "object" && "prNumber" in context) {
                const checkList = context.failedChecks.length > 0
                  ? `Failed checks: ${context.failedChecks.join(", ")}`
                  : "";
                sendToAgent(
                  `The CI checks have failed for PR #${context.prNumber}. ${checkList}\n\nPlease fetch the failed CI logs using \`gh run list\` and \`gh run view\`, analyze the failures, and fix them.`
                );
              } else {
                sendToAgent(
                  `The CI checks have failed. Here are the logs:\n\n${context.substring(0, 5000)}\n\nPlease analyze and fix the failures.`
                );
              }
            }}
            onOpenFile={(file) => openDiffTab(worktree.id, file, worktree.path, "pr", baseBranch)}
          />
        )}
      </div>

      {contextMenu && (
        <div
          className="fixed inset-0 z-50"
          onClick={() => setContextMenu(null)}
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenu(null);
          }}
        >
          <div
            className="absolute min-w-[188px] overflow-hidden rounded-md border border-border-primary bg-bg-secondary shadow-lg"
            style={{ left: contextMenuLeft, top: contextMenuTop }}
            onClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button
              className="w-full px-3 py-2 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              onClick={() => {
                openDiffTab(worktree.id, contextMenu.file, worktree.path, "uncommitted");
                setContextMenu(null);
              }}
            >
              Open diff
            </button>
            <button
              className="w-full px-3 py-2 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              onClick={() => {
                void handleOpenInEditor(contextMenu.file);
                setContextMenu(null);
              }}
            >
              Open in editor
            </button>
            <button
              className="w-full px-3 py-2 text-left text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-error"
              onClick={() => {
                setContextMenu(null);
                void handleRevert(contextMenu.file, contextMenu.status);
              }}
            >
              Revert changes
            </button>
          </div>
        </div>
      )}
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

function FileList({ files, loading, emptyMessage, worktreePath, onFileClick, onFileContextMenu, onRevert, revertingFile }: {
  files: GitFileStatus[];
  loading: boolean;
  emptyMessage: string;
  worktreePath: string;
  onFileClick: (file: string) => void;
  onFileContextMenu?: (event: React.MouseEvent<HTMLDivElement>, file: string, status: string) => void;
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
          onContextMenu={onFileContextMenu ? (event) => onFileContextMenu(event, f.file, f.status) : undefined}
        >
          <button
            className="flex items-center gap-2 min-w-0 flex-1 text-left"
            onClick={() => onFileClick(f.file)}
            title={buildTooltipPath(worktreePath, f.file)}
          >
            <StatusBadge status={f.status} />
            <FilePathLabel file={f.file} />
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

function FilePathLabel({ file }: { file: string }) {
  const { directory, fileName } = splitDisplayPath(file);

  return (
    <span className="flex min-w-0 items-baseline gap-1 font-mono">
      {directory && (
        <span className="min-w-0 flex-1 truncate text-text-tertiary" dir="rtl">
          {directory}/
        </span>
      )}
      <span className="shrink-0 text-text-secondary">{fileName}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { M: "text-warning", A: "text-success", D: "text-error", R: "text-accent", "??": "text-text-tertiary" };
  return <span className={`${colors[status] ?? "text-text-tertiary"} font-mono w-4 text-center shrink-0`}>{status}</span>;
}
