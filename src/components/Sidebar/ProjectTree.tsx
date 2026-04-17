import { useState, startTransition } from "react";
import { useAppStore, type ClaudeStatus } from "../../stores/appStore";
import { CreateWorktreeModal } from "./CreateWorktreeModal";
import { DeleteWorktreeModal } from "./DeleteWorktreeModal";
import type { Project, Worktree } from "../../lib/types";
import { useShallow } from "zustand/shallow";

export function ProjectTree() {
  const projects = useAppStore((s) => s.projects);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const selectProject = useAppStore((s) => s.selectProject);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const deleteWorktree = useAppStore((s) => s.deleteWorktree);
  const deletingWorktreeIds = useAppStore((s) => s.deletingWorktreeIds);
  const renameWorktree = useAppStore((s) => s.renameWorktree);
  const runnersByWorktree = useAppStore((s) => s.runnersByWorktree);
  // Derive per-worktree Claude status inside the selector so the component
  // only re-renders when a worktree's aggregate status actually changes,
  // not on every individual PTY output event.
  const claudeStatusByWorktree = useAppStore(
    useShallow((s) => {
      const result: Record<string, ClaudeStatus | null> = {};
      for (const [wtId, tabs] of Object.entries(s.tabsByWorktree)) {
        let hasActive = false;
        let hasIdle = false;
        for (const t of tabs) {
          if (t.type !== "claude" && t.type !== "agent") continue;
          const st = s.claudeStatusByTab[t.id];
          if (st === "active") { hasActive = true; break; }
          if (st === "idle") hasIdle = true;
        }
        if (hasActive) result[wtId] = "active";
        else if (hasIdle) result[wtId] = "idle";
        else result[wtId] = null;
      }
      return result;
    })
  );
  const [creatingWorktreeForProject, setCreatingWorktreeForProject] =
    useState<string | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = useState<{
    worktree: Worktree;
    projectId: string;
  } | null>(null);

  if (projects.length === 0) {
    return (
      <div className="px-3 py-8 text-center text-text-tertiary text-xs">
        No projects yet.
        <br />
        Click + to add one.
      </div>
    );
  }

  return (
    <div>
      {projects.map((project) => (
        <ProjectNode
          key={project.id}
          project={project}
          worktrees={worktreesByProject[project.id] ?? []}
          selectedWorktreeId={selectedWorktreeId}
          onSelectWorktree={(wt) => {
            startTransition(() => {
              selectProject(project.id);
              selectWorktree(wt.id);
            });
          }}
          deletingIds={deletingWorktreeIds}
          runnersByWorktree={runnersByWorktree}
          claudeStatusByWorktree={claudeStatusByWorktree}
          onDeleteWorktree={(wt) => {
            setWorktreeToDelete({ worktree: wt, projectId: project.id });
          }}
          onRenameWorktree={(wt, name) => {
            renameWorktree(wt.id, project.id, name);
          }}
          onEditProject={() => openProjectSettings(project.id)}
          onAddWorktree={() => setCreatingWorktreeForProject(project.id)}
        />
      ))}
      {creatingWorktreeForProject && (
        <CreateWorktreeModal
          projectId={creatingWorktreeForProject}
          onClose={() => setCreatingWorktreeForProject(null)}
        />
      )}
      {worktreeToDelete && (
        <DeleteWorktreeModal
          worktree={worktreeToDelete.worktree}
          onConfirm={() => {
            deleteWorktree(worktreeToDelete.worktree.id, worktreeToDelete.projectId);
            setWorktreeToDelete(null);
          }}
          onClose={() => setWorktreeToDelete(null)}
        />
      )}
    </div>
  );
}

