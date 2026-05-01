import type { TraceEvent, TokenUsage, AgentCost } from "./types";

// ── Derived trace structures ──

export interface ToolCallPair {
  call: TraceEvent;
  result: TraceEvent | null;
  durationMs: number | null;
}

export interface TraceTurn {
  index: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  cost: TokenUsage | null;
  toolCalls: ToolCallPair[];
  hasThinking: boolean;
  thinkingText?: string;
  /** Truncated assistant response text from this turn. */
  responseText?: string;
  /** Tool names from the assistant message (always set, even if pairing fails). */
  turnToolNames: string[];
}

/** An inline event that doesn't belong to a turn (compaction, error). */
export interface InlineEvent {
  type: "compact" | "error";
  timestamp: number;
  content?: string;
  preTokens?: number;
  trigger?: string;
}

export interface TraceQuery {
  index: number;
  prompt: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  turns: TraceTurn[];
  /** Compaction and error events that occurred during this query. */
  inlineEvents: InlineEvent[];
  totalCost: AgentCost | null;
  numTurns: number;
}

export interface TraceTimeline {
  queries: TraceQuery[];
  totalDurationMs: number;
  totalCost: AgentCost | null;
}

// ── Derivation ──

/**
 * Groups flat TraceEvent[] into a hierarchical timeline:
 *   Query > Turn > ToolCalls
 */
export function deriveTraceTimeline(events: TraceEvent[]): TraceTimeline {
  if (events.length === 0) {
    return { queries: [], totalDurationMs: 0, totalCost: null };
  }

  const queries: TraceQuery[] = [];
  let currentQuery: TraceQuery | null = null;
  let currentTurn: TraceTurn | null = null;
  let turnIndex = 0;
  let queryIndex = 0;

  // Map toolUseId -> tool_call event for pairing
  const pendingToolCalls = new Map<string, TraceEvent>();

  for (const event of events) {
    switch (event.type) {
      case "query_start": {
        // Close previous query if still open
        if (currentQuery) {
          if (currentTurn) {
            currentTurn.endTime = event.timestamp;
            currentTurn.durationMs = currentTurn.endTime - currentTurn.startTime;
            currentQuery.turns.push(currentTurn);
            currentTurn = null;
          }
          currentQuery.endTime = event.timestamp;
          currentQuery.durationMs = currentQuery.endTime - currentQuery.startTime;
          queries.push(currentQuery);
        }
        currentQuery = {
          index: queryIndex++,
          prompt: event.content || "",
          startTime: event.timestamp,
          endTime: event.timestamp,
          durationMs: 0,
          turns: [],
          inlineEvents: [],
          totalCost: null,
          numTurns: 0,
        };
        turnIndex = 0;
        break;
      }

      case "turn_start": {
        // Ensure we have a query container
        if (!currentQuery) {
          currentQuery = {
            index: queryIndex++,
            prompt: "(resumed)",
            startTime: event.timestamp,
            endTime: event.timestamp,
            durationMs: 0,
            turns: [],
            inlineEvents: [],
            totalCost: null,
            numTurns: 0,
          };
        }
        // Close previous turn
        if (currentTurn) {
          currentTurn.endTime = event.timestamp;
          currentTurn.durationMs = currentTurn.endTime - currentTurn.startTime;
          currentQuery.turns.push(currentTurn);
        }
        currentTurn = {
          index: turnIndex++,
          startTime: event.timestamp,
          endTime: event.timestamp,
          durationMs: 0,
          cost: null,
          toolCalls: [],
          hasThinking: !!event.thinkingText,
          thinkingText: event.thinkingText,
          responseText: event.content || undefined,
          turnToolNames: event.turnToolNames ?? [],
        };
        break;
      }

      case "turn_cost": {
        if (currentTurn && event.cost) {
          currentTurn.cost = event.cost;
        }
        break;
      }

      case "tool_call": {
        if (event.toolUseId) {
          pendingToolCalls.set(event.toolUseId, event);
        }
        break;
      }

      case "tool_result": {
        const matchedCall = event.toolUseId
          ? pendingToolCalls.get(event.toolUseId)
          : undefined;
        if (event.toolUseId) pendingToolCalls.delete(event.toolUseId);

        const pair: ToolCallPair = {
          call: matchedCall ?? event,
          result: event,
          durationMs: matchedCall
            ? event.timestamp - matchedCall.timestamp
            : null,
        };
        if (currentTurn) {
          currentTurn.toolCalls.push(pair);
        }
        break;
      }

      case "compact": {
        // Compaction events are surfaced as inline events in the query
        if (currentQuery) {
          currentQuery.inlineEvents.push({
            type: "compact",
            timestamp: event.timestamp,
            preTokens: event.preTokens,
            trigger: event.trigger,
          });
        }
        break;
      }

      case "error": {
        if (currentQuery) {
          currentQuery.inlineEvents.push({
            type: "error",
            timestamp: event.timestamp,
            content: event.content,
          });
        }
        break;
      }

      case "query_end": {
        if (currentQuery) {
          // Close current turn
          if (currentTurn) {
            currentTurn.endTime = event.timestamp;
            currentTurn.durationMs = currentTurn.endTime - currentTurn.startTime;
            currentQuery.turns.push(currentTurn);
            currentTurn = null;
          }
          currentQuery.endTime = event.timestamp;
          currentQuery.durationMs = event.durationMs ?? (currentQuery.endTime - currentQuery.startTime);
          currentQuery.totalCost = event.cumulativeCost ?? null;
          currentQuery.numTurns = event.numTurns ?? currentQuery.turns.length;
          queries.push(currentQuery);
          currentQuery = null;
        }
        break;
      }

      // status_change, error — no structural impact on the tree
    }
  }

  // Close any open query/turn
  if (currentQuery) {
    if (currentTurn) {
      const lastTs = events[events.length - 1].timestamp;
      currentTurn.endTime = lastTs;
      currentTurn.durationMs = currentTurn.endTime - currentTurn.startTime;
      currentQuery.turns.push(currentTurn);
    }
    const lastTs = events[events.length - 1].timestamp;
    currentQuery.endTime = lastTs;
    currentQuery.durationMs = currentQuery.endTime - currentQuery.startTime;
    queries.push(currentQuery);
  }

  const firstTs = events[0].timestamp;
  const lastTs = events[events.length - 1].timestamp;
  const lastQuery = queries[queries.length - 1];

  return {
    queries,
    totalDurationMs: lastTs - firstTs,
    totalCost: lastQuery?.totalCost ?? null,
  };
}

