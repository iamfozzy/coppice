import { useState, useRef, useCallback } from "react";
import type { TraceEvent, AgentCost } from "../../lib/types";
import { TraceTimeline } from "./TraceTimeline";
import { TraceTokenChart } from "./TraceTokenChart";
import { formatDuration, formatCost } from "../../lib/traceUtils";

type SubTab = "timeline" | "tokens";

interface Props {
  events: TraceEvent[];
  sessionCost: AgentCost | null;
  maximized: boolean;
  onClose: () => void;
  onToggleMaximize: () => void;
}

export function TracePanel({ events, sessionCost, maximized, onClose, onToggleMaximize }: Props) {
  const [activeTab, setActiveTab] = useState<SubTab>("timeline");
  const [width, setWidth] = useState(400);
  const dragging = useRef(false);

  // ── Resize handle (only in split mode) ──
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (maximized) return;
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      // Drag left = wider, drag right = narrower
      const delta = startX - ev.clientX;
      const next = Math.min(700, Math.max(300, startWidth + delta));
      requestAnimationFrame(() => setWidth(next));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [maximized, width]);

  // ── Summary stats ──
  const turnCount = events.filter((e) => e.type === "turn_cost").length;
  const queryCount = events.filter((e) => e.type === "query_start").length;
  const lastQueryEnd = [...events].reverse().find((e) => e.type === "query_end");
  const totalDuration = lastQueryEnd?.durationMs ?? 0;

  return (
    <div
      className="flex flex-col h-full bg-bg-primary border-l border-border-primary relative shrink-0"
      style={maximized ? { flex: "1 1 0%" } : { width }}
    >
      {/* Resize handle (left edge) — only in split mode */}
      {!maximized && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 z-10"
          onMouseDown={onMouseDown}
        />
      )}

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-primary bg-bg-secondary shrink-0">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-accent shrink-0">
          <path d="M3 12h4l3-9 4 18 3-9h4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-text-primary text-xs font-medium">Trace</span>

        {/* Summary badges */}
        <div className="flex items-center gap-1.5 ml-1">
          {queryCount > 0 && (
            <span className="text-[9px] font-mono text-text-tertiary bg-bg-tertiary rounded px-1 py-0.5">
              {queryCount}Q · {turnCount}T
            </span>
          )}
          {totalDuration > 0 && (
            <span className="text-[9px] font-mono text-text-tertiary bg-bg-tertiary rounded px-1 py-0.5">
              {formatDuration(totalDuration)}
            </span>
          )}
          {sessionCost && sessionCost.totalCostUsd > 0 && (
            <span className="text-[9px] font-mono text-text-tertiary bg-bg-tertiary rounded px-1 py-0.5">
              {formatCost(sessionCost.totalCostUsd)}
            </span>
          )}
        </div>

        <span className="flex-1" />

        {/* Maximize / Restore button */}
        <button
          className="p-1 rounded hover:bg-bg-tertiary text-text-tertiary hover:text-text-primary transition-colors"
          onClick={onToggleMaximize}
          title={maximized ? "Restore split view" : "Maximize trace panel"}
        >
          {maximized ? (
            // Restore (compress) icon
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            // Maximize (expand) icon
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        {/* Close button */}
        <button
          className="p-1 rounded hover:bg-bg-tertiary text-text-tertiary hover:text-text-primary transition-colors"
          onClick={onClose}
          title="Close trace panel"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Sub-tab bar */}
      <div className="flex items-center gap-0 px-3 border-b border-border-primary bg-bg-secondary shrink-0">
        <TabButton label="Timeline" active={activeTab === "timeline"} onClick={() => setActiveTab("timeline")} />
        <TabButton label="Tokens" active={activeTab === "tokens"} onClick={() => setActiveTab("tokens")} />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {activeTab === "timeline" ? (
          <TraceTimeline events={events} maximized={maximized} />
        ) : (
          <TraceTokenChart events={events} sessionCost={sessionCost} maximized={maximized} />
        )}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
        active
          ? "border-accent text-text-primary"
          : "border-transparent text-text-tertiary hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
