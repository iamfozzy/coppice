import { startTransition } from "react";
import { useAppStore, type ClaudeStatus } from "../../stores/appStore";
import { SCRATCHPAD_WORKTREE_ID } from "../../lib/types";
import { useShallow } from "zustand/shallow";

export function ScratchpadNode() {
  const scratchpadWorktree = useAppStore((s) => s.scratchpadWorktree);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectScratchpad = useAppStore((s) => s.selectScratchpad);

  const tabCount = useAppStore((s) => {
    const tabs = s.tabsByWorktree[SCRATCHPAD_WORKTREE_ID];
    if (tabs) return tabs.length;
    return s.cachedTabCountByWorktree[SCRATCHPAD_WORKTREE_ID] ?? 0;
  });

  const claudeStatus = useAppStore(
    useShallow((s) => {
      const tabs = s.tabsByWorktree[SCRATCHPAD_WORKTREE_ID] ?? [];
      let hasActive = false;
      let hasIdle = false;
      for (const t of tabs) {
        if (t.type !== "claude" && t.type !== "agent") continue;
        const st = s.claudeStatusByTab[t.id];
        if (st === "active") { hasActive = true; break; }
        if (st === "idle") hasIdle = true;
      }
      if (hasActive) return "active" as ClaudeStatus;
      if (hasIdle) return "idle" as ClaudeStatus;
      return null;
    })
  );

  if (!scratchpadWorktree) return null;

  const isSelected = selectedWorktreeId === SCRATCHPAD_WORKTREE_ID;

  return (
    <>
      <div
        className={`flex items-center gap-2 px-3 py-1.5 text-[length:var(--app-font-11)] cursor-pointer transition-colors ${
          isSelected
            ? "bg-accent-muted text-accent-hover"
            : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        }`}
        onClick={() => startTransition(() => selectScratchpad())}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-60">
          <rect x="2" y="1" width="12" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
        <span className="flex-1 min-w-0 truncate font-medium">Scratchpad</span>
        {tabCount >= 1 && (
          <span className="shrink-0 text-[length:var(--app-font-9)] leading-none text-text-tertiary" title={`${tabCount} tabs open`}>
            {tabCount}
          </span>
        )}
        {claudeStatus === "active" && (
          <span className="shrink-0 relative flex h-2 w-2" title="Agent is working">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
          </span>
        )}
        {claudeStatus === "idle" && (
          <span className="shrink-0 relative flex h-2 w-2" title="Agent is waiting for input">
            <span className="relative inline-flex rounded-full h-2 w-2 bg-warning" />
          </span>
        )}
      </div>
      <div className="border-b border-border-primary mx-3 my-1" />
    </>
  );
}
