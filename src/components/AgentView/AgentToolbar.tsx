import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentCost, AgentSessionState } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";
import { AnimatedRobotIcon, AnimatedToolIcon, useRotatingThinkingPhrase } from "./AgentStatusIcons";

interface Props {
  session: AgentSessionState;
  onInterrupt: () => void;
}

/** Resolve the effective context window size for a given model + extended-context flag.
 *  - Opus 4.6, Opus 4.7, Sonnet 4.6: 1M by default (no beta header required)
 *  - Haiku 4.5 and anything else recognized: 200k
 *  - Older Opus/Sonnet versions still gated behind the 1M beta are treated as
 *    200k unless extendedContext is explicitly enabled. */
function contextWindowFor(model: string, extendedContext: boolean): number {
  const m = model.toLowerCase();
  const has1MByDefault =
    m.includes("opus-4-6") ||
    m.includes("opus-4-7") ||
    m.includes("sonnet-4-6");
  if (has1MByDefault) return 1_000_000;
  // Legacy fallback: other 4.x models could opt into 1M via beta.
  const supportsBeta = m.includes("opus-4") || m.includes("sonnet-4");
  if (supportsBeta && extendedContext) return 1_000_000;
  return 200_000;
}

export function AgentToolbar({
  session,
  onInterrupt,
}: Props) {
  const hasApiKey = useAppStore((s) => !!s.appSettings?.agent_api_key);
  const isWorking = session.status === "thinking" || session.status === "tool_use";
  const waitingOnPlanApproval =
    session.status === "waiting_permission" &&
    !!session.pendingPermission &&
    session.pendingPermission.toolName.toLowerCase().includes("plan");
  const thinkingPhrase = useRotatingThinkingPhrase();

  // Only show the toolbar when there is something to display
  const hasCost = !!session.cost;
  const hasStatus = isWorking || session.status === "waiting_permission" || session.status === "done";
  if (!hasCost && !hasStatus) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 border-t border-border-primary bg-bg-secondary text-xs shrink-0">
      {/* Status indicator */}
      {isWorking && (
        <div className="flex items-center gap-1.5 text-accent">
          {session.status === "tool_use" ? (
            <AnimatedToolIcon size={12} />
          ) : (
            <AnimatedRobotIcon size={12} />
          )}
          <span className="text-[10px] font-medium">
            {session.status === "tool_use" ? "Running tool" : thinkingPhrase.replace(/\.{3}$/, "")}
          </span>
        </div>
      )}
      {session.status === "waiting_permission" && (
        <div className="flex items-center gap-1.5 text-warning">
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          <span className="text-[10px] font-medium">
            {waitingOnPlanApproval ? "Waiting for plan approval" : "Waiting for approval"}
          </span>
        </div>
      )}
      {session.status === "done" && (
        <div className="flex items-center gap-1.5 text-success">
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-[10px] font-medium">Done</span>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Cost display — "in" combines fresh input + cache reads + cache writes
          to reflect the actual context size the model processed. Detailed
          breakdown lives in the custom hover tooltip. */}
      {session.cost && (
        <CostDisplay
          cost={session.cost}
          lastTurnCost={session.lastTurnCost}
          hasApiKey={hasApiKey}
          model={session.model}
          extendedContext={session.extendedContext}
        />
      )}

      {/* Interrupt button */}
      {isWorking && (
        <button
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-error/10 border border-error/30 text-error hover:bg-error/20 transition-colors"
          onClick={onInterrupt}
          title="Stop Claude"
        >
          <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
            <rect x="0" y="0" width="8" height="8" rx="1" />
          </svg>
          Stop
        </button>
      )}
    </div>
  );
}

