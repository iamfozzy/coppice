import { useEffect, useRef, useState } from "react";
import { useAppStore, type ClaudeStatus } from "../../stores/appStore";
import { DiffViewer } from "../DiffViewer/DiffViewer";
import { Tooltip } from "../ui/Tooltip";
import { useAgentTabCloseConfirmation } from "../ui/useAgentTabCloseConfirmation";
import * as commands from "../../lib/commands";
import { SCRATCHPAD_PROJECT_ID, SCRATCHPAD_WORKTREE_ID, type AppSettings } from "../../lib/types";
import { getDefaultSessionModeLabel, resolveDefaultSessionMode } from "../../lib/defaultSessionMode";
import { useWindowFocused } from "../../lib/windowFocus";

export function WorktreeView() {
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const appSettings = useAppStore((s) => s.appSettings);
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const activeTabByWorktree = useAppStore((s) => s.activeTabByWorktree);
  const addTab = useAppStore((s) => s.addTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const newTerminalTab = useAppStore((s) => s.newTerminalTab);
  const newClaudeTab = useAppStore((s) => s.newClaudeTab);
  const newAgentTab = useAppStore((s) => s.newAgentTab);
  const newDefaultSessionTab = useAppStore((s) => s.newDefaultSessionTab);
  const addAgentTab = useAppStore((s) => s.addAgentTab);
  const setWorktreeTargetBranch = useAppStore((s) => s.setWorktreeTargetBranch);
  const pendingClaudeCommand = useAppStore((s) => s.pendingClaudeCommand);
  const consumeClaudeCommand = useAppStore((s) => s.consumeClaudeCommand);
  const pendingAgentPrompt = useAppStore((s) => s.pendingAgentPrompt);
  const consumeAgentPrompt = useAppStore((s) => s.consumeAgentPrompt);
  const renameTab = useAppStore((s) => s.renameTab);

  const prCommentsByProject = useAppStore((s) => s.prCommentsByProject);
  const scratchpadProject = useAppStore((s) => s.scratchpadProject);
  const project = projects.find((p) => p.id === selectedProjectId)
    ?? (selectedProjectId === SCRATCHPAD_PROJECT_ID ? scratchpadProject : null);
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);
  const isScratchpad = selectedWorktreeId === SCRATCHPAD_WORKTREE_ID;

  const wtId = worktree?.id ?? "";
  const tabs = tabsByWorktree[wtId] ?? [];
  const activeTabId = activeTabByWorktree[wtId] ?? null;

  // Only subscribe to Claude statuses for tabs in the current worktree.
  // useShallow ensures re-render only when the picked values change.
  const claudeStatusByTab = useAppStore((s) => s.claudeStatusByTab);
  const terminalProgressByTab = useAppStore((s) => s.terminalProgressByTab);

  const [liveBranch, setLiveBranch] = useState<string | null>(null);
  const [lastBranchWtId, setLastBranchWtId] = useState<string | null>(null);
  const { requestCloseTab, closeConfirmation } = useAgentTabCloseConfirmation();
  const windowFocused = useWindowFocused();

  if (wtId && wtId !== lastBranchWtId) {
    setLiveBranch(null);
    setLastBranchWtId(wtId);
  }

  const updateWorktreeBranch = useAppStore((s) => s.updateWorktreeBranch);

  // Poll the actual git branch every 3 seconds (skip for scratchpad).
  // Suspended while the window is unfocused — `git` spawns are not free, and
  // the user can't see the branch label change anyway. On focus regain the
  // effect re-runs and triggers an immediate check.
  useEffect(() => {
    if (!worktree || isScratchpad) return;
    if (!windowFocused) return;
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
  }, [worktree?.path, worktree?.id, windowFocused]);

  // Watch for pending Claude commands
  useEffect(() => {
    if (pendingClaudeCommand && worktree) {
      const cmd = consumeClaudeCommand();
      if (cmd) {
        addTab(worktree.id, "claude", worktree.path, cmd);
      }
    }
  }, [pendingClaudeCommand, worktree, consumeClaudeCommand, addTab]);

  // Watch for pending Agent prompts
  useEffect(() => {
    if (pendingAgentPrompt && worktree) {
      const pending = consumeAgentPrompt();
      if (pending) {
        addAgentTab(worktree.id, worktree.path, pending.prompt, pending.model, pending.backend);
      }
    }
  }, [pendingAgentPrompt, worktree, consumeAgentPrompt, addAgentTab]);

  // Claude CLI tabs are no longer auto-created — the user decides when to open one.

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
        {isScratchpad ? (
          <h2 className="text-sm font-medium text-text-primary truncate">Scratchpad</h2>
        ) : (
          <>
            <h2 className="text-sm font-medium text-text-primary truncate">
              {project.name}
              <span className="text-text-tertiary mx-1.5">/</span>
              {worktree.name}
            </h2>
            <span className="text-xs text-text-tertiary font-mono">{liveBranch ?? worktree.branch}</span>
            <TargetBranchPicker
              projectId={project.id}
              currentTarget={worktree.target_branch || project.target_branch || project.base_branch}
              onChange={(branch) => {
                const defaultTarget = project.target_branch || project.base_branch;
                const value = branch === defaultTarget ? null : branch;
                setWorktreeTargetBranch(worktree.id, project.id, value);
              }}
            />
          </>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <ActionButton title="Open in editor" icon="vscode" onClick={() => {
            const activeTab = tabs.find((t) => t.id === activeTabId);
            if (activeTab?.type === "diff" && activeTab.diffFile) {
              commands.openWorktreeFileInEditor(worktree.path, activeTab.diffFile);
            } else {
              commands.openInEditor(worktree.path);
            }
          }} />
          <ActionButton title="Open terminal" icon="terminal" onClick={() => commands.openInTerminal(worktree.path)} />
          <ActionButton title="Open in Finder" icon="finder" onClick={() => commands.openInFinder(worktree.path)} tooltipAlign="right" />
        </div>
      </header>

      {/* Tab bar */}
      <div className="flex h-10 shrink-0 bg-bg-secondary">
        <NewTabButton
          defaultLabel={getDefaultNewTabLabel(appSettings)}
          onDefault={() => newDefaultSessionTab(wtId)}
          onClaudeCli={() => newClaudeTab(wtId)}
          onClaudeSdk={() => newAgentTab(wtId, "claude")}
          onPiAgent={() => newAgentTab(wtId, "pi")}
          onTerminal={() => newTerminalTab(wtId)}
        />
        <div className="flex flex-1 min-w-0 overflow-x-auto">
          {tabs.map((tab) => (
            <Tab
              key={tab.id}
              label={tab.label}
              type={tab.type}
              active={tab.id === activeTabId}
              claudeStatus={tab.type === "claude" || tab.type === "agent" ? claudeStatusByTab[tab.id] ?? null : null}
              progress={terminalProgressByTab[tab.id] ?? null}
              onClick={() => setActiveTab(wtId, tab.id)}
              onClose={(event) => requestCloseTab(wtId, tab.id, event)}
              onRename={(newLabel) => renameTab(wtId, tab.id, newLabel)}
            />
          ))}
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
                  key={activeTab.id}
                  cwd={activeTab.cwd}
                  file={activeTab.diffFile}
                  mode={activeTab.diffMode}
                  baseBranch={activeTab.diffMode === "pr" ? activeTab.diffBaseBranch : undefined}
                  comments={fileComments}
                />
              </div>
            );
          }
          return null;
        })()}
      </div>
      {closeConfirmation}
    </div>
  );
}