function ProjectNode({
  project,
  worktrees,
  selectedWorktreeId,
  deletingIds,
  runnersByWorktree,
  claudeStatusByWorktree,
  onSelectWorktree,
  onDeleteWorktree,
  onRenameWorktree,
  onEditProject,
  onAddWorktree,
}: {
  project: Project;
  worktrees: Worktree[];
  selectedWorktreeId: string | null;
  deletingIds: Set<string>;
  runnersByWorktree: Record<string, Record<string, import("../../stores/appStore").RunnerInfo>>;
  claudeStatusByWorktree: Record<string, ClaudeStatus | null>;
  onSelectWorktree: (wt: Worktree) => void;
  onDeleteWorktree: (wt: Worktree) => void;
  onRenameWorktree: (wt: Worktree, name: string) => void;
  onEditProject: () => void;
  onAddWorktree: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  return (
    <div>
      {/* Project header */}
      <button
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors group"
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => {
          e.preventDefault();
          onEditProject();
        }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
        <span className="truncate flex-1">{project.name}</span>
        <span className="flex items-center gap-0.5">
          <span
            className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onAddWorktree();
            }}
            title="Add worktree"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
          <span
            className="w-5 h-5 flex items-center justify-center rounded text-text-tertiary hover:text-text-primary hover:bg-bg-active transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onEditProject();
            }}
            title="Project settings"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="2" cy="6" r="1" fill="currentColor" />
              <circle cx="6" cy="6" r="1" fill="currentColor" />
              <circle cx="10" cy="6" r="1" fill="currentColor" />
            </svg>
          </span>
        </span>
      </button>

      {/* Worktree list */}
      {expanded && (
        <div>
          {worktrees.length === 0 ? (
            <div className="pl-8 pr-3 py-1 text-[11px] text-text-tertiary">
              No worktrees
            </div>
          ) : (
            worktrees.map((wt) => {
              const isDeleting = deletingIds.has(wt.id);
              const hasRunningRunner = runnersByWorktree[wt.id]?.["run"]?.status === "running";
              const claudeStatus = claudeStatusByWorktree[wt.id] ?? null;
              const isSelected = selectedWorktreeId === wt.id;
              return (
              <div
                key={wt.id}
                className={`flex items-center gap-2 pl-7 pr-3 py-1.5 text-xs transition-colors group/wt ${
                  isDeleting
                    ? "opacity-40 pointer-events-none"
                    : isSelected
                      ? "bg-accent-muted text-accent-hover cursor-pointer"
                      : "text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                }`}
                onClick={() => !isDeleting && onSelectWorktree(wt)}
                onDoubleClick={(e) => {
                  if (isDeleting) return;
                  e.stopPropagation();
                  setRenamingId(wt.id);
                  setRenameValue(wt.name);
                }}
              >
                <div className="flex flex-col flex-1 min-w-0 gap-0.5">
                  {isDeleting ? (
                    <span className="truncate italic text-text-tertiary">Deleting...</span>
                  ) : renamingId === wt.id ? (
                    <input
                      className="min-w-0 px-1 py-0 text-xs bg-bg-tertiary border border-accent rounded text-text-primary focus:outline-none font-mono"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && renameValue.trim()) {
                          onRenameWorktree(wt, renameValue.trim());
                          setRenamingId(null);
                        } else if (e.key === "Escape") {
                          setRenamingId(null);
                        }
                      }}
                      onBlur={() => {
                        if (renameValue.trim() && renameValue.trim() !== wt.name) {
                          onRenameWorktree(wt, renameValue.trim());
                        }
                        setRenamingId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      spellCheck={false}
                      autoComplete="off"
                    />
                  ) : (
                    <>
                      <span className="truncate">{wt.name}</span>
                      <span className={`truncate text-[10px] font-mono ${isSelected ? "text-accent-hover/60" : "text-text-tertiary"}`}>
                        {wt.branch}
                        {wt.pr_number != null && (
                          <span className={isSelected ? "text-accent-hover/80" : "text-text-secondary"}> #{wt.pr_number}</span>
                        )}
                      </span>
                    </>
                  )}
                </div>
                {claudeStatus && !isDeleting && <ClaudeIndicator status={claudeStatus} />}
                {hasRunningRunner && !isDeleting && <RunningIndicator />}
                {!isDeleting && <span
                  className="opacity-0 group-hover/wt:opacity-100 text-text-tertiary hover:text-error transition-opacity shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteWorktree(wt);
                  }}
                  title="Delete worktree"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </span>}
              </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function ClaudeIndicator({ status }: { status: ClaudeStatus }) {
  if (status === "active") {
    return (
      <span className="shrink-0 relative flex h-2 w-2" title="Claude is working">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-50" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
      </span>
    );
  }
  return (
    <span className="shrink-0 relative flex h-2 w-2" title="Claude is waiting for input">
      <span className="relative inline-flex rounded-full h-2 w-2 bg-warning" />
    </span>
  );
}

function RunningIndicator() {
  return (
    <span className="shrink-0 relative flex h-2 w-2" title="Run command active">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-50" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
    </span>
  );
}

