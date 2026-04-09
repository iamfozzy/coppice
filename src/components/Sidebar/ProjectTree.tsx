import { useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { CreateWorktreeModal } from "./CreateWorktreeModal";
import type { Project, Worktree } from "../../lib/types";

export function ProjectTree() {
  const projects = useAppStore((s) => s.projects);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const selectProject = useAppStore((s) => s.selectProject);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const deleteWorktree = useAppStore((s) => s.deleteWorktree);
  const renameWorktree = useAppStore((s) => s.renameWorktree);
  const [creatingWorktreeForProject, setCreatingWorktreeForProject] =
    useState<string | null>(null);

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
            selectProject(project.id);
            selectWorktree(wt.id);
          }}
          onDeleteWorktree={(wt) => {
            deleteWorktree(wt.id, project.id);
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
    </div>
  );
}

function ProjectNode({
  project,
  worktrees,
  selectedWorktreeId,
  onSelectWorktree,
  onDeleteWorktree,
  onRenameWorktree,
  onEditProject,
  onAddWorktree,
}: {
  project: Project;
  worktrees: Worktree[];
  selectedWorktreeId: string | null;
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
        <span className="truncate">{project.name}</span>
        <span className="ml-auto flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <span
            className="text-text-tertiary hover:text-text-primary"
            onClick={(e) => {
              e.stopPropagation();
              onAddWorktree();
            }}
            title="Add worktree"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </span>
          <span
            className="text-text-tertiary hover:text-text-primary"
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
            worktrees.map((wt) => (
              <div
                key={wt.id}
                className={`flex items-center gap-2 pl-7 pr-3 py-1 text-xs transition-colors cursor-pointer group/wt ${
                  selectedWorktreeId === wt.id
                    ? "bg-accent-muted text-accent-hover"
                    : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                }`}
                onClick={() => onSelectWorktree(wt)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setRenamingId(wt.id);
                  setRenameValue(wt.name);
                }}
              >
                <WorktreeIcon status={wt.ci_status} />
                {renamingId === wt.id ? (
                  <input
                    className="flex-1 min-w-0 px-1 py-0 text-xs bg-bg-tertiary border border-accent rounded text-text-primary focus:outline-none font-mono"
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
                  <span className="truncate flex-1">{wt.name}</span>
                )}
                <span
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
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function WorktreeIcon({ status }: { status: Worktree["ci_status"] }) {
  const color =
    status === "success"
      ? "text-success"
      : status === "failure"
        ? "text-error"
        : status === "running"
          ? "text-warning"
          : "text-text-tertiary";

  return (
    <svg width="8" height="8" viewBox="0 0 8 8" className={`shrink-0 ${color}`}>
      <circle cx="4" cy="4" r="3" fill="currentColor" />
    </svg>
  );
}