// ── Token timeline data ──

export interface TokenTimelinePoint {
  turnIndex: number;
  queryIndex: number;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

/**
 * Extracts per-turn token data points from trace events for charting.
 */
export function computeTokenTimeline(events: TraceEvent[]): TokenTimelinePoint[] {
  const points: TokenTimelinePoint[] = [];
  let queryIndex = 0;
  let turnIndex = 0;

  for (const event of events) {
    if (event.type === "query_start") {
      queryIndex++;
      turnIndex = 0;
    } else if (event.type === "turn_cost" && event.cost) {
      const c = event.cost;
      points.push({
        turnIndex: turnIndex++,
        queryIndex,
        timestamp: event.timestamp,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheWriteTokens: c.cacheWriteTokens,
        totalTokens: c.inputTokens + c.outputTokens + c.cacheReadTokens + c.cacheWriteTokens,
      });
    }
  }

  return points;
}

// ── Formatters ──

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * Extract a short human-readable summary from a tool call's input.
 * e.g. Read({file_path: "/src/foo.ts"}) → "/src/foo.ts"
 *      Grep({pattern: "TODO", path: "src/"}) → "TODO in src/"
 *      Edit({file_path: "/src/bar.ts"}) → "/src/bar.ts"
 *      Bash({command: "npm test"}) → "npm test"
 */
export function summarizeToolInput(_toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;

  // File-oriented tools: show file path
  if (obj.file_path && typeof obj.file_path === "string") {
    const path = obj.file_path as string;
    // Show just the last 2-3 segments
    const parts = path.split(/[/\\]/);
    return parts.length > 3 ? ".../" + parts.slice(-3).join("/") : path;
  }

  // Grep/search: show pattern + path
  if (obj.pattern && typeof obj.pattern === "string") {
    const p = (obj.pattern as string).slice(0, 40);
    const path = obj.path ? ` in ${(obj.path as string).split(/[/\\]/).pop()}` : "";
    return `"${p}"${path}`;
  }

  // Bash/command tools
  if (obj.command && typeof obj.command === "string") {
    return (obj.command as string).slice(0, 60);
  }

  // Glob: show pattern
  if (obj.glob && typeof obj.glob === "string") {
    return obj.glob as string;
  }

  // WebFetch / URL-based
  if (obj.url && typeof obj.url === "string") {
    return (obj.url as string).slice(0, 60);
  }

  return null;
}