function getDefaultNewTabLabel(settings: AppSettings | null | undefined): string {
  return `New ${getDefaultSessionModeLabel(resolveDefaultSessionMode(settings))}`;
}

function NewTabButton({
  defaultLabel,
  onDefault,
  onClaudeCli,
  onClaudeSdk,
  onPiAgent,
  onTerminal,
}: {
  defaultLabel: string;
  onDefault: () => void;
  onClaudeCli: () => void;
  onClaudeSdk: () => void;
  onPiAgent: () => void;
  onTerminal: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const runAndClose = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <div className="relative flex h-full shrink-0" ref={ref} aria-label="Create new tab">
      <Tooltip text={`Default: ${defaultLabel}`} side="bottom" align="left">
        <button
          className="flex items-center justify-center w-10 h-full text-text-tertiary transition-colors outline-none hover:text-accent hover:bg-bg-hover"
          onClick={() => runAndClose(onDefault)}
          aria-label={`New tab (${defaultLabel})`}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M7 2.5v9M2.5 7h9" />
          </svg>
        </button>
      </Tooltip>
      <button
        className={`flex items-center justify-center w-6 h-full text-text-tertiary transition-colors outline-none hover:text-accent hover:bg-bg-hover ${open ? "text-accent bg-bg-hover" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label="Choose new tab type"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg className={`transition-transform ${open ? "rotate-180" : ""}`} width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-1 top-9 z-40 w-60 rounded-xl border border-border-primary bg-bg-secondary shadow-2xl shadow-black/30 ring-1 ring-white/5 p-1.5" role="menu">
          <NewTabMenuItem icon="claudeCli" label="New Claude CLI" hint="Run Claude Code in a terminal" onClick={() => runAndClose(onClaudeCli)} />
          <NewTabMenuItem icon="claudeSdk" label="New Claude SDK" hint="Agent tab using Claude SDK" onClick={() => runAndClose(onClaudeSdk)} />
          <NewTabMenuItem icon="pi" label="New Pi Agent" hint="Agent tab using Pi providers" onClick={() => runAndClose(onPiAgent)} />
          <div className="my-1.5 h-px bg-border-primary/80" />
          <NewTabMenuItem icon="terminal" label="New Terminal Tab" hint="Plain shell session" onClick={() => runAndClose(onTerminal)} />
        </div>
      )}
    </div>
  );
}

function NewTabMenuItem({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: "claudeCli" | "claudeSdk" | "pi" | "terminal";
  label: string;
  hint: string;
  onClick: () => void;
}) {
  const toneClass = icon === "pi"
    ? "text-purple-300 bg-purple-500/10 border-purple-400/20 group-hover:bg-purple-500/20"
    : icon === "claudeSdk"
    ? "text-orange-300 bg-orange-500/10 border-orange-400/20 group-hover:bg-orange-500/20"
    : icon === "claudeCli"
    ? "text-accent bg-accent/10 border-accent/20 group-hover:bg-accent/20"
    : "text-text-tertiary bg-bg-tertiary border-border-primary group-hover:text-text-secondary";

  return (
    <button
      type="button"
      className="group w-full flex items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-all hover:bg-bg-hover/80 hover:translate-x-0.5"
      onClick={onClick}
      role="menuitem"
    >
      <span className={`w-7 h-7 flex items-center justify-center rounded-lg border shrink-0 transition-colors ${toneClass}`}>
        <NewTabMenuIcon icon={icon} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-text-primary truncate">{label}</span>
        <span className="block text-[length:var(--app-font-10)] text-text-tertiary truncate">{hint}</span>
      </span>
      <svg className="opacity-0 -translate-x-1 text-text-tertiary transition-all group-hover:opacity-100 group-hover:translate-x-0" width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 2l3.5 3.5L4 9" />
      </svg>
    </button>
  );
}

function NewTabMenuIcon({ icon }: { icon: "claudeCli" | "claudeSdk" | "pi" | "terminal" }) {
  if (icon === "claudeSdk") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="10" height="8" rx="1.5" />
        <path d="M5.5 2.5h5" />
        <line x1="8" y1="2.5" x2="8" y2="5" />
        <circle cx="6" cy="9" r="1" fill="currentColor" stroke="none" />
        <circle cx="10" cy="9" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }

  if (icon === "pi") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1.5l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5 1.5-4z" />
        <path d="M12.5 1.5v2M11.5 2.5h2" />
      </svg>
    );
  }

  if (icon === "claudeCli") {
    return (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4l3 3-3 3" />
        <path d="M6.5 10h5" />
        <rect x="1" y="2" width="12" height="10" rx="1.5" opacity="0.45" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4l4 3-4 3M7 10h5" />
    </svg>
  );
}

function Tab({
  label,
  type,
  active,
  claudeStatus,
  progress,
  onClick,
  onClose,
  onRename,
}: {
  label: string;
  type: "terminal" | "claude" | "agent" | "diff";
  active: boolean;
  claudeStatus: ClaudeStatus | null;
  progress: number | null;
  onClick: () => void;
  onClose: (event: React.MouseEvent) => void;
  onRename: (newLabel: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label) {
      onRename(trimmed);
    } else {
      setEditValue(label);
    }
    setEditing(false);
  };

  const isAgentType = type === "agent" || type === "claude";
  const agentActive = isAgentType && claudeStatus === "active";
  const agentIdle = isAgentType && claudeStatus === "idle";

  // Build the status dot (rendered inside a fixed-size container).
  let dotInner: React.ReactNode;
  if (agentActive) {
    dotInner = (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
      </span>
    );
  } else if (agentIdle) {
    dotInner = <span className="w-2 h-2 rounded-full shrink-0 bg-warning" />;
  } else {
    const activeColor =
      type === "agent" || type === "claude" ? "bg-accent" : type === "diff" ? "bg-warning" : "bg-text-tertiary";
    dotInner = (
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${active ? activeColor : "bg-text-tertiary/40"}`}
      />
    );
  }

  return (
    <div
      className={`flex items-center gap-2 px-3 text-xs cursor-pointer group relative select-none outline-none ${
        active
          ? "text-text-primary bg-bg-primary"
          : "text-text-tertiary hover:text-text-secondary hover:bg-bg-hover/50"
      }`}
      onClick={editing ? undefined : onClick}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(e);
        }
      }}
      tabIndex={-1}
    >
      {active && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
      )}
      {/* Fixed-width status dot container — 16×16 so the label never shifts */}
      <span className="w-4 h-4 flex items-center justify-center shrink-0">
        {dotInner}
      </span>
      {progress !== null && !editing && (
        <span className="absolute left-0 right-0 bottom-0 h-0.5 bg-accent/20 overflow-hidden">
          <span className="block h-full bg-accent transition-all" style={{ width: `${progress}%` }} />
        </span>
      )}
      {editing ? (
        <input
          ref={inputRef}
          className="bg-transparent border border-accent rounded px-1 text-xs text-text-primary outline-none max-w-[140px] w-full"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setEditValue(label);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span
          className="truncate max-w-[140px]"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setEditValue(label);
            setEditing(true);
            requestAnimationFrame(() => {
              inputRef.current?.focus();
              inputRef.current?.select();
            });
          }}
        >
          {label}
        </span>
      )}
      <span
        className="opacity-0 group-hover:opacity-100 w-5 h-5 flex items-center justify-center rounded hover:bg-text-tertiary/20 transition-all shrink-0 -mr-1"
        onClick={(e) => {
          e.stopPropagation();
          onClose(e);
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
    <Tooltip text={title} align={tooltipAlign === "right" ? "right" : "center"}>
      <button
        className="w-7 h-7 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        onClick={onClick}
      >
        {icons[icon]}
      </button>
    </Tooltip>
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
        <span className="text-[length:var(--app-font-10)] text-text-tertiary">&rarr;</span>
        <input
          className="px-1.5 py-0.5 text-[length:var(--app-font-11)] bg-bg-tertiary border border-accent rounded text-text-primary font-mono focus:outline-none w-24"
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
        className="flex items-center gap-1 text-[length:var(--app-font-10)] text-text-tertiary hover:text-text-secondary transition-colors"
        onClick={() => {
          setValue(currentTarget);
          setEditing(true);
        }}
        title="Target branch for PR comparisons (click to change)"
      >
        <span>&rarr;</span>
        <span className="font-mono">{currentTarget}</span>
      </button>
      <Tooltip text={`Fetch ${currentTarget} from origin`}>
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
      </Tooltip>
    </div>
  );
}
