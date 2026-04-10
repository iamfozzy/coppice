import { useState, useCallback, useEffect, useRef, memo } from "react";
import * as commands from "../../lib/commands";
import type { PrStatusResult, PrComment } from "../../lib/commands";
import { cacheGet, cacheGetStale, cacheSet } from "../../lib/cache";

interface Props {
  projectId: string;
  branch: string;
  worktreePath: string;
  onFixWithClaude: (context: string) => void;
  onCreatePrWithClaude?: () => void;
}

export const PRPanel = memo(function PRPanel({ projectId, branch, worktreePath, onFixWithClaude, onCreatePrWithClaude }: Props) {
  const cacheKey = `pr-${projectId}-${worktreePath}`;
  const commentsCacheKey = `pr-comments-${projectId}-${worktreePath}`;

  const [prStatus, setPrStatus] = useState<PrStatusResult | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // Single effect for everything — keyed on cacheKey so it restarts on worktree switch
  const generationRef = useRef(0);

  const refresh = useCallback(async (generation: number, force = false) => {
    try {
      let liveBranch = branch;
      try {
        liveBranch = await commands.getCurrentBranch(worktreePath);
      } catch { /* fall back */ }
      if (generationRef.current !== generation) return; // stale

      const ck = `pr-${projectId}-${worktreePath}`;
      const cck = `pr-comments-${projectId}-${worktreePath}`;

      // Use fresh cache if available (skip on manual refresh)
      if (!force) {
        const fresh = cacheGet<PrStatusResult>(ck, 15000);
        if (fresh) {
          setPrStatus(fresh);
          setChecked(true);
          return;
        }
      }

      const status = await commands.getPrForBranch(projectId, liveBranch);
      if (generationRef.current !== generation) return; // stale
      setPrStatus(status);
      cacheSet(ck, status);
      setChecked(true);

      if (status.pr) {
        try {
          const c = await commands.getPrComments(projectId, status.pr.number);
          if (generationRef.current !== generation) return;
          setComments(c);
          cacheSet(cck, c);
        } catch {
          if (generationRef.current === generation) setComments([]);
        }
      } else {
        if (generationRef.current === generation) setComments([]);
      }
    } catch (e) {
      if (generationRef.current === generation) {
        setError(String(e));
        setChecked(true);
      }
    }
  }, [projectId, branch, worktreePath]);

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh(generationRef.current, true);
    setRefreshing(false);
  }, [refresh]);

  // On worktree change: restore cache, bump generation, schedule refresh
  useEffect(() => {
    const gen = ++generationRef.current;

    // Restore from cache immediately
    const cached = cacheGetStale<PrStatusResult>(cacheKey);
    const cachedC = cacheGetStale<PrComment[]>(commentsCacheKey);
    setPrStatus(cached);
    setComments(cachedC ?? []);
    setChecked(cached !== null);
    setError(null);

    // Refresh after delay, then poll
    const timer = setTimeout(() => refresh(gen), 800);
    const interval = setInterval(() => refresh(gen), 30000);
    return () => { clearTimeout(timer); clearInterval(interval); };
  }, [cacheKey, commentsCacheKey, refresh]);

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
      <div className="px-3 py-2">
        <p className="text-[11px] text-text-tertiary">
          Could not fetch PR info (is <code className="text-text-secondary">gh</code> installed?)
        </p>
      </div>
    );
  }

  const pr = prStatus?.pr;
  const checks = prStatus?.checks ?? [];

  return (
    <div className="shrink-0">
      {pr ? (
        <div className="px-3 py-2 space-y-2">
          {/* PR header */}
          <div className="flex items-center gap-2">
            <PrStateBadge state={pr.state} draft={pr.draft} />
            <a
              href={pr.url}
              target="_blank"
              rel="noopener"
              className="text-[11px] text-accent hover:text-accent-hover truncate flex-1"
            >
              #{pr.number} {pr.title}
            </a>
            <button
              onClick={handleManualRefresh}
              className="text-text-tertiary hover:text-text-secondary transition-colors shrink-0"
              title="Refresh"
              disabled={refreshing}
            >
              <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className={refreshing ? "animate-spin" : ""}>
                <path d="M1 6a5 5 0 019-3M11 6a5 5 0 01-9 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {/* Check runs — vertical list */}
          {checks.length > 0 && (
            <div className="space-y-0.5">
              <div className="text-[10px] text-text-tertiary font-medium mb-1">Checks</div>
              {checks.map((check) => (
                <div key={check.name} className="flex items-center gap-1.5 text-[11px]">
                  <CheckStatusIcon status={check.conclusion ?? check.status} />
                  <span className="truncate flex-1 text-text-secondary">{check.name}</span>
                  {check.url && (
                    <a href={check.url} target="_blank" rel="noopener" className="text-text-tertiary hover:text-text-secondary text-[10px] shrink-0">
                      view
                    </a>
                  )}
                </div>
              ))}
              {checks.some((c) => (c.conclusion ?? c.status) === "FAILURE") && (
                <button
                  onClick={handleFixWithClaude}
                  className="mt-1 px-2 py-0.5 text-[10px] font-medium bg-accent/20 text-accent hover:bg-accent/30 rounded transition-colors"
                >
                  Fix with Claude
                </button>
              )}
            </div>
          )}

          {/* Comments */}
          {comments.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-text-tertiary font-medium">
                Comments ({comments.length})
              </div>
              {comments.map((c) => (
                <CommentCard
                  key={c.id}
                  comment={c}
                  onFixWithClaude={() => {
                    const context = c.path
                      ? `PR review comment by ${c.author} on ${c.path}${c.line ? `:${c.line}` : ""}:\n\n${c.body}`
                      : `PR comment by ${c.author}:\n\n${c.body}`;
                    onFixWithClaude(context);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-2">
          <div className="flex items-center gap-3">
            <button
              onClick={onCreatePrWithClaude}
              className="px-2 py-0.5 text-[11px] rounded bg-accent text-white hover:brightness-110 transition-all"
            >
              Create PR with Claude
            </button>
            <button
              onClick={handleManualRefresh}
              className="text-[11px] text-text-tertiary hover:text-text-secondary transition-colors flex items-center gap-1"
              disabled={refreshing}
            >
              {refreshing && (
                <svg className="animate-spin h-3 w-3" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" opacity="0.25" />
                  <path d="M6 1a5 5 0 014.33 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              )}
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

function CheckStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "SUCCESS":
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-success shrink-0">
          <circle cx="5" cy="5" r="4" fill="currentColor" opacity="0.2" />
          <path d="M3 5l1.5 1.5L7 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "FAILURE":
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-error shrink-0">
          <circle cx="5" cy="5" r="4" fill="currentColor" opacity="0.2" />
          <path d="M3.5 3.5l3 3M6.5 3.5l-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    case "PENDING":
    case "QUEUED":
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-text-tertiary shrink-0">
          <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.4" />
          <circle cx="5" cy="5" r="1.5" fill="currentColor" opacity="0.4" />
        </svg>
      );
    case "IN_PROGRESS":
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-warning shrink-0 animate-spin">
          <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.25" />
          <path d="M5 1a4 4 0 012.83 1.17" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-text-tertiary shrink-0">
          <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.3" />
        </svg>
      );
  }
}

function CommentCard({ comment, onFixWithClaude }: { comment: PrComment; onFixWithClaude: () => void }) {
  return (
    <div className="bg-bg-tertiary rounded px-2 py-1.5 space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <span className="text-text-primary font-medium">{comment.author}</span>
        {comment.path && (
          <span className="text-text-tertiary font-mono truncate">
            {comment.path}{comment.line ? `:${comment.line}` : ""}
          </span>
        )}
        <a href={comment.url} target="_blank" rel="noopener" className="ml-auto text-text-tertiary hover:text-text-secondary shrink-0">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1 7L7 1M7 1H3M7 1v4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </a>
      </div>
      <div className="text-[11px] text-text-secondary whitespace-pre-wrap break-words line-clamp-4">
        {comment.body}
      </div>
      <button
        onClick={onFixWithClaude}
        className="text-[10px] text-accent hover:text-accent-hover transition-colors"
      >
        Fix with Claude
      </button>
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
