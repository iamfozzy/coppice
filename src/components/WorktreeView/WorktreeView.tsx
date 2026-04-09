import { useEffect } from "react";
import { useState } from "react";
import { useAppStore } from "../../stores/appStore";
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
  const pendingClaudeCommand = useAppStore((s) => s.pendingClaudeCommand);
  const consumeClaudeCommand = useAppStore((s) => s.consumeClaudeCommand);

  const project = projects.find((p) => p.id === selectedProjectId);
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);

  const wtId = worktree?.id ?? "";
  const tabs = tabsByWorktree[wtId] ?? [];
  const activeTabId = activeTabByWorktree[wtId] ?? null;

  const [liveBranch, setLiveBranch] = useState<string | null>(null);
  const [lastBranchWtId, setLastBranchWtId] = useState<string | null>(null);

  if (wtId && wtId !== lastBranchWtId) {
    setLiveBranch(null);
    setLastBranchWtId(wtId);
  }

  // Poll the actual git branch every 3 seconds
  useEffect(() => {
    if (!worktree) return;
    let cancelled = false;
    const check = () => {
      commands.getCurrentBranch(worktree.path).then((branch) => {
        if (!cancelled) setLiveBranch(branch);
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

        <div className="ml-auto flex items-center gap-1.5">
          <ActionButton title="New Claude session" icon="claude" onClick={() => addTab(wtId, "claude", worktree.path, "claude")} />
          <ActionButton title="Open in VS Code" icon="vscode" onClick={() => commands.openInVscode(worktree.path)} />
          <ActionButton title="Open terminal" icon="terminal" onClick={() => commands.openInTerminal(worktree.path)} />
          <ActionButton title="Open in Finder" icon="finder" onClick={() => commands.openInFinder(worktree.path)} />
        </div>
      </header>

      {/* Tab bar — h-9 = 2.25rem */}
      <div className="flex items-center gap-0 px-2 h-9 border-b border-border-primary shrink-0 bg-bg-secondary">
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            label={tab.label}
            type={tab.type}
            active={tab.id === activeTabId}
            onClick={() => setActiveTab(wtId, tab.id)}
            onClose={() => closeTab(wtId, tab.id)}
          />
        ))}
        <div className="flex items-center gap-0.5 ml-1">
          <button
            className="px-1.5 py-0.5 text-text-tertiary hover:text-text-secondary text-xs rounded hover:bg-bg-hover transition-colors"
            onClick={() => addTab(wtId, "terminal", worktree.path)}
            title="New terminal"
          >
            + Term
          </button>
          <button
            className="px-1.5 py-0.5 text-text-tertiary hover:text-text-secondary text-xs rounded hover:bg-bg-hover transition-colors"
            onClick={() => addTab(wtId, "claude", worktree.path, "claude")}
            title="New Claude session"
          >
            + Claude
          </button>
        </div>
      </div>

      {/* Content area — terminals are rendered in App.tsx terminal-layer */}
      <div className="flex-1 min-h-0 relative">
        {tabs.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-text-tertiary text-sm">No tabs open</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({
  label,
  type,
  active,
  onClick,
  onClose,
}: {
  label: string;
  type: "terminal" | "claude";
  active: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <button
      className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-t transition-colors group ${
        active
          ? "bg-bg-primary text-text-primary border-t border-x border-border-primary -mb-px"
          : "text-text-tertiary hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          type === "claude" ? "bg-accent" : "bg-text-tertiary"
        }`}
      />
      {label}
      <span
        className="opacity-0 group-hover:opacity-100 ml-1 hover:text-error transition-opacity"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        x
      </span>
    </button>
  );
}

function ActionButton({
  title,
  icon,
  onClick,
}: {
  title: string;
  icon: string;
  onClick: () => void;
}) {
  const icons: Record<string, React.ReactNode> = {
    claude: (
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.2" />
        <path d="M5 7h4M7 5v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    ),
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
      <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 px-2 py-1 text-[11px] text-text-primary bg-bg-tertiary border border-border-secondary rounded shadow-lg whitespace-nowrap opacity-0 group-hover/tip:opacity-100 pointer-events-none transition-opacity z-50">
        {title}
      </div>
    </div>
  );
}
