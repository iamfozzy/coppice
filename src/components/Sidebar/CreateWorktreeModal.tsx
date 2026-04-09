import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";

interface Props {
  projectId: string;
  onClose: () => void;
}

type Mode = "existing" | "new";

export function CreateWorktreeModal({ projectId, onClose }: Props) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("existing");
  const [selectedBranch, setSelectedBranch] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [worktreeName, setWorktreeName] = useState("");
  const [filter, setFilter] = useState("");
  const createWorktree = useAppStore((s) => s.createWorktree);

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

  const filteredBranches = branches.filter((b) =>
    b.toLowerCase().includes(filter.toLowerCase())
  );

  const handleSelectBranch = (branch: string) => {
    setSelectedBranch(branch);
    if (mode === "existing") {
      const name = branch.replace(/^origin\//, "").replace(/\//g, "-");
      setWorktreeName(name);
    }
  };

  const triggerSetupIfNeeded = () => {
    setTimeout(() => {
      const store = useAppStore.getState();
      const proj = store.projects.find((p) => p.id === projectId);
      if (proj && proj.setup_scripts.length > 0) {
        store.requestRunner("setup");
      }
    }, 500);
  };

  const handleCreate = async () => {
    if (mode === "existing") {
      if (!selectedBranch || !worktreeName) return;
      setCreating(true);
      setError(null);
      try {
        await createWorktree(projectId, selectedBranch, worktreeName);
        triggerSetupIfNeeded();
        onClose();
      } catch (e) {
        setError(String(e));
        setCreating(false);
      }
    } else {
      if (!selectedBranch || !newBranchName || !worktreeName) return;
      setCreating(true);
      setError(null);
      try {
        await commands.createWorktreeNewBranch(
          projectId,
          selectedBranch,
          newBranchName,
          worktreeName
        );
        await useAppStore.getState().loadWorktrees(projectId);
        triggerSetupIfNeeded();
        onClose();
      } catch (e) {
        setError(String(e));
        setCreating(false);
      }
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
      <div className="bg-bg-secondary border border-border-primary rounded-lg w-[480px] max-h-[70vh] flex flex-col shadow-2xl">
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
                className={`w-full text-left px-5 py-1.5 text-xs transition-colors ${
                  selectedBranch === branch
                    ? "bg-accent-muted text-accent-hover"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
                onClick={() => handleSelectBranch(branch)}
              >
                <span className="font-mono">{branch}</span>
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
                      setWorktreeName(e.target.value.replace(/\//g, "-"));
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
                  onChange={(e) => setWorktreeName(e.target.value)}
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
              {creating ? "Creating..." : "Create Worktree"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
