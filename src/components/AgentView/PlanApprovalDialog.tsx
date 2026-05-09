import { useMemo, useState, useRef, useEffect } from "react";
import type { AgentPendingPermission } from "../../lib/types";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
  pending: AgentPendingPermission;
  onApprove: (updatedInput: unknown) => void;
  onRequestChanges: (feedback: string) => void;
  onDeny: () => void;
  worktreePath?: string;
}

/**
 * Inline plan approval rendered inside the chat message list.
 * No nested scroll containers — the plan content flows naturally
 * and the parent MessageList handles all scrolling.
 */
export function PlanApprovalDialog({ pending, onApprove, onRequestChanges, onDeny, worktreePath }: Props) {
  const plan = useMemo(() => extractPlanDraft(pending), [pending]);
  const draftPlan = plan.planText;
  const [feedback, setFeedback] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // Auto-scroll this element into view when it first mounts
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, []);

  const handleApprove = () => {
    onApprove(plan.writeBack(draftPlan));
  };

  const handleRequestChanges = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    onRequestChanges(trimmed);
  };

  return (
    <div ref={rootRef} className="pr-8">
      <div className="rounded-lg border border-warning/25 bg-warning/4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 py-2 bg-warning/10 border-b border-warning/20">
          <div className="flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" className="text-warning">
              <path d="M7 1l6 12H1L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <line x1="7" y1="5.5" x2="7" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="7" cy="10.5" r="0.6" fill="currentColor" />
            </svg>
            <span className="text-[11px] font-semibold text-warning">Plan Approval Required</span>
          </div>
          <span className="text-[10px] font-mono text-text-tertiary">{pending.toolName}</span>
        </div>

        {/* Plan content — renders fully, no inner scroll */}
        <div className="px-3 py-3">
          {draftPlan.trim() ? (
            <MarkdownContent text={draftPlan} worktreePath={worktreePath} />
          ) : (
            <p className="text-[12px] text-text-tertiary">No plan text found in payload. See raw payload below.</p>
          )}
        </div>

        {/* Collapsible raw payload */}
        <details className="border-t border-warning/15">
          <summary className="px-3 py-1.5 text-[10px] text-text-tertiary cursor-pointer select-none uppercase tracking-wider hover:text-text-secondary transition-colors">
            Raw payload
          </summary>
          <pre className="px-3 py-2 border-t border-border-primary text-[11px] text-text-secondary whitespace-pre-wrap break-all leading-relaxed">
            {JSON.stringify(pending.toolInput, null, 2)}
          </pre>
        </details>

        {/* Actions */}
        <div className="px-3 py-3 border-t border-warning/15 space-y-2.5">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Request changes (optional)..."
            className="w-full min-h-[60px] resize-y rounded-md border border-border-primary bg-bg-tertiary px-2.5 py-2 text-[12px] text-text-primary leading-relaxed placeholder:text-text-tertiary"
          />
          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-accent hover:bg-accent-hover text-white transition-colors"
              onClick={handleApprove}
            >
              Approve Plan
            </button>
            <button
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-bg-tertiary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              onClick={handleRequestChanges}
              disabled={!feedback.trim()}
            >
              Request Changes
            </button>
            <button
              className="px-3 py-1.5 text-[11px] font-medium rounded-md bg-error/10 border border-error/30 text-error hover:bg-error/20 transition-colors"
              onClick={onDeny}
            >
              Deny
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function extractPlanDraft(pending: AgentPendingPermission): {
  planText: string;
  canEdit: boolean;
  writeBack: (nextPlanText: string) => unknown;
} {
  const source = pending.toolInput as Record<string, unknown>;
  const planText = findPlanText(source) || "";

  // Prefer writing back to a known key. Fall back to original payload untouched.
  if (typeof source.plan === "string") {
    return {
      planText,
      canEdit: true,
      writeBack: (nextPlanText) => ({ ...source, plan: nextPlanText }),
    };
  }
  if (typeof source.proposedPlan === "string") {
    return {
      planText,
      canEdit: true,
      writeBack: (nextPlanText) => ({ ...source, proposedPlan: nextPlanText }),
    };
  }
  if (typeof source.content === "string") {
    return {
      planText,
      canEdit: true,
      writeBack: (nextPlanText) => ({ ...source, content: nextPlanText }),
    };
  }

  return {
    planText,
    canEdit: false,
    writeBack: () => source,
  };
}

function findPlanText(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > 6000) return null;
    return trimmed;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlanText(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const preferredKeys = ["plan", "proposedPlan", "content", "markdown", "text", "proposal"];
    for (const key of preferredKeys) {
      const found = findPlanText(obj[key], depth + 1);
      if (found) return found;
    }
    for (const nested of Object.values(obj)) {
      const found = findPlanText(nested, depth + 1);
      if (found) return found;
    }
  }

  return null;
}

export function isPlanPermission(pending: AgentPendingPermission): boolean {
  const toolName = pending.toolName.toLowerCase();
  if (toolName.includes("plan")) return true;

  const payload = pending.toolInput as Record<string, unknown>;
  const keys = Object.keys(payload).map((k) => k.toLowerCase());
  if (keys.some((k) => k.includes("plan") || k.includes("proposal"))) return true;

  // Write tool targeting a plan file (e.g. /plans/implementation.md)
  if (pending.toolName === "Write" && typeof payload.file_path === "string") {
    const normalized = (payload.file_path as string).replace(/\\/g, "/").toLowerCase();
    if ((normalized.includes("/plans/") || normalized.includes("/plan")) && normalized.endsWith(".md")) {
      return true;
    }
  }

  return false;
}
