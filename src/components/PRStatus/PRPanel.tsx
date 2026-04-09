import { useState, useCallback, useEffect } from "react";
import * as commands from "../../lib/commands";
import type { PrStatusResult } from "../../lib/commands";

interface Props {
  projectId: string;
  branch: string;
  worktreePath: string;
  onFixWithClaude: (context: string) => void;
  onCreatePrWithClaude?: () => void;
}

export function PRPanel({ projectId, branch, worktreePath, onFixWithClaude, onCreatePrWithClaude }: Props) {
  const [prStatus, setPrStatus] = useState<PrStatusResult | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // Always read the actual branch from git, not the stored one
      let liveBranch = branch;
      try {
        liveBranch = await commands.getCurrentBranch(worktreePath);
      } catch {
        // fall back to stored branch
      }
      const status = await commands.getPrForBranch(projectId, liveBranch);
      setPrStatus(status);
      setChecked(true);
    } catch (e) {
      setError(String(e));
      setChecked(true);
    }
  }, [projectId, branch, worktreePath]);

  // Auto-check in the background after a short delay — no blocking
  useEffect(() => {
    const timer = setTimeout(() => {
      refresh();
    }, 300);
    return () => clearTimeout(timer);
  }, [refresh]);

  const handleFixWithClaude = async () => {
    if (!prStatus?.pr) return;
    try {
      const logs = await commands.getFailedActionLogs(projectId, prStatus.pr.number);
      onFixWithClaude(logs);
    } catch (e) {
      onFixWithClaude(`Failed to fetch logs: ${e}`);
    }
  };

  if (!checked) {
    return (
      <div className="px-3 py-2 text-[11px] text-text-tertiary flex items-center gap-1.5">
        <svg className="animate-spin h-3 w-3" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
          <path d="M6 1a5 5 0 014.33 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        Checking PR...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 shrink-0">
        <p className="text-xs text-text-tertiary">
          Could not fetch PR info (is <code className="text-text-secondary">gh</code> installed?)
        </p>
      </div>
    );
  }

  const pr = prStatus?.pr;
  const checks = prStatus?.checks ?? [];
  const failedChecks = checks.filter(
    (c) => c.conclusion === "FAILURE" || c.status === "FAILURE"
  );
  const passingChecks = checks.filter(
    (c) => c.conclusion === "SUCCESS" || c.status === "SUCCESS"
  );
  const pendingChecks = checks.filter(
    (c) =>
      c.status === "PENDING" ||
      c.status === "IN_PROGRESS" ||
      c.status === "QUEUED"
  );

  return (
    <div className="shrink-0">
      {pr ? (
        <div className="px-4 py-3 space-y-3">
          {/* PR header */}
          <div className="flex items-center gap-2">
            <PrStateBadge state={pr.state} draft={pr.draft} />
            <a
              href={pr.url}
              target="_blank"
              rel="noopener"
              className="text-xs text-accent hover:text-accent-hover truncate"
            >
              #{pr.number} {pr.title}
            </a>
            <button
              onClick={refresh}
              className="ml-auto text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
              title="Refresh PR status"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path
                  d="M1 6a5 5 0 019-3M11 6a5 5 0 01-9 3"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Checks summary */}
          {checks.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-3 text-[11px]">
                {passingChecks.length > 0 && (
                  <span className="text-success">
                    {passingChecks.length} passed
                  </span>
                )}
                {failedChecks.length > 0 && (
                  <span className="text-error">
                    {failedChecks.length} failed
                  </span>
                )}
                {pendingChecks.length > 0 && (
                  <span className="text-warning">
                    {pendingChecks.length} pending
                  </span>
                )}
              </div>

              {failedChecks.length > 0 && (
                <div className="space-y-1">
                  {failedChecks.map((check) => (
                    <div
                      key={check.name}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-error shrink-0" />
                      <span className="text-text-secondary truncate">
                        {check.name}
                      </span>
                      {check.url && (
                        <a
                          href={check.url}
                          target="_blank"
                          rel="noopener"
                          className="text-text-tertiary hover:text-text-secondary text-[10px] shrink-0"
                        >
                          view
                        </a>
                      )}
                    </div>
                  ))}
                  <button
                    onClick={handleFixWithClaude}
                    className="mt-1.5 px-3 py-1 text-xs font-medium bg-accent/20 text-accent hover:bg-accent/30 rounded transition-colors"
                  >
                    Fix with Claude
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="px-4 py-3">
          <div className="flex items-center gap-3">
            <button
              onClick={onCreatePrWithClaude}
              className="text-xs text-accent hover:text-accent-hover transition-colors"
            >
              Create PR with Claude
            </button>
            <button
              onClick={refresh}
              className="text-xs text-text-tertiary hover:text-text-secondary transition-colors"
            >
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PrStateBadge({ state, draft }: { state: string; draft: boolean }) {
  if (draft) {
    return (
      <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-text-tertiary/20 text-text-tertiary">
        Draft
      </span>
    );
  }
  const colors: Record<string, string> = {
    OPEN: "bg-success/20 text-success",
    MERGED: "bg-accent/20 text-accent",
    CLOSED: "bg-error/20 text-error",
  };
  return (
    <span
      className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${colors[state] ?? "bg-text-tertiary/20 text-text-tertiary"}`}
    >
      {state}
    </span>
  );
}

