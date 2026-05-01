import { useMemo } from "react";
import type { TraceEvent, AgentCost } from "../../lib/types";
import { computeTokenTimeline, formatTokenCount, formatCost } from "../../lib/traceUtils";

interface Props {
  events: TraceEvent[];
  sessionCost: AgentCost | null;
  maximized: boolean;
  contextWindow: number;
  hasApiKey: boolean;
}

export function TraceTokenChart({ events, sessionCost, maximized, contextWindow, hasApiKey }: Props) {
  const tokenData = useMemo(() => computeTokenTimeline(events), [events]);

  if (tokenData.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        No token data yet. Token usage appears after the first turn completes.
      </div>
    );
  }

  const maxTokens = Math.max(...tokenData.map((d) => d.totalTokens), 1);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-4">
      {/* Session cost summary */}
      {sessionCost && <CostSummary cost={sessionCost} turnCount={tokenData.length} hasApiKey={hasApiKey} />}

      {/* Per-turn stacked bar chart */}
      <div>
        <div className="text-text-secondary text-xs font-medium mb-2">Tokens per turn</div>
        <div className="space-y-1">
          {tokenData.map((point, i) => {
            const totalPct = (point.totalTokens / maxTokens) * 100;
            const inputPct = (point.inputTokens / point.totalTokens) * 100;
            const crPct = (point.cacheReadTokens / point.totalTokens) * 100;
            const cwPct = (point.cacheWriteTokens / point.totalTokens) * 100;

            return (
              <div key={i} className="flex items-center gap-2">
                <span className="text-text-tertiary text-[10px] font-mono w-6 shrink-0 text-right">
                  {i + 1}
                </span>
                <div
                  className="h-3 flex rounded-sm overflow-hidden bg-bg-tertiary"
                  style={{ width: `${Math.max(totalPct, 2)}%` }}
                  title={`Turn ${i + 1}: ${formatTokenCount(point.totalTokens)} total`}
                >
                  {/* Fresh input — full price */}
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${inputPct}%` }}
                  />
                  {/* Cache read — cheap */}
                  <div
                    className="h-full bg-success/60"
                    style={{ width: `${crPct}%` }}
                  />
                  {/* Cache write — expensive */}
                  <div
                    className="h-full bg-warning/60"
                    style={{ width: `${cwPct}%` }}
                  />
                  {/* Output — remainder */}
                  <div className="h-full bg-purple-400/60 flex-1" />
                </div>
                <span className="text-text-tertiary text-[10px] font-mono shrink-0">
                  {formatTokenCount(point.totalTokens)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-3 mt-2 text-[10px] text-text-tertiary">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-accent" /> Input
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-success/60" /> Cache read
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-warning/60" /> Cache write
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm bg-purple-400/60" /> Output
          </span>
        </div>
      </div>

      {/* Context window usage over time (simple bar chart) */}
      <ContextWindowChart tokenData={tokenData} maximized={maximized} contextWindow={contextWindow} />
    </div>
  );
}

// ── Context Window Usage Chart ──

function ContextWindowChart({
  tokenData,
  maximized: _maximized,
  contextWindow,
}: {
  tokenData: ReturnType<typeof computeTokenTimeline>;
  maximized: boolean;
  contextWindow: number;
}) {
  // Context = input + cache_read + cache_write for each turn
  // This approximates how much of the model's context window was used per API call.
  const contextSizes = tokenData.map((p) =>
    p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens
  );
  const maxObserved = Math.max(...contextSizes, 0);

  // Scale bars against the model's actual context window so thresholds are meaningful.
  // If usage somehow exceeds the window (e.g. different model), fall back to max observed.
  const scaleMax = Math.max(contextWindow, maxObserved);

  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2">
        <span className="text-text-secondary text-xs font-medium">Context usage per turn</span>
        <span className="text-[9px] text-text-tertiary font-mono">
          / {formatTokenCount(contextWindow)} window
        </span>
      </div>
      <div className="relative">
        {/* Threshold lines — positioned as % of the model context window */}
        <div className="absolute inset-0 pointer-events-none">
          <div
            className="absolute w-full border-t border-dashed border-warning/30"
            style={{ bottom: "60%" }}
          >
            <span className="absolute right-0 -bottom-3 text-[9px] text-warning/60">60%</span>
          </div>
          <div
            className="absolute w-full border-t border-dashed border-error/30"
            style={{ bottom: "85%" }}
          >
            <span className="absolute right-0 -bottom-3 text-[9px] text-error/60">85%</span>
          </div>
        </div>

        {/* Bars */}
        <div className="flex items-end gap-0.5" style={{ height: 80 }}>
          {contextSizes.map((ctx, i) => {
            const pct = (ctx / scaleMax) * 100;
            const windowPct = (ctx / contextWindow) * 100;
            const color =
              windowPct > 85
                ? "bg-error/60"
                : windowPct > 60
                  ? "bg-warning/60"
                  : "bg-accent/40";
            return (
              <div
                key={i}
                className={`flex-1 min-w-[3px] rounded-t-sm ${color}`}
                style={{ height: `${Math.max(pct, 2)}%` }}
                title={`Turn ${i + 1}: ${formatTokenCount(ctx)} tokens (${Math.round(windowPct)}% of context)`}
              />
            );
          })}
        </div>
      </div>
      <div className="flex justify-between text-[9px] text-text-tertiary mt-1">
        <span>Turn 1</span>
        <span>Turn {contextSizes.length}</span>
      </div>
    </div>
  );
}

// ── Cost Summary ──

function CostSummary({ cost, turnCount, hasApiKey }: { cost: AgentCost; turnCount: number; hasApiKey: boolean }) {
  const totalInput = cost.inputTokens + cost.cacheReadTokens + cost.cacheWriteTokens;

  return (
    <div className="border border-border-primary rounded-md p-3 bg-bg-secondary">
      <div className="text-text-secondary text-xs font-medium mb-2">Session summary</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono">
        {hasApiKey && (
          <>
            <span className="text-text-tertiary">Total cost</span>
            <span className="text-text-primary text-right">{formatCost(cost.totalCostUsd)}</span>
          </>
        )}

        <span className="text-text-tertiary">Turns</span>
        <span className="text-text-primary text-right">{turnCount}</span>

        <span className="text-text-tertiary">Total input</span>
        <span className="text-text-primary text-right">{formatTokenCount(totalInput)}</span>

        <span className="text-text-tertiary pl-2">Fresh</span>
        <span className="text-text-secondary text-right">{formatTokenCount(cost.inputTokens)}</span>

        <span className="text-text-tertiary pl-2">Cache read</span>
        <span className="text-text-secondary text-right">{formatTokenCount(cost.cacheReadTokens)}</span>

        <span className="text-text-tertiary pl-2">Cache write</span>
        <span className="text-text-secondary text-right">{formatTokenCount(cost.cacheWriteTokens)}</span>

        <span className="text-text-tertiary">Total output</span>
        <span className="text-text-primary text-right">{formatTokenCount(cost.outputTokens)}</span>
      </div>
    </div>
  );
}
