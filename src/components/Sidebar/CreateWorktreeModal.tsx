import { useState, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";

interface Props {
  projectId: string;
  onClose: () => void;
}

type Mode = "existing" | "new";

// Strip characters that are illegal in Windows filenames so the worktree
// folder name is portable. Backend also validates, but sanitizing here
// avoids surprising "invalid name" errors on submit.
//   < > : " | ? * \  → replaced with `-`
//   /                → replaced with `-` (path separator)
//   control chars    → removed
//   trailing . or ␠  → trimmed
function sanitizeWorktreeName(input: string): string {
  return input
    .replace(/[<>:"|?*\\/]/g, "-")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[. ]+$/, "");
}

export function CreateWorktreeModal({ projectId, onClose }: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [progressMsg, setProgressMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("new");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeName, setWorktreeName] = useState("");
  const [filter, setFilter] = useState("");
  const createWorktree = useAppStore((s) => s.createWorktree);
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const baseBranch = project?.base_branch;
  const selectedBranchRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    commands
      .listBranches(projectId)
      .then((b) => {
        setBranches(b);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [projectId]);

  // Prefill base branch when switching to "new" mode
  useEffect(() => {
    if (mode !== "new" || loading || selectedBranch || !baseBranch) return;
    const match = branches.includes(baseBranch)
      ? baseBranch
      : branches.includes(`origin/${baseBranch}`)
        ? `origin/${baseBranch}`
        : null;
    if (match) setSelectedBranch(match);
  }, [mode, loading, branches, baseBranch, selectedBranch]);

  // The effective default branch in "new" mode — matches either the local or origin/ form
  const defaultBranch = useMemo(() => {
    if (mode !== "new" || !baseBranch) return null;
    if (branches.includes(baseBranch)) return baseBranch;
    if (branches.includes(`origin/${baseBranch}`)) return `origin/${baseBranch}`;
    return null;
  }, [mode, baseBranch, branches]);

  const filteredBranches = useMemo(() => {
    const matched = branches.filter((b) =>
      b.toLowerCase().includes(filter.toLowerCase())
    );
    // Hoist the default branch to the top so the prefilled selection is obvious
    if (defaultBranch && matched.includes(defaultBranch)) {
      return [defaultBranch, ...matched.filter((b) => b !== defaultBranch)];
    }
    return matched;
  }, [branches, filter, defaultBranch]);

  // Scroll the selected branch into view when the list updates or selection changes
  useEffect(() => {
    if (!selectedBranch || loading) return;
    selectedBranchRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedBranch, loading, filter, mode]);

  const handleSelectBranch = (branch: string) => {
    setSelectedBranch(branch);
    if (mode === "existing") {
      const name = sanitizeWorktreeName(branch.replace(/^origin\//, ""));
      setWorktreeName(name);
    }
  };

  const selectNewWorktreeAndSetup = () => {
    setTimeout(() => {
      const store = useAppStore.getState();
      // Find the new worktree by name
      const wts = store.worktreesByProject[projectId] ?? [];
      const newWt = wts.find((w) => w.name === worktreeName);
      if (newWt) {
        store.selectProject(projectId);
        store.selectWorktree(newWt.id);

        // Trigger setup after selecting
        setTimeout(() => {
          const proj = store.projects.find((p) => p.id === projectId);
          if (proj && proj.setup_scripts.length > 0) {
            store.requestRunner("setup");
          }
        }, 300);
      }
    }, 200);
  };

  const handleCreate = async () => {
    if (mode === "existing") {
      if (!selectedBranch || !worktreeName) return;
    } else {
      if (!selectedBranch || !newBranchName || !worktreeName) return;
    }

    setCreating(true);
    setError(null);
    setProgressMsg("Creating worktree...");

    const unlisten = await listen<{ step: number; total: number; file: string }>(
      "worktree-setup-progress",
      (e) => setProgressMsg(`Copying ${e.payload.file} (${e.payload.step}/${e.payload.total})`)
    );

    try {
      if (mode === "existing") {
        await createWorktree(projectId, selectedBranch, worktreeName);
      } else {
        await commands.updateBaseBranch(projectId, selectedBranch).catch(() => {});
        await commands.createWorktreeNewBranch(
          projectId,
          selectedBranch,
          newBranchName,
          worktreeName
        );
        await useAppStore.getState().loadWorktrees(projectId);
      }
      selectNewWorktreeAndSetup();
      onClose();
    } catch (e) {
      setError(String(e));
      setCreating(false);
    } finally {
      unlisten();
      setProgressMsg("");
    }
  };

  const canCreate =
    mode === "existing"
      ? !!selectedBranch && !!worktreeName
      : !!selectedBranch && !!newBranchName && !!worktreeName;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-bg-secondary border border-border-primary rounded-lg w-[480px] max-h-[70vh] flex flex-col shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === "Enter" && canCreate && !creating) {
            e.preventDefault();
            handleCreate();
          }
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary shrink-0">
          <h2 className="text-sm font-semibold text-text-primary">
            New Worktree
          </h2>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Mode toggle */}
        <div className="flex px-5 pt-3 pb-2 gap-1 shrink-0">
          <button
            className={`px-3 py-1 text-xs rounded transition-colors ${
              mode === "new"
                ? "bg-accent/20 text-accent"
                : "text-text-tertiary hover:text-text-secondary"
            }`}
            onClick={() => {
              setMode("new");
              setSelectedBranch("");
              setWorktreeName("");
              setNewBranchName("");
            }}
          >
            New branch
          </button>
          <button
            className={`px-3 py-1 text-xs rounded transition-colors ${
              mode === "existing"
                ? "bg-accent/20 text-accent"
                : "text-text-tertiary hover:text-text-secondary"
            }`}
            onClick={() => {
              setMode("existing");
              setSelectedBranch("");
              setWorktreeName("");
              setNewBranchName("");
            }}
          >
            Existing branch
          </button>
        </div>

        {/* Branch filter */}
        <div className="px-5 py-2 border-b border-border-primary shrink-0">
          <input
            type="text"
            placeholder={
              mode === "existing"
                ? "Filter branches..."
                : "Filter base branch..."
            }
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            className="w-full px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
          />
        </div>

        {/* Branch list */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="px-5 py-8 text-center text-text-tertiary text-xs">
              Loading branches...
            </div>
          ) : filteredBranches.length === 0 ? (
            <div className="px-5 py-8 text-center text-text-tertiary text-xs">
              No branches found
            </div>
          ) : (
            filteredBranches.map((branch) => (
              <button
                key={branch}
                ref={selectedBranch === branch ? selectedBranchRef : undefined}
                className={`w-full text-left px-5 py-1.5 text-xs transition-colors flex items-center justify-between gap-2 ${
                  selectedBranch === branch
                    ? "bg-accent-muted text-accent-hover"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
                onClick={() => handleSelectBranch(branch)}
              >
                <span className="font-mono truncate">{branch}</span>
                {branch === defaultBranch && (
                  <span className="text-[10px] uppercase tracking-wide text-text-tertiary shrink-0">
                    default
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {/* Bottom form */}
        <div className="px-5 py-4 border-t border-border-primary space-y-3 shrink-0">
          {selectedBranch && (
            <>
              {mode === "new" && (
                <div>
                  <label className="block text-xs text-text-secondary mb-1">
                    New branch name (from {selectedBranch})
                  </label>
                  <input
                    type="text"
                    value={newBranchName}
                    onChange={(e) => {
                      setNewBranchName(e.target.value);
                      setWorktreeName(sanitizeWorktreeName(e.target.value));
                    }}
                    placeholder="feature/my-feature"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    className="w-full px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                  />
                </div>
              )}
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Worktree folder name
                </label>
                <input
                  type="text"
                  value={worktreeName}
                  onChange={(e) => setWorktreeName(sanitizeWorktreeName(e.target.value))}
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="w-full px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
                />
              </div>
            </>
          )}

          {error && <p className="text-xs text-error">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !canCreate}
              className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded transition-colors"
            >
              {creating ? (progressMsg || "Creating...") : "Create Worktree"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
