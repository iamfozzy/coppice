import { useState, useCallback, useEffect, useRef, memo } from "react";
import * as commands from "../../lib/commands";
import type { PrStatusResult, PrComment } from "../../lib/commands";
import { cacheGet, cacheGetStale, cacheSet } from "../../lib/cache";
import { useAppStore } from "../../stores/appStore";

interface Props {
  projectId: string;
  branch: string;
  worktreePath: string;
  onFixWithClaude: (context: string | { prNumber: number; failedChecks: string[] }) => void;
  onOpenFile?: (file: string) => void;
}

export const PRPanel = memo(function PRPanel({ projectId, branch, worktreePath, onFixWithClaude, onOpenFile }: Props) {
  const cacheKey = `pr-${projectId}-${worktreePath}`;
  const commentsCacheKey = `pr-comments-${projectId}-${worktreePath}`;
  const setPrComments = useAppStore((s) => s.setPrComments);

  const [prStatus, setPrStatus] = useState<PrStatusResult | null>(null);
  const [comments, setComments] = useState<PrComment[]>([]);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedComments, setSelectedComments] = useState<Set<number>>(new Set());

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
          setPrComments(projectId, c);
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

  // Keep selection in sync — remove IDs that no longer exist or became resolved
  useEffect(() => {
    setSelectedComments((prev) => {
      const unresolvedIds = new Set(comments.filter((c) => !c.is_resolved).map((c) => c.id));
      const filtered = new Set([...prev].filter((id) => unresolvedIds.has(id)));
      if (filtered.size === prev.size) return prev;
      return filtered;
    });
  }, [comments]);

  const unresolvedComments = comments.filter((c) => !c.is_resolved);

  const toggleComment = useCallback((id: number) => {
    setSelectedComments((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllUnresolved = useCallback(() => {
    setSelectedComments(new Set(unresolvedComments.map((c) => c.id)));
  }, [unresolvedComments]);

  const handleResolve = useCallback(async (threadId: string, resolve: boolean) => {
    // Optimistic update
    setComments((prev) => {
      const updated = prev.map((c) =>
        c.thread_id === threadId ? { ...c, is_resolved: resolve } : c
      );
      setPrComments(projectId, updated);
      return updated;
    });

    try {
      await commands.resolvePrComment(projectId, threadId, resolve);
    } catch (e) {
      // Revert on failure
      setComments((prev) => {
        const reverted = prev.map((c) =>
          c.thread_id === threadId ? { ...c, is_resolved: !resolve } : c
        );
        setPrComments(projectId, reverted);
        return reverted;
      });
    }
  }, [projectId, setPrComments]);

  const handleFixSelected = useCallback(() => {
    const selected = comments.filter((c) => selectedComments.has(c.id));
    if (selected.length === 0) return;
    const parts = selected.map((c, i) => {
      const loc = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : "";
      return `${i + 1}. Comment by ${c.author}${loc}:\n${c.body}`;
    });
    const context = `Please address the following ${selected.length} PR review comment${selected.length > 1 ? "s" : ""}:\n\n${parts.join("\n\n")}`;
    onFixWithClaude(context);
    setSelectedComments(new Set());
  }, [comments, selectedComments, onFixWithClaude]);

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

  const handleFixWithClaude = () => {
    if (!prStatus?.pr) return;
    const failedChecks = checks
      .filter((c) => (c.conclusion ?? c.status) === "FAILURE")
      .map((c) => c.name);
    onFixWithClaude({ prNumber: prStatus.pr.number, failedChecks });
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

          {/* Merge conflict warning */}
          {pr.mergeable === "CONFLICTING" && (
            <div className="flex items-center gap-2 px-2 py-1.5 bg-error/10 rounded border border-error/20">
              <svg width="12" height="12" viewBox="0 0 12 12" className="text-error shrink-0">
                <path d="M6 1L1 10h10L6 1z" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinejoin="round" />
                <path d="M6 5v2M6 8.5v.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span className="text-[11px] text-error flex-1">Merge conflicts</span>
              <button
                onClick={() => onFixWithClaude(
                  `This PR (#${pr.number}) has merge conflicts with the base branch. Please merge the base branch into the current branch and resolve any conflicts.\n\nRun: git merge origin/HEAD\n\nThen resolve any conflicts, stage the files, and commit.`
                )}
                className="px-2 py-0.5 text-[10px] font-medium bg-error/20 text-error hover:bg-error/30 rounded transition-colors"
              >
                Resolve with Claude
              </button>
            </div>
          )}

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
              <div className="flex items-center gap-2 text-[10px] text-text-tertiary font-medium">
                <span>Comments ({comments.length})</span>
                {selectedComments.size > 0 ? (
                  <>
                    <button
                      onClick={() => setSelectedComments(new Set())}
                      className="ml-auto text-text-tertiary hover:text-text-secondary transition-colors"
                    >
                      Deselect
                    </button>
                    <button
                      onClick={handleFixSelected}
                      className="px-2 py-0.5 font-medium bg-accent/20 text-accent hover:bg-accent/30 rounded transition-colors"
                    >
                      Fix {selectedComments.size} with Claude
                    </button>
                  </>
                ) : unresolvedComments.length > 1 ? (
                  <button
                    onClick={selectAllUnresolved}
                    className="ml-auto text-text-tertiary hover:text-text-secondary transition-colors"
                  >
                    Select all
                  </button>
                ) : null}
              </div>
              {comments.map((c) => (
                <CommentCard
                  key={c.id}
                  comment={c}
                  selected={selectedComments.has(c.id)}
                  onToggle={() => toggleComment(c.id)}
                  onFixWithClaude={() => {
                    const context = c.path
                      ? `PR review comment by ${c.author} on ${c.path}${c.line ? `:${c.line}` : ""}:\n\n${c.body}`
                      : `PR comment by ${c.author}:\n\n${c.body}`;
                    onFixWithClaude(context);
                  }}
                  onResolve={c.thread_id ? (resolve) => handleResolve(c.thread_id!, resolve) : undefined}
                  onOpenFile={c.path && onOpenFile ? () => onOpenFile(c.path!) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-text-tertiary">No PR found</span>
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

function CommentCard({
  comment,
  selected,
  onToggle,
  onFixWithClaude,
  onResolve,
  onOpenFile,
}: {
  comment: PrComment;
  selected: boolean;
  onToggle: () => void;
  onFixWithClaude: () => void;
  onResolve?: (resolve: boolean) => void;
  onOpenFile?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
  }, [comment.body]);

  return (
    <div className={`bg-bg-tertiary rounded px-2 py-1.5 space-y-1 ${comment.is_resolved ? "opacity-50" : ""}`}>
      <div className="flex items-center gap-1.5 text-[10px]">
        {comment.is_resolved ? (
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-success shrink-0">
            <path d="M2 5l2.5 2.5L8 3" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <button
            onClick={onToggle}
            className={`w-3.5 h-3.5 shrink-0 rounded-[3px] border flex items-center justify-center cursor-pointer transition-colors ${
              selected
                ? "bg-accent border-accent"
                : "border-border-secondary bg-transparent hover:border-text-tertiary"
            }`}
          >
            {selected && (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path d="M1.5 4L3.25 5.75L6.5 2.25" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        <span className="text-text-primary font-medium">{comment.author}</span>
        {comment.path && (
          onOpenFile ? (
            <button
              onClick={onOpenFile}
              className="text-accent hover:text-accent-hover font-mono truncate transition-colors"
              title="Open in diff view"
            >
              {comment.path}{comment.line ? `:${comment.line}` : ""}
            </button>
          ) : (
            <span className="text-text-tertiary font-mono truncate">
              {comment.path}{comment.line ? `:${comment.line}` : ""}
            </span>
          )
        )}
        {comment.is_resolved && (
          <span className="text-success text-[9px] font-medium">Resolved</span>
        )}
        <a href={comment.url} target="_blank" rel="noopener" className="ml-auto text-text-tertiary hover:text-text-secondary shrink-0">
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
            <path d="M1 7L7 1M7 1H3M7 1v4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
        </a>
      </div>
      <div
        ref={bodyRef}
        className={`text-[11px] text-text-secondary whitespace-pre-wrap break-words ${expanded ? "" : "line-clamp-4"}`}
      >
        {comment.body}
      </div>
      <div className="flex items-center gap-2">
        {(isTruncated || expanded) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
        {!comment.is_resolved && (
          <button
            onClick={onFixWithClaude}
            className="text-[10px] text-accent hover:text-accent-hover transition-colors"
          >
            Fix with Claude
          </button>
        )}
        {onResolve && (
          <button
            onClick={() => onResolve(!comment.is_resolved)}
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors ml-auto"
          >
            {comment.is_resolved ? "Unresolve" : "Resolve"}
          </button>
        )}
      </div>
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
