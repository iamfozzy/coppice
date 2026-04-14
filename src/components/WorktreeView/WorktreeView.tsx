import { useEffect, useState } from "react";
import { useAppStore, type ClaudeStatus } from "../../stores/appStore";
import { useShallow } from "zustand/shallow";
import { DiffViewer } from "../DiffViewer/DiffViewer";
import * as commands from "../../lib/commands";

export function WorktreeView() {
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const activeTabByWorktree = useAppStore((s) => s.activeTabByWorktree);
  const addTab = useAppStore((s) => s.addTab);
  const closeTab = useAppStore((s) => s.closeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const newTerminalTab = useAppStore((s) => s.newTerminalTab);
  const newClaudeTab = useAppStore((s) => s.newClaudeTab);
  const setWorktreeTargetBranch = useAppStore((s) => s.setWorktreeTargetBranch);
  const pendingClaudeCommand = useAppStore((s) => s.pendingClaudeCommand);
  const consumeClaudeCommand = useAppStore((s) => s.consumeClaudeCommand);

  const appSettings = useAppStore((s) => s.appSettings);
  const prCommentsByProject = useAppStore((s) => s.prCommentsByProject);
  const project = projects.find((p) => p.id === selectedProjectId);
  const claudeCmd = project?.claude_command || appSettings?.claude_command || "claude";
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);

  const wtId = worktree?.id ?? "";
  const tabs = tabsByWorktree[wtId] ?? [];
  const activeTabId = activeTabByWorktree[wtId] ?? null;

  // Only subscribe to Claude statuses for tabs in the current worktree.
  // useShallow ensures re-render only when the picked values change.
  const claudeStatusByTab = useAppStore(
    useShallow((s) => {
      const result: Record<string, ClaudeStatus> = {};
      for (const t of tabs) {
        if (t.type !== "claude") continue;
        const st = s.claudeStatusByTab[t.id];
        if (st) result[t.id] = st;
      }
      return result;
    })
  );

  const [liveBranch, setLiveBranch] = useState<string | null>(null);
  const [lastBranchWtId, setLastBranchWtId] = useState<string | null>(null);

  if (wtId && wtId !== lastBranchWtId) {
    setLiveBranch(null);
    setLastBranchWtId(wtId);
  }

  const updateWorktreeBranch = useAppStore((s) => s.updateWorktreeBranch);

  // Poll the actual git branch every 3 seconds
  useEffect(() => {
    if (!worktree) return;
    let cancelled = false;
    const check = () => {
      commands.getCurrentBranch(worktree.path).then((branch) => {
        if (!cancelled) {
          setLiveBranch(branch);
          updateWorktreeBranch(worktree.id, branch);
        }
      }).catch(() => {});
    };
    check();
    const interval = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [worktree?.path, worktree?.id]);

  // Watch for pending Claude commands
  useEffect(() => {
    if (pendingClaudeCommand && worktree) {
      const cmd = consumeClaudeCommand();
      if (cmd) {
        addTab(worktree.id, "claude", worktree.path, cmd);
      }
    }
  }, [pendingClaudeCommand, worktree, consumeClaudeCommand, addTab]);

  // Auto-create a Claude tab if worktree has no Claude tabs, after a short delay
  const hasClaude = tabs.some((t) => t.type === "claude");
  useEffect(() => {
    if (!worktree || hasClaude) return;
    const timer = setTimeout(() => {
      // Re-check current store state in case a tab was added during the delay
      const currentTabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? [];
      if (!currentTabs.some((t) => t.type === "claude")) {
        addTab(worktree.id, "claude", worktree.path, claudeCmd);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [worktree?.id, hasClaude]);

  if (!worktree || !project) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-text-tertiary">
          <div className="text-4xl mb-4 opacity-20">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" className="mx-auto">
              <path d="M8 16h48v36a4 4 0 01-4 4H12a4 4 0 01-4-4V16z" stroke="currentColor" strokeWidth="2" />
              <path d="M8 16l8-8h32l8 8" stroke="currentColor" strokeWidth="2" />
              <path d="M24 32h16M32 24v16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <p className="text-sm">Select a worktree to get started</p>
          <p className="text-xs mt-1">or create one from the sidebar</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Worktree header — h-12 = 3rem */}
      <header className="flex items-center gap-3 px-4 h-12 border-b border-border-primary shrink-0">
        <h2 className="text-sm font-medium text-text-primary truncate">
          {project.name}
          <span className="text-text-tertiary mx-1.5">/</span>
          {worktree.name}
        </h2>
        <span className="text-xs text-text-tertiary font-mono">{liveBranch ?? worktree.branch}</span>
        <TargetBranchPicker
          projectId={project.id}
          currentTarget={worktree.target_branch || project.base_branch}
          onChange={(branch) => {
            const value = branch === project.base_branch ? null : branch;
            setWorktreeTargetBranch(worktree.id, project.id, value);
          }}
        />

        <div className="ml-auto flex items-center gap-1.5">
          <ActionButton title="Open in editor" icon="vscode" onClick={() => commands.openInEditor(worktree.path)} />
          <ActionButton title="Open terminal" icon="terminal" onClick={() => commands.openInTerminal(worktree.path)} />
          <ActionButton title="Open in Finder" icon="finder" onClick={() => commands.openInFinder(worktree.path)} tooltipAlign="right" />
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex h-10 shrink-0 bg-bg-secondary">
        <div className="flex flex-1 min-w-0 overflow-x-auto">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              label={tab.label}
              type={tab.type}
              active={tab.id === activeTabId}
              claudeStatus={tab.type === "claude" ? claudeStatusByTab[tab.id] ?? null : null}
              onClick={() => setActiveTab(wtId, tab.id)}
              onClose={() => closeTab(wtId, tab.id)}
            />
          ))}
        </div>
        <div className="flex shrink-0">
          <button
            className="flex items-center justify-center w-10 h-full text-text-tertiary hover:text-text-secondary hover:bg-bg-hover transition-colors outline-none"
            onClick={() => newTerminalTab(wtId)}
            title="New terminal (Ctrl+T)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 4l4 3-4 3M7 10h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="flex items-center justify-center w-10 h-full text-text-tertiary hover:text-accent hover:bg-bg-hover transition-colors outline-none"
            onClick={() => newClaudeTab(wtId)}
            title="New Claude session (Ctrl+Shift+T)"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="12" height="8" rx="2" />
              <line x1="8" y1="3" x2="8" y2="6" />
              <circle cx="8" cy="2.5" r="1.2" />
              <circle cx="5.5" cy="10" r="1" fill="currentColor" stroke="none" />
              <circle cx="10.5" cy="10" r="1" fill="currentColor" stroke="none" />
              <line x1="0.5" y1="9" x2="2" y2="9" />
              <line x1="14" y1="9" x2="15.5" y2="9" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content area — terminals rendered in App.tsx, diffs rendered here */}
      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-text-tertiary text-sm">No tabs open</p>
          </div>
        )}
        {(() => {
          const activeTab = tabs.find((t) => t.id === activeTabId);
          if (activeTab?.type === "diff" && activeTab.diffFile && activeTab.diffMode) {
            const fileComments = activeTab.diffMode === "pr" && selectedProjectId
              ? (prCommentsByProject[selectedProjectId] ?? []).filter(
                  (c) => c.path === activeTab.diffFile
                )
              : [];
            return (
              <div className="absolute inset-0 z-10">
                <DiffViewer
                  cwd={activeTab.cwd}
                  file={activeTab.diffFile}
                  mode={activeTab.diffMode}
                  baseBranch={activeTab.diffBaseBranch}
                  comments={fileComments}
                />
              </div>
            );
          }
          return null;
        })()}
      </div>
    </div>
  );
}

