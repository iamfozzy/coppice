import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore, type RunnerStatus } from "../../stores/appStore";

export function SidebarRunners() {
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const runnersByWorktree = useAppStore((s) => s.runnersByWorktree);
  const openOrRestartRunner = useAppStore((s) => s.openOrRestartRunner);
  const toggleRunner = useAppStore((s) => s.toggleRunner);
  const closeRunner = useAppStore((s) => s.closeRunner);
  const setRunnerStatus = useAppStore((s) => s.setRunnerStatus);
  const pendingRunner = useAppStore((s) => s.pendingRunner);
  const consumeRunner = useAppStore((s) => s.consumeRunner);

  const project = projects.find((p) => p.id === selectedProjectId);
  const worktrees = selectedProjectId
    ? worktreesByProject[selectedProjectId] ?? []
    : [];
  const worktree = worktrees.find((w) => w.id === selectedWorktreeId);
  const wtId = worktree?.id ?? "";
  const currentRunners = runnersByWorktree[wtId] ?? {};

  // Listen for PTY exit events across ALL runners
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    for (const [wId, wRunners] of Object.entries(runnersByWorktree)) {
      for (const [key, runner] of Object.entries(wRunners)) {
        if (runner.status === "running") {
          const sid = runner.id;
          listen(`pty-exit-${sid}`, () => {
            setRunnerStatus(wId, key, "stopped");
          }).then((unlisten) => unlisteners.push(unlisten));
        }
      }
    }
    return () => { for (const fn of unlisteners) fn(); };
  }, [runnersByWorktree, setRunnerStatus]);

  // Watch for pending runner requests
  useEffect(() => {
    if (pendingRunner && worktree && project) {
      const r = consumeRunner();
      if (r) {
        const avail = getAvailable(project);
        const match = avail.find((a) => a.key === r.key);
        if (match) {
          openOrRestartRunner(wtId, r.key, match.command, worktree.path);
        }
      }
    }
  }, [pendingRunner, worktree?.id]);

  const availableRunners = worktree && project ? getAvailable(project) : [];

  if (availableRunners.length === 0) return null;

  return (
    <div className="border-t border-border-primary flex flex-col shrink-0">
      {availableRunners.map(({ key, label, command }) => {
        const runner = currentRunners[key];
        const isOpen = runner?.open ?? false;
        const status = runner?.status ?? "idle";

        return (
          <div key={key} className="border-b border-border-primary">
            {/* Header */}
            <div className="flex items-center justify-between px-3 h-7 bg-bg-tertiary">
              <button
                className="flex items-center gap-1.5 text-[11px] text-text-secondary hover:text-text-primary transition-colors"
                onClick={() => {
                  if (!runner) {
                    openOrRestartRunner(wtId, key, command, worktree!.path);
                  } else {
                    toggleRunner(wtId, key);
                  }
                }}
              >
                <svg
                  width="8"
                  height="8"
                  viewBox="0 0 8 8"
                  className={`shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`}
                >
                  <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
                </svg>
                {label}
                <StatusDot status={status} />
              </button>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => openOrRestartRunner(wtId, key, command, worktree!.path)}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-text-secondary hover:text-text-primary hover:bg-bg-active transition-colors"
                >
                  {runner ? `Restart ${label}` : `Run ${label}`}
                </button>
                {runner && status === "running" && (
                  <button
                    onClick={() => closeRunner(wtId, key)}
                    className="px-1.5 py-0.5 text-[10px] rounded bg-bg-hover text-error/70 hover:text-error hover:bg-bg-active transition-colors"
                  >
                    Stop
                  </button>
                )}
              </div>
            </div>

            {/* Slot — DOM reparenting moves the terminal node in/out */}
            <RunnerSlot
              runnerId={runner?.id ?? null}
              expanded={isOpen}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * An empty div that grabs the terminal DOM node from the hidden pool
 * and places it here when expanded. Returns it to the pool when collapsed
 * or when a different runner ID is shown.
 */
function RunnerSlot({ runnerId, expanded }: { runnerId: string | null; expanded: boolean }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const currentChildId = useRef<string | null>(null);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const pool = document.getElementById("runner-terminal-pool");
    if (!pool) return;

    // Return previous child to pool
    if (currentChildId.current && currentChildId.current !== runnerId) {
      const prev = document.getElementById(`runner-term-${currentChildId.current}`);
      if (prev && prev.parentElement === slot) {
        pool.appendChild(prev);
      }
      currentChildId.current = null;
    }

    // Move new child into slot
    if (runnerId && expanded) {
      const termNode = document.getElementById(`runner-term-${runnerId}`);
      if (termNode && termNode.parentElement !== slot) {
        slot.appendChild(termNode);
        currentChildId.current = runnerId;
      }
    }

    // If collapsed, return child to pool
    if (!expanded && currentChildId.current) {
      const child = document.getElementById(`runner-term-${currentChildId.current}`);
      if (child && child.parentElement === slot) {
        pool.appendChild(child);
      }
      currentChildId.current = null;
    }
  }, [runnerId, expanded]);

  // Cleanup: return child to pool on unmount
  useEffect(() => {
    return () => {
      const pool = document.getElementById("runner-terminal-pool");
      if (pool && currentChildId.current) {
        const child = document.getElementById(`runner-term-${currentChildId.current}`);
        if (child) {
          pool.appendChild(child);
        }
      }
    };
  }, []);

  return (
    <div
      ref={slotRef}
      style={{
        height: expanded && runnerId ? 150 : 0,
        overflow: "hidden",
        position: "relative",
      }}
    />
  );
}

function getAvailable(project: { setup_scripts: string[]; build_command: string; run_command: string }) {
  return [
    ...(project.setup_scripts.length > 0
      ? [{ key: "setup", label: "Setup", command: project.setup_scripts.join(" && ") }]
      : []),
    ...(project.build_command
      ? [{ key: "build", label: "Build", command: project.build_command }]
      : []),
    ...(project.run_command
      ? [{ key: "run", label: "Run", command: project.run_command }]
      : []),
  ];
}

function StatusDot({ status }: { status: RunnerStatus }) {
  if (status === "idle") return null;
  if (status === "running") {
    return (
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
      </span>
    );
  }
  return <span className="inline-flex rounded-full h-1.5 w-1.5 bg-text-tertiary" />;
}
