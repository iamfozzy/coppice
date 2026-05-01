import { useState, useMemo } from "react";
import type { TraceEvent, TokenUsage } from "../../lib/types";
import {
  deriveTraceTimeline,
  formatDuration,
  formatTokenCount,
  summarizeToolInput,
  type TraceQuery,
  type TraceTurn,
  type ToolCallPair,
  type InlineEvent,
} from "../../lib/traceUtils";

interface Props {
  events: TraceEvent[];
  maximized: boolean;
}

export function TraceTimeline({ events, maximized }: Props) {
  const timeline = useMemo(() => deriveTraceTimeline(events), [events]);

  if (timeline.queries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
        No trace events yet. Run an agent query to see the timeline.
      </div>
    );
  }

  // Find the longest query for proportional duration bars
  const maxDuration = Math.max(...timeline.queries.map((q) => q.durationMs), 1);

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
      {timeline.queries.map((query) => (
        <QueryRow
          key={query.index}
          query={query}
          maxDuration={maxDuration}
          maximized={maximized}
        />
      ))}
    </div>
  );
}

// ── Query Row ──

function QueryRow({
  query,
  maxDuration,
  maximized,
}: {
  query: TraceQuery;
  maxDuration: number;
  maximized: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const durationPct = Math.max(2, (query.durationMs / maxDuration) * 100);

  // Find longest turn for proportional bars within this query
  const maxTurnDuration = Math.max(...query.turns.map((t) => t.durationMs), 1);

  // Total tool calls across all turns
  const totalTools = query.turns.reduce((sum, t) => sum + t.toolCalls.length, 0);

  // Interleave turns and inline events by timestamp for correct ordering
  const interleaved = useMemo(() => {
    const items: Array<{ type: "turn"; turn: TraceTurn } | { type: "inline"; event: InlineEvent }> = [];
    let inlineIdx = 0;
    for (const turn of query.turns) {
      // Insert any inline events that precede this turn
      while (inlineIdx < query.inlineEvents.length && query.inlineEvents[inlineIdx].timestamp <= turn.startTime) {
        items.push({ type: "inline", event: query.inlineEvents[inlineIdx] });
        inlineIdx++;
      }
      items.push({ type: "turn", turn });
    }
    // Remaining inline events after all turns
    while (inlineIdx < query.inlineEvents.length) {
      items.push({ type: "inline", event: query.inlineEvents[inlineIdx] });
      inlineIdx++;
    }
    return items;
  }, [query.turns, query.inlineEvents]);

  return (
    <div className="border border-border-primary rounded-md overflow-hidden">
      {/* Query header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-bg-secondary hover:bg-bg-tertiary transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`shrink-0 text-text-tertiary transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span className="text-accent text-[10px] font-mono shrink-0">Q{query.index + 1}</span>
        <span className="flex-1 min-w-0" />
        <span className="text-text-tertiary text-[10px] font-mono shrink-0">
          {query.numTurns}T · {totalTools} tool{totalTools !== 1 ? "s" : ""}
        </span>
        {query.totalCost && query.totalCost.totalCostUsd > 0 && (
          <span className="text-text-tertiary text-[10px] font-mono shrink-0">
            ${query.totalCost.totalCostUsd.toFixed(3)}
          </span>
        )}
        <span className="text-text-tertiary text-[10px] font-mono shrink-0">
          {formatDuration(query.durationMs)}
        </span>
      </button>

      {/* Prompt text — always visible below header */}
      {query.prompt && (
        <div className="px-3 pb-1.5 pt-0 bg-bg-secondary border-b border-border-primary">
          <button
            className="text-left w-full"
            onClick={(e) => { e.stopPropagation(); setPromptExpanded((v) => !v); }}
          >
            {promptExpanded ? (
              <p className="text-[11px] text-text-secondary whitespace-pre-wrap break-words">
                {query.prompt}
              </p>
            ) : (
              <p className={`text-[11px] text-text-secondary truncate ${maximized ? "max-w-[700px]" : "max-w-[300px]"}`}>
                {query.prompt}
              </p>
            )}
          </button>
        </div>
      )}

      {/* Duration bar */}
      <div className="h-0.5 bg-bg-tertiary">
        <div
          className="h-full bg-accent/40"
          style={{ width: `${durationPct}%` }}
        />
      </div>

      {/* Turns and inline events */}
      {expanded && (
        <div className="border-t border-border-primary">
          {interleaved.map((item, i) =>
            item.type === "turn" ? (
              <TurnRow
                key={`turn-${item.turn.index}`}
                turn={item.turn}
                maxTurnDuration={maxTurnDuration}
                maximized={maximized}
              />
            ) : (
              <InlineEventRow key={`inline-${i}`} event={item.event} />
            )
          )}
        </div>
      )}
    </div>
  );
}

// ── Inline Event Row (compaction, error) ──

function InlineEventRow({ event }: { event: InlineEvent }) {
  if (event.type === "compact") {
    const label = event.trigger === "manual" ? "Manual compaction" : "Auto-compaction";
    return (
      <div className="flex items-center gap-2 px-3 py-1 pl-7 border-b border-border-primary last:border-b-0 bg-warning/5">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning shrink-0">
          <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2z" />
          <path d="M9 9h6M9 15h6M12 9v6" />
        </svg>
        <span className="text-warning text-[10px]">{label}</span>
        {event.preTokens && (
          <span className="text-text-tertiary text-[10px] font-mono">
            was {formatTokenCount(event.preTokens)}
          </span>
        )}
      </div>
    );
  }

  // Error
  return (
    <div className="flex items-center gap-2 px-3 py-1 pl-7 border-b border-border-primary last:border-b-0 bg-error/5">
      <span className="w-1.5 h-1.5 rounded-full bg-error shrink-0" />
      <span className="text-error text-[10px] truncate">{event.content || "Error"}</span>
    </div>
  );
}

// ── Turn Row ──

function TurnRow({
  turn,
  maxTurnDuration,
  maximized,
}: {
  turn: TraceTurn;
  maxTurnDuration: number;
  maximized: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const durationPct = Math.max(2, (turn.durationMs / maxTurnDuration) * 100);

  // "New" tokens = fresh input + cache write + output (excludes cache reads,
  // which are 90% cheaper and represent already-cached context).
  const newTokens = turn.cost
    ? turn.cost.inputTokens + turn.cost.cacheWriteTokens + turn.cost.outputTokens
    : 0;

  // Prefer paired tool calls, fall back to turnToolNames from the assistant message
  const pairedToolNames = turn.toolCalls.map((tc) => tc.call.toolName || "?");
  const effectiveToolNames = pairedToolNames.length > 0 ? pairedToolNames : turn.turnToolNames;
  const hasErrors = turn.toolCalls.some((tc) => tc.result?.isError);
  const hasExpandable = turn.toolCalls.length > 0 || turn.hasThinking || turn.responseText;

  // Compact tool flow: "Read → Grep → Edit"
  const toolFlow = effectiveToolNames.length > 0
    ? effectiveToolNames.join(" → ")
    : null;

  // Turn description for when there are no tools — show what actually happened
  const turnDesc = toolFlow
    ? null
    : turn.responseText
      ? "response"
      : null;

  return (
    <div className="border-b border-border-primary last:border-b-0">
      {/* Turn header */}
      <button
        className="w-full flex items-start gap-2 px-3 py-1.5 pl-7 hover:bg-bg-tertiary/50 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Expand chevron */}
        <div className="pt-0.5">
          {hasExpandable ? (
            <svg
              width="8"
              height="8"
              viewBox="0 0 10 10"
              className={`shrink-0 text-text-tertiary transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          ) : (
            <span className="w-2 shrink-0 inline-block" />
          )}
        </div>

        {/* Main content column */}
        <div className="flex-1 min-w-0">
          {/* Primary line: turn label + inline tool flow + badges + metrics */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-text-secondary text-[10px] font-mono shrink-0">
              T{turn.index + 1}
            </span>

            {/* Thinking indicator */}
            {turn.hasThinking && (
              <span className="text-[9px] text-purple-400 border border-purple-400/30 rounded px-1" title="Has extended thinking">
                think
              </span>
            )}

            {/* Error indicator */}
            {hasErrors && (
              <span className="text-[9px] text-error border border-error/30 rounded px-1">
                error
              </span>
            )}

            {/* Tool flow inline — e.g. "Read → Grep → Edit" */}
            {toolFlow && (
              <span className={`text-[10px] font-mono text-accent/80 truncate ${maximized ? "max-w-[400px]" : "max-w-[200px]"}`}>
                {toolFlow}
              </span>
            )}

            {/* Fallback description when no tools */}
            {turnDesc && (
              <span className="text-[10px] text-text-tertiary italic">
                {turnDesc}
              </span>
            )}

            <span className="flex-1" />

            {/* Token count (excluding cache reads) */}
            {newTokens > 0 && (
              <span className="text-text-tertiary text-[10px] font-mono shrink-0" title="New tokens (excl. cache reads)">
                {formatTokenCount(newTokens)}
              </span>
            )}

            {/* Duration bar */}
            <div className={`h-1 rounded-full bg-bg-tertiary overflow-hidden shrink-0 ${maximized ? "w-24" : "w-16"}`}>
              <div
                className="h-full bg-accent/60 rounded-full"
                style={{ width: `${durationPct}%` }}
              />
            </div>

            <span className="text-text-tertiary text-[10px] font-mono shrink-0 w-12 text-right">
              {formatDuration(turn.durationMs)}
            </span>
          </div>

          {/* Detail line: tool input summaries (when paired tool calls exist) */}
          {!expanded && turn.toolCalls.length > 0 && (
            <div className="flex items-center gap-0 mt-0.5 flex-wrap">
              {turn.toolCalls.map((pair, i) => {
                const name = pair.call.toolName || "?";
                const isErr = pair.result?.isError;
                const summary = summarizeToolInput(name, pair.call.toolInput);
                if (!summary) return null;
                return (
                  <span key={i} className="flex items-center">
                    {i > 0 && <span className="text-text-tertiary text-[9px] mx-0.5">·</span>}
                    <span className={`text-[9px] truncate ${isErr ? "text-error/70" : "text-text-tertiary"} ${maximized ? "max-w-[250px]" : "max-w-[150px]"}`}>
                      {summary}
                    </span>
                  </span>
                );
              })}
            </div>
          )}

          {/* Response text preview — shown when collapsed and no tools */}
          {!expanded && turn.responseText && effectiveToolNames.length === 0 && (
            <p className={`text-[10px] text-text-tertiary mt-0.5 truncate ${maximized ? "max-w-[600px]" : "max-w-[260px]"}`}>
              {turn.responseText}
            </p>
          )}
        </div>
      </button>

      {/* Expanded: full response + tool details + thinking + token breakdown */}
      {expanded && (
        <div className="pl-12 pr-3 pb-2 space-y-1.5">
          {/* Thinking text */}
          {turn.thinkingText && (
            <ThinkingBlock text={turn.thinkingText} maximized={maximized} />
          )}

          {/* Response text (full) */}
          {turn.responseText && (
            <ResponseBlock text={turn.responseText} maximized={maximized} />
          )}

          {/* Tool calls */}
          {turn.toolCalls.map((tc, i) => (
            <ToolCallRow key={i} pair={tc} maximized={maximized} />
          ))}

          {/* Token breakdown */}
          {turn.cost && <TokenBreakdown cost={turn.cost} />}
        </div>
      )}
    </div>
  );
}

// ── Response Block ──

function ResponseBlock({ text, maximized }: { text: string; maximized: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border-primary rounded overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-2 py-1 hover:bg-bg-tertiary/30 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-text-tertiary text-[9px] uppercase tracking-wide shrink-0">Response</span>
        {!expanded && (
          <span className="text-text-secondary text-[10px] truncate">
            {text.slice(0, 150)}
          </span>
        )}
      </button>
      {expanded && (
        <pre className={`border-t border-border-primary px-2 py-1.5 text-[10px] text-text-secondary whitespace-pre-wrap overflow-y-auto ${maximized ? "max-h-[400px]" : "max-h-[200px]"}`}>
          {text}
        </pre>
      )}
    </div>
  );
}

// ── Tool Call Row ──

function ToolCallRow({ pair, maximized }: { pair: ToolCallPair; maximized: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const name = pair.call.toolName || "unknown";
  const hasError = pair.result?.isError;
  const summary = summarizeToolInput(name, pair.call.toolInput);

  return (
    <div className="border border-border-primary rounded overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-2 py-1 hover:bg-bg-tertiary/50 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Status indicator */}
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasError ? "bg-error" : pair.result ? "bg-success" : "bg-warning"}`} />

        <span className="text-text-primary text-[11px] font-mono shrink-0">
          {name}
        </span>

        {/* Input summary inline */}
        {summary && (
          <span className={`text-[10px] text-text-tertiary truncate ${maximized ? "max-w-[400px]" : "max-w-[180px]"}`}>
            {summary}
          </span>
        )}

        <span className="flex-1" />

        {/* Output size hint */}
        {pair.result?.toolOutput && (
          <span className="text-text-tertiary text-[9px] font-mono shrink-0">
            {pair.result.toolOutput.length > 1000
              ? `${(pair.result.toolOutput.length / 1000).toFixed(1)}k chars`
              : `${pair.result.toolOutput.length} chars`}
          </span>
        )}

        {pair.durationMs !== null && (
          <span className="text-text-tertiary text-[10px] font-mono shrink-0">
            {formatDuration(pair.durationMs)}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border-primary px-2 py-1.5 space-y-1.5">
          {/* Input */}
          {pair.call.toolInput !== undefined && (
            <div>
              <div className="text-[9px] text-text-tertiary uppercase tracking-wide mb-0.5">Input</div>
              <pre className={`text-[10px] text-text-secondary font-mono bg-bg-tertiary rounded p-1.5 overflow-x-auto whitespace-pre-wrap ${maximized ? "max-h-[400px]" : "max-h-[200px]"}`}>
                {typeof pair.call.toolInput === "string"
                  ? pair.call.toolInput
                  : JSON.stringify(pair.call.toolInput, null, 2)}
              </pre>
            </div>
          )}

          {/* Output */}
          {pair.result?.toolOutput && (
            <div>
              <div className={`text-[9px] uppercase tracking-wide mb-0.5 ${hasError ? "text-error" : "text-text-tertiary"}`}>
                {hasError ? "Error" : "Output"}
              </div>
              <pre className={`text-[10px] font-mono bg-bg-tertiary rounded p-1.5 overflow-x-auto whitespace-pre-wrap ${hasError ? "text-error/80" : "text-text-secondary"} ${maximized ? "max-h-[400px]" : "max-h-[200px]"}`}>
                {pair.result.toolOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Thinking Block ──

function ThinkingBlock({ text, maximized }: { text: string; maximized: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;

  return (
    <div className="border border-purple-400/20 rounded overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-2 py-1 hover:bg-purple-400/5 transition-colors text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-purple-400 text-[9px] uppercase tracking-wide shrink-0">Thinking</span>
        {!expanded && (
          <span className="text-text-tertiary text-[10px] truncate">{preview}</span>
        )}
      </button>
      {expanded && (
        <pre className={`border-t border-purple-400/20 px-2 py-1.5 text-[10px] text-text-secondary font-mono whitespace-pre-wrap overflow-y-auto ${maximized ? "max-h-[500px]" : "max-h-[250px]"}`}>
          {text}
        </pre>
      )}
    </div>
  );
}

// ── Token Breakdown ──

function TokenBreakdown({ cost }: { cost: TokenUsage }) {
  const total = cost.inputTokens + cost.cacheReadTokens + cost.cacheWriteTokens + cost.outputTokens;
  if (total === 0) return null;

  const inputPct = (cost.inputTokens / total) * 100;
  const crPct = (cost.cacheReadTokens / total) * 100;
  const cwPct = (cost.cacheWriteTokens / total) * 100;
  // output is the remainder via flex-1

  return (
    <div className="pt-1 border-t border-border-primary space-y-1">
      {/* Stacked bar */}
      <div className="h-2 flex rounded-sm overflow-hidden bg-bg-tertiary">
        {cost.inputTokens > 0 && (
          <div className="h-full bg-accent" style={{ width: `${inputPct}%` }} title={`Input: ${formatTokenCount(cost.inputTokens)}`} />
        )}
        {cost.cacheReadTokens > 0 && (
          <div className="h-full bg-success/60" style={{ width: `${crPct}%` }} title={`Cache read: ${formatTokenCount(cost.cacheReadTokens)}`} />
        )}
        {cost.cacheWriteTokens > 0 && (
          <div className="h-full bg-warning/60" style={{ width: `${cwPct}%` }} title={`Cache write: ${formatTokenCount(cost.cacheWriteTokens)}`} />
        )}
        {cost.outputTokens > 0 && (
          <div className="h-full bg-purple-400/60 flex-1" title={`Output: ${formatTokenCount(cost.outputTokens)}`} />
        )}
      </div>

      {/* Legend with counts */}
      <div className="flex items-center gap-3 text-[10px] font-mono text-text-tertiary">
        <span>
          <span className="inline-block w-1.5 h-1.5 rounded-sm bg-accent mr-0.5 align-middle" />
          in: {formatTokenCount(cost.inputTokens)}
        </span>
        <span>
          <span className="inline-block w-1.5 h-1.5 rounded-sm bg-success/60 mr-0.5 align-middle" />
          CR: {formatTokenCount(cost.cacheReadTokens)}
        </span>
        <span>
          <span className="inline-block w-1.5 h-1.5 rounded-sm bg-warning/60 mr-0.5 align-middle" />
          CW: {formatTokenCount(cost.cacheWriteTokens)}
        </span>
        <span>
          <span className="inline-block w-1.5 h-1.5 rounded-sm bg-purple-400/60 mr-0.5 align-middle" />
          out: {formatTokenCount(cost.outputTokens)}
        </span>
      </div>
    </div>
  );
}