function CostDisplay({
  cost,
  lastTurnCost,
  hasApiKey,
  model,
  extendedContext,
}: {
  cost: AgentCost;
  lastTurnCost: AgentCost | null;
  hasApiKey: boolean;
  model: string;
  extendedContext: boolean;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const sessionIn = cost.inputTokens + cost.cacheReadTokens + cost.cacheWriteTokens;

  return (
    <>
      <span
        ref={anchorRef}
        className="text-text-tertiary font-mono cursor-help"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        tabIndex={0}
      >
        {hasApiKey && (
          <>
            ~${cost.totalCostUsd.toFixed(3)}
            <span className="mx-1 opacity-50">|</span>
          </>
        )}
        {formatTokens(sessionIn)} in
        {" / "}
        {formatTokens(cost.outputTokens)} out
      </span>
      {open && anchorRef.current && (
        <CostTooltip
          anchor={anchorRef.current}
          cost={cost}
          lastTurnCost={lastTurnCost}
          hasApiKey={hasApiKey}
          model={model}
          extendedContext={extendedContext}
        />
      )}
    </>
  );
}

/** Portal-mounted tooltip anchored above the cost display. */
function CostTooltip({
  anchor,
  cost,
  lastTurnCost,
  hasApiKey,
  model,
  extendedContext,
}: {
  anchor: HTMLElement;
  cost: AgentCost;
  lastTurnCost: AgentCost | null;
  hasApiKey: boolean;
  model: string;
  extendedContext: boolean;
}) {
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!tooltipRef.current) return;
    const rect = anchor.getBoundingClientRect();
    const tipRect = tooltipRef.current.getBoundingClientRect();
    const margin = 8;
    // Prefer positioning above; fall back below if no room.
    let top = rect.top - tipRect.height - margin;
    if (top < margin) top = rect.bottom + margin;
    // Align right edge with anchor's right, but keep on-screen.
    let left = rect.right - tipRect.width;
    if (left < margin) left = margin;
    const maxLeft = window.innerWidth - tipRect.width - margin;
    if (left > maxLeft) left = maxLeft;
    setPos({ top, left });
  }, [anchor, cost, lastTurnCost, hasApiKey]);

  const sessionInput = cost.inputTokens + cost.cacheReadTokens + cost.cacheWriteTokens;
  const pct = (n: number) =>
    sessionInput > 0 ? ((n / sessionInput) * 100).toFixed(1) + "%" : "0%";
  const lastContext = lastTurnCost
    ? lastTurnCost.inputTokens + lastTurnCost.cacheReadTokens + lastTurnCost.cacheWriteTokens
    : 0;
  const contextWindow = contextWindowFor(model, extendedContext);
  const contextPct = lastContext > 0 ? Math.min(100, (lastContext / contextWindow) * 100) : 0;

  return createPortal(
    <div
      ref={tooltipRef}
      role="tooltip"
      className="fixed z-[9999] w-[380px] rounded-md border border-border-primary bg-bg-primary shadow-xl text-text-primary text-[11px] leading-relaxed p-3 pointer-events-none"
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        opacity: pos ? 1 : 0,
      }}
    >
      <div className="font-semibold text-text-primary mb-2">Token usage</div>

      {/* Current context (last turn) */}
      {lastTurnCost ? (
        <div className="mb-3">
          <div className="text-text-secondary font-medium mb-1">
            Current context (last turn)
          </div>
          <div className="font-mono">
            {fmt(lastContext)} / {formatWindow(contextWindow)} tokens
            <span className="ml-1 text-text-tertiary">({contextPct.toFixed(1)}%)</span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded bg-bg-tertiary overflow-hidden">
            <div
              className={
                "h-full " +
                (contextPct > 85
                  ? "bg-error"
                  : contextPct > 60
                    ? "bg-warning"
                    : "bg-accent")
              }
              style={{ width: `${contextPct}%` }}
            />
          </div>
          <div className="mt-1 text-text-tertiary font-mono text-[10px]">
            fresh {fmt(lastTurnCost.inputTokens)} · cache read {fmt(lastTurnCost.cacheReadTokens)} · cache write {fmt(lastTurnCost.cacheWriteTokens)} · out {fmt(lastTurnCost.outputTokens)}
          </div>
        </div>
      ) : (
        <div className="mb-3 text-text-tertiary italic">
          Current context will appear after the first turn completes.
        </div>
      )}

      {/* Session totals */}
      <div className="border-t border-border-primary pt-2 mb-3">
        <div className="text-text-secondary font-medium mb-1">Session totals</div>
        <div className="grid grid-cols-[auto_1fr_auto] gap-x-2 font-mono text-[11px]">
          <span className="text-text-tertiary">input total</span>
          <span className="text-right">{fmt(sessionInput)}</span>
          <span className="text-text-tertiary">100%</span>

          <span className="text-text-tertiary pl-3">fresh</span>
          <span className="text-right">{fmt(cost.inputTokens)}</span>
          <span className="text-text-tertiary">{pct(cost.inputTokens)}</span>

          <span className="text-text-tertiary pl-3">cache read</span>
          <span className="text-right">{fmt(cost.cacheReadTokens)}</span>
          <span className="text-text-tertiary">{pct(cost.cacheReadTokens)}</span>

          <span className="text-text-tertiary pl-3">cache write</span>
          <span className="text-right">{fmt(cost.cacheWriteTokens)}</span>
          <span className="text-text-tertiary">{pct(cost.cacheWriteTokens)}</span>

          <span className="text-text-tertiary">output</span>
          <span className="text-right">{fmt(cost.outputTokens)}</span>
          <span />
        </div>
      </div>

      {/* Explanation */}
      <div className="border-t border-border-primary pt-2 space-y-2 text-text-secondary">
        <div>
          <span className="text-text-primary font-medium">Fresh input</span>: new
          tokens the model hasn't seen (your latest prompt + tool results). Full price.
        </div>
        <div>
          <span className="text-text-primary font-medium">Cache read</span>: prior
          conversation replayed from Anthropic's prompt cache. ~10% of fresh price.
          Accumulates every turn because each turn re-reads all prior context.
        </div>
        <div>
          <span className="text-text-primary font-medium">Cache write</span>: new
          content added to the cache this turn. ~125% of fresh price, charged once.
        </div>
        <div className="text-text-tertiary">
          Session totals are cumulative across every turn. Current context shows
          just the last turn — roughly what the model held in its context window.
        </div>
      </div>

      {/* Billing */}
      <div className="border-t border-border-primary pt-2 mt-2">
        {hasApiKey ? (
          <div className="font-mono">
            Estimated cost:{" "}
            <span className="text-text-primary">${cost.totalCostUsd.toFixed(4)}</span>
            <span className="ml-1 text-text-tertiary">(session total, API pricing)</span>
          </div>
        ) : (
          <div className="text-text-tertiary">
            Billing: Claude subscription — no per-token charge.
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function fmt(n: number): string {
  return n.toLocaleString();
}

/** Compact formatter for context window sizes (e.g. 200k, 1M). */
function formatWindow(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1) + "M";
  return (n / 1_000).toFixed(0) + "k";
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