function Tab({
  label,
  type,
  active,
  claudeStatus,
  onClick,
  onClose,
}: {
  label: string;
  type: "terminal" | "claude" | "diff";
  active: boolean;
  claudeStatus: ClaudeStatus | null;
  onClick: () => void;
  onClose: () => void;
}) {
  const getDotColor = () => {
    if (type !== "claude") return type === "diff" ? "bg-warning" : "bg-text-tertiary";
    if (claudeStatus === "active") return "bg-accent";
    if (claudeStatus === "idle") return "bg-warning";
    return "bg-accent";
  };

  const dotColor = getDotColor();
  const isAnimated = type === "claude" && claudeStatus === "active";

  return (
    <div
      className={`flex items-center gap-2 px-3 text-xs cursor-pointer group relative select-none outline-none ${
        active
          ? "text-text-primary bg-bg-primary"
          : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50"
      }`}
      onClick={onClick}
      tabIndex={-1}
    >
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
      )}
      {isAnimated && active ? (
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
        </span>
      ) : (
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? dotColor : "bg-text-tertiary/40"}`} />
      )}
      <span className="truncate max-w-[140px]">{label}</span>
      <span
        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:bg-text-tertiary/20 transition-all shrink-0 -mr-1"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </span>
    </div>
  );
}

function ActionButton({
  title,
  icon,
  onClick,
  tooltipAlign,
}: {
  title: string;
  icon: string;
  onClick: () => void;
  tooltipAlign?: "right";
}) {
  const icons: Record<string, React.ReactNode> = {
    vscode: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M10 1l-6 5.5L10 12M4 6.5L1 4v6l3-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    terminal: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 4l4 3-4 3M7 10h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
    finder: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
        <path d="M2 6h10" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    ),
  };

  return (
    <div className="relative group/tip">
      <button
        className="w-7 h-7 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        onClick={onClick}
      >
        {icons[icon]}
      </button>
      <div className={`absolute top-full mt-1 px-2 py-1 text-[11px] text-text-primary bg-bg-tertiary border border-border-secondary rounded shadow-lg whitespace-nowrap opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50 ${
        tooltipAlign === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
      }`}>
        {title}
      </div>
    </div>
  );
}

function TargetBranchPicker({
  projectId,
  currentTarget,
  onChange,
}: {
  projectId: string;
  currentTarget: string;
  onChange: (branch: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentTarget);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<"success" | "error" | null>(null);

  const handleSync = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      await commands.updateBaseBranch(projectId, currentTarget);
      setSyncResult("success");
    } catch {
      setSyncResult("error");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 2000);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-text-tertiary">&rarr;</span>
        <input
          className="px-1.5 py-0.5 text-[11px] bg-bg-tertiary border border-accent rounded text-text-primary font-mono focus:outline-none w-24"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              onChange(value.trim());
              setEditing(false);
            } else if (e.key === "Escape") {
              setEditing(false);
              setValue(currentTarget);
            }
          }}
          onBlur={() => {
            if (value.trim() && value.trim() !== currentTarget) {
              onChange(value.trim());
            }
            setEditing(false);
          }}
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-0.5">
      <button
        className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
        onClick={() => {
          setValue(currentTarget);
          setEditing(true);
        }}
        title="Target branch for PR comparisons (click to change)"
      >
        <span>&rarr;</span>
        <span className="font-mono">{currentTarget}</span>
      </button>
      <button
        className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${
          syncResult === "success"
            ? "text-success"
            : syncResult === "error"
            ? "text-error"
            : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover"
        }`}
        onClick={handleSync}
        disabled={syncing}
        title={`Fetch ${currentTarget} from origin`}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 16 16"
          fill="none"
          className={syncing ? "animate-spin" : ""}
        >
          <path
            d="M14 8A6 6 0 1 1 8 2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M8 0l3 2-3 2"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}
