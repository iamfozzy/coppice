import { useMemo, useState } from "react";
import type { AgentPendingPermission } from "../../lib/types";
import { MarkdownContent } from "./MessageBubble";

interface Props {
  pending: AgentPendingPermission;
  onApprove: (updatedInput: unknown) => void;
  onRequestChanges: (feedback: string) => void;
  onDeny: () => void;
}

/**
 * Detects plan-like permission payloads and gives users an editable + readable
 * review experience before approving the tool action.
 */
export function PlanApprovalDialog({ pending, onApprove, onRequestChanges, onDeny }: Props) {
  const plan = useMemo(() => extractPlanDraft(pending), [pending]);
  const [draftPlan, setDraftPlan] = useState(plan.planText);
  const canEdit = plan.canEdit;
  const [feedback, setFeedback] = useState("");

  const handleApprove = () => {
    onApprove(plan.writeBack(draftPlan));
  };

  const handleRequestChanges = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    onRequestChanges(trimmed);
  };

  return (
    <div className="mx-4 mb-2 border border-warning/25 bg-warning/4 rounded-lg overflow-hidden flex flex-col max-h-[70vh] min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-warning/10 border-b border-warning/20 shrink-0">
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

      <div className="px-3 py-3 space-y-3 overflow-y-auto min-h-0">
        <div className="rounded-md border border-border-primary bg-bg-secondary/60">
          <div className="px-2.5 py-1.5 border-b border-border-primary text-[10px] uppercase tracking-wider text-text-tertiary">
            Preview
          </div>
          <div className="px-2.5 py-2 max-h-52 overflow-y-auto">
            {draftPlan.trim() ? (
              <MarkdownContent text={draftPlan} />
            ) : (
              <p className="text-[12px] text-text-tertiary">No plan text found in payload. Use JSON fallback below.</p>
            )}
          </div>
        </div>

        <div>
          <label className="block text-[11px] text-text-secondary mb-1">
            Editable plan{!canEdit && <span className="ml-1 text-text-tertiary">(read-only — unknown payload structure)</span>}
          </label>
          <textarea
            value={draftPlan}
            onChange={(e) => setDraftPlan(e.target.value)}
            readOnly={!canEdit}
            placeholder="Edit the plan before approving..."
            className={`w-full min-h-[130px] max-h-[240px] resize-y rounded-md border border-border-primary bg-bg-tertiary px-2.5 py-2 text-[12px] text-text-primary font-mono leading-relaxed${!canEdit ? " opacity-70 cursor-not-allowed" : ""}`}
          />
        </div>

        <details className="rounded-md border border-border-primary bg-bg-tertiary/40">
          <summary className="px-2.5 py-1.5 text-[10px] text-text-tertiary cursor-pointer select-none uppercase tracking-wider">
            Raw payload
          </summary>
          <pre className="px-2.5 py-2 border-t border-border-primary text-[11px] text-text-secondary max-h-40 overflow-auto whitespace-pre-wrap break-all leading-relaxed">
            {JSON.stringify(pending.toolInput, null, 2)}
          </pre>
        </details>

        <div>
          <label className="block text-[11px] text-text-secondary mb-1">Request changes (optional)</label>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Tell the agent what to change in the plan..."
            className="w-full min-h-[76px] resize-y rounded-md border border-border-primary bg-bg-tertiary px-2.5 py-2 text-[12px] text-text-primary leading-relaxed"
          />
        </div>

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
  return keys.some((k) => k.includes("plan") || k.includes("proposal"));
}
