import { useState, useEffect, useRef, memo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/appStore";
import { PRPanel } from "../PRStatus/PRPanel";
import { Tooltip } from "../ui/Tooltip";
import * as commands from "../../lib/commands";
import type { GitFileStatus } from "../../lib/commands";
import { cacheGetStale, cacheSet } from "../../lib/cache";
import { useWindowFocused } from "../../lib/windowFocus";

// Keep in sync with appStore.ts warming keys.
const gitStatusKey = (path: string) => `git-status-${path}`;
const unpushedCountKey = (path: string) => `unpushed-count-${path}`;
const prFilesKey = (path: string, baseBranch: string) => `pr-files-${path}-${baseBranch}`;
import { resolveDefaultSessionMode } from "../../lib/defaultSessionMode";

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

function fallbackDoubleQuoteArg(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$").replace(/`/g, "\\`")}"`;
}

function firstShellToken(command: string) {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const quote = trimmed[0] === '"' || trimmed[0] === "'" ? trimmed[0] : "";
  if (quote) {
    for (let i = 1; i < trimmed.length; i += 1) {
      if (trimmed[i] === quote && trimmed[i - 1] !== "\\") return trimmed.slice(1, i);
    }
  }
  return trimmed.split(/\s+/, 1)[0] ?? "";
}

function commandBasename(token: string) {
  return token.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function looksLikeClaudeCliCommand(command: string, configuredClaudeCommand: string) {
  const first = commandBasename(firstShellToken(command));
  const configured = commandBasename(firstShellToken(configuredClaudeCommand));
  return first === configured || first === "claude" || first === "claude.exe" || first === "claude.cmd";
}

export const ChangesPanel = memo(function ChangesPanel() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const activeTabByWorktree = useAppStore((s) => s.activeTabByWorktree);
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
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("coppice:changesPanelCollapsed") === "1"; } catch { return false; }
  });
  const windowFocused = useWindowFocused();

  const setCollapsedPersist = (next: boolean) => {
    setCollapsed(next);
    try { localStorage.setItem("coppice:changesPanelCollapsed", next ? "1" : "0"); } catch {}
  };

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
  const baseBranchRef = useRef(worktree?.target_branch || project?.target_branch || project?.base_branch || "main");
  wtPathRef.current = worktree?.path;
  wtIdRef.current = worktree?.id;
  baseBranchRef.current = worktree?.target_branch || project?.target_branch || project?.base_branch || "main";

  // Hydrate from the warm cache so a worktree switch shows the new worktree's
  // git state immediately instead of the previous worktree's stale data
  // bleeding through the 500ms before the first poll resolves.
  useEffect(() => {
    const wtPath = worktree?.path;
    if (!wtPath) return;
    const cachedStatus = cacheGetStale<GitFileStatus[]>(gitStatusKey(wtPath));
    const cachedCount = cacheGetStale<number>(unpushedCountKey(wtPath));
    const cachedPr = cacheGetStale<GitFileStatus[]>(prFilesKey(wtPath, baseBranchRef.current));
    setUncommittedFiles(cachedStatus ?? []);
    setUnpushedCount(cachedCount ?? 0);
    setPrFiles(cachedPr ?? []);
  }, [worktree?.id]);

  // Deferred uncommitted refresh + unpushed count.
  // Polls only while the window is focused — avoids burning ~2 git subprocesses
  // every 5s for every open worktree when the user is in another app.
  // On focus regain, refreshes immediately and then resumes the 5s cadence.
  useEffect(() => {
    if (!worktree) return;
    if (!windowFocused) return;
    let cancelled = false;

    let first = true;
    const refresh = async () => {
      if (!wtPathRef.current) return;
      if (first) { setLoadingUncommitted(true); first = false; }
      try {
        const [status, count] = await Promise.all([
          commands.getGitStatus(wtPathRef.current),
          commands.getUnpushedCount(wtPathRef.current).catch(() => 0),
        ]);
        if (!cancelled) {
          setUncommittedFiles(status);
          setUnpushedCount(count);
          if (wtPathRef.current) {
            cacheSet(gitStatusKey(wtPathRef.current), status);
            cacheSet(unpushedCountKey(wtPathRef.current), count);
          }
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
  }, [worktree?.id, windowFocused]);

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

  // PR files — always fetch so tab count stays current.
  // Same focus-gating as the uncommitted poll above.
  useEffect(() => {
    if (!worktree) return;
    if (!windowFocused) return;
    let cancelled = false;

    let first = true;
    const refresh = async () => {
      if (!wtPathRef.current) return;
      if (first) { setLoadingPr(true); first = false; }
      try {
        const files = await commands.getPrDiffFiles(wtPathRef.current, baseBranchRef.current);
        if (!cancelled) {
          setPrFiles(files);
          cacheSet(prFilesKey(wtPathRef.current, baseBranchRef.current), files);
        }
      } catch {
        if (!cancelled) setPrFiles([]);
      } finally {
        if (!cancelled) setLoadingPr(false);
      }
    };

    const timer = setTimeout(refresh, 500);
    const interval = setInterval(refresh, 5000);
    return () => { cancelled = true; clearTimeout(timer); clearInterval(interval); };
  }, [worktree?.id, windowFocused]);

  if (!worktree || !project || selectedWorktreeId === "__scratchpad__") return null;

  const baseBranch = baseBranchRef.current;
  const activeTabId = activeTabByWorktree[worktree.id] ?? null;
  const activeTab = (tabsByWorktree[worktree.id] ?? []).find((t) => t.id === activeTabId);
  const activeDiffFile = activeTab?.type === "diff" ? activeTab.diffFile : undefined;
  const activeDiffMode = activeTab?.type === "diff" ? activeTab.diffMode : undefined;
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

  const defaultSessionMode = resolveDefaultSessionMode(appSettings);
  const useAgent = defaultSessionMode !== "terminal";
  const backend = defaultSessionMode === "pi" ? "pi" : "claude";
  const sendToAgent = (prompt: string, model?: string) => {
    if (useAgent) {
      requestAgentTab(prompt, model, backend);
      return;
    }

    commands.buildClaudePromptCommand(claudeCmd, prompt)
      .then(requestClaudeTab)
      .catch((error) => {
        console.error("Failed to build Claude CLI prompt command:", error);
        requestClaudeTab(`${claudeCmd} ${fallbackDoubleQuoteArg(prompt)}`);
      });
  };

  // In Pi mode, use the user's default model (no override needed).
  // In Claude mode, use Haiku for fast/cheap commit and push operations.
  const fastModel = backend === "pi" ? undefined : "claude-haiku-4-5-20251001";

  const handlePush = () => {
    if (uncommittedFiles.length > 0) {
      sendToAgent("Commit all the changes in this worktree with a clear, descriptive commit message, then push to origin. Do NOT add any Co-Authored-By or attribution lines to the commit message.", fastModel);
    } else {
      sendToAgent("Push the current branch to origin.", fastModel);
    }
  };

  return (
    <div className="border-t border-border-primary flex flex-col min-h-0 shrink-0" style={collapsed ? undefined : { maxHeight: "40%" }}>
      <div
        role="button"
        tabIndex={0}
        className="flex items-center gap-0 pl-3 pr-2 h-7 bg-bg-tertiary shrink-0 overflow-hidden hover:bg-bg-hover transition-colors cursor-pointer select-none"
        onClick={() => setCollapsedPersist(!collapsed)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setCollapsedPersist(!collapsed);
          }
        }}
      >
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          className={`shrink-0 mr-2 text-text-secondary transition-transform ${collapsed ? "" : "rotate-90"}`}
        >
          <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
        <div className="flex items-center min-w-0 shrink">
          <TabButton
            label={`Uncommitted${uncommittedFiles.length > 0 ? ` (${uncommittedFiles.length})` : ""}`}
            active={tab === "uncommitted"}
            onClick={(e) => { e.stopPropagation(); setTab("uncommitted"); if (collapsed) setCollapsedPersist(false); }}
          />
          <TabButton
            label={`Files${prFiles.length > 0 ? ` (${prFiles.length})` : ""}`}
            active={tab === "pr-changes"}
            onClick={(e) => { e.stopPropagation(); setTab("pr-changes"); if (collapsed) setCollapsedPersist(false); }}
          />
          <TabButton
            label="PR"
            active={tab === "pr-status"}
            onClick={(e) => { e.stopPropagation(); setTab("pr-status"); if (collapsed) setCollapsedPersist(false); }}
          />
        </div>
        {hasLocalChanges && (
          <Tooltip text={uncommittedFiles.length > 0 ? "Commit all changes and push to origin" : `Push ${unpushedCount} unpushed commit${unpushedCount !== 1 ? "s" : ""} to origin`} side="top" align="right">
            <button
              className="ml-auto px-1.5 py-0.5 text-[length:var(--app-font-10)] rounded bg-bg-hover text-text-secondary hover:text-text-primary hover:bg-bg-active transition-colors whitespace-nowrap shrink-0"
              onClick={(e) => { e.stopPropagation(); handlePush(); }}
            >
              {uncommittedFiles.length > 0 ? "Commit & Push" : `Push (${unpushedCount})`}
            </button>
          </Tooltip>
        )}
      </div>

      <div className={`flex-1 overflow-y-auto min-h-0 ${collapsed ? "hidden" : ""}`}>
        {tab === "uncommitted" && (
          <FileList
            files={uncommittedFiles}
            loading={loadingUncommitted}
            emptyMessage="No uncommitted changes"
            worktreePath={worktree.path}
            activeFile={activeDiffMode === "uncommitted" ? activeDiffFile : undefined}
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
            activeFile={activeDiffMode === "pr" ? activeDiffFile : undefined}
            onFileClick={(f) => openDiffTab(worktree.id, f, worktree.path, "pr", baseBranch)}
          />
        )}
        {tab === "pr-status" && contentReady && (
          <PRPanel
            projectId={project.id}
            branch={worktree.branch}
            worktreePath={worktree.path}
            onCreatePR={() => {
              const prCreateSkill = project.pr_create_skill.trim();
              if (prCreateSkill) {
                if (useAgent) {
                  requestAgentTab(prCreateSkill, undefined, backend);
                } else if (looksLikeClaudeCliCommand(prCreateSkill, claudeCmd)) {
                  requestClaudeTab(prCreateSkill);
                } else {
                  sendToAgent(prCreateSkill);
                }
              } else {
                sendToAgent(
                  `Please look at the changes on this branch compared to the ${baseBranch} branch (the target branch). Push the branch to origin if needed, then create a well-written pull request targeting the ${baseBranch} branch, with a clear title and description summarizing the changes. Use: gh pr create --base ${baseBranch}`,
                  fastModel
                );
              }
            }}
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
              className="w-full px-3 py-2 text-left text-[length:var(--app-font-11)] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              onClick={() => {
                openDiffTab(worktree.id, contextMenu.file, worktree.path, "uncommitted");
                setContextMenu(null);
              }}
            >
              Open diff
            </button>
            <button
              className="w-full px-3 py-2 text-left text-[length:var(--app-font-11)] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              onClick={() => {
                void handleOpenInEditor(contextMenu.file);
                setContextMenu(null);
              }}
            >
              Open in editor
            </button>
            <button
              className="w-full px-3 py-2 text-left text-[length:var(--app-font-11)] text-text-secondary transition-colors hover:bg-bg-hover hover:text-error"
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

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button
      className={`px-2 py-0.5 text-[length:var(--app-font-11)] rounded transition-colors whitespace-nowrap truncate ${
        active ? "text-text-primary bg-bg-secondary" : "text-text-tertiary hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FileList({ files, loading, emptyMessage, worktreePath, activeFile, onFileClick, onFileContextMenu, onRevert, revertingFile }: {
  files: GitFileStatus[];
  loading: boolean;
  emptyMessage: string;
  worktreePath: string;
  activeFile?: string;
  onFileClick: (file: string) => void;
  onFileContextMenu?: (event: React.MouseEvent<HTMLDivElement>, file: string, status: string) => void;
  onRevert?: (file: string, status: string) => void;
  revertingFile?: string | null;
}) {
  if (loading && files.length === 0) return <div className="px-3 py-2 text-[length:var(--app-font-11)] text-text-tertiary">Loading...</div>;
  if (files.length === 0) return <div className="px-3 py-2 text-[length:var(--app-font-11)] text-text-tertiary">{emptyMessage}</div>;
  return (
    <div className="py-0.5">
      {files.map((f) => {
        const active = activeFile === f.file;
        return (
        <div
          key={f.file}
          role="button"
          tabIndex={0}
          className={`group w-full flex items-center gap-2 px-3 py-0.5 text-[length:var(--app-font-11)] transition-colors cursor-pointer outline-none ${
            active
              ? "bg-accent-muted text-accent-hover"
              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary focus:bg-bg-hover focus:text-text-primary"
          }`}
          onClick={() => onFileClick(f.file)}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onFileClick(f.file);
            }
          }}
          onContextMenu={onFileContextMenu ? (event) => onFileContextMenu(event, f.file, f.status) : undefined}
          title={buildTooltipPath(worktreePath, f.file)}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1 text-left">
            <StatusBadge status={f.status} />
            <FilePathLabel file={f.file} active={active} />
          </div>
          {onRevert && (
            <Tooltip text="Revert changes" side="top" align="right">
              <button
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 shrink-0 px-1 py-0.5 text-[length:var(--app-font-10)] text-text-tertiary hover:text-error transition-all"
                disabled={revertingFile === f.file}
                onClick={(e) => {
                  e.stopPropagation();
                  onRevert(f.file, f.status);
                }}
              >
                {revertingFile === f.file ? "..." : "\u21A9"}
              </button>
            </Tooltip>
          )}
        </div>
        );
      })}
    </div>
  );
}

function FilePathLabel({ file, active }: { file: string; active?: boolean }) {
  const { directory, fileName } = splitDisplayPath(file);

  return (
    <span className="flex min-w-0 items-baseline gap-1 font-mono">
      {directory && (
        <span className={`min-w-0 flex-1 truncate ${active ? "text-accent-hover/80" : "text-text-tertiary"}`} dir="rtl">
          {directory}/
        </span>
      )}
      <span className={`shrink-0 ${active ? "text-accent-hover" : "text-text-secondary group-hover:text-text-primary"}`}>{fileName}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = { M: "text-warning", A: "text-success", D: "text-error", R: "text-accent", "??": "text-text-tertiary" };
  return <span className={`${colors[status] ?? "text-text-tertiary"} font-mono w-4 text-center shrink-0`}>{status}</span>;
}
