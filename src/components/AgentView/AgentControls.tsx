import { useState, useRef, useEffect } from "react";
import type { EffortLevel, AgentPermissionMode } from "../../lib/types";

interface Props {
  model: string;
  effort: EffortLevel;
  permissionMode: AgentPermissionMode;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
}

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

const MODELS = [
  { value: "", label: "Default (Opus 4.7)" },
  { value: "claude-opus-4-7", label: "Opus 4.7" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-opus-4-6", label: "Opus 4.6" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

const PERMISSION_MODES: {
  value: AgentPermissionMode;
  label: string;
  description: string;
}[] = [
  {
    value: "default",
    label: "Default",
    description: "Ask before file edits and shell commands",
  },
  {
    value: "acceptEdits",
    label: "Accept Edits",
    description: "Auto-allow file edits, ask for shell commands",
  },
  {
    value: "bypassPermissions",
    label: "Allow All",
    description: "Auto-allow everything without prompting",
  },
  {
    value: "plan",
    label: "Plan Only",
    description: "Read-only analysis, no modifications",
  },
];

export function AgentControls({
  model,
  effort,
  permissionMode,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 pb-0 pt-2 border-t border-border-primary bg-bg-secondary text-xs shrink-0">
      {/* Model selector — custom dropdown */}
      <ModelPicker model={model} onModelChange={onModelChange} />

      {/* Effort selector */}
      <div className="flex items-center rounded-md overflow-hidden border border-border-primary bg-bg-tertiary">
        {EFFORT_LEVELS.map((level) => (
          <button
            key={level}
            className={`px-2 py-1 text-[11px] capitalize transition-colors ${
              effort === level
                ? "bg-accent text-white"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            onClick={() => onEffortChange(level)}
            title={`Set effort to ${level}`}
          >
            {level}
          </button>
        ))}
      </div>

      {/* Permission mode picker */}
      <PermissionModePicker
        mode={permissionMode}
        onModeChange={onPermissionModeChange}
      />

      {permissionMode === "plan" && (
        <div className="ml-1 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-[11px] text-warning">
          <span>Plan mode active</span>
          <button
            className="rounded border border-warning/35 bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium hover:bg-warning/25"
            onClick={() => onPermissionModeChange("default")}
            title="Exit plan mode and return to default permission handling"
          >
            Exit to Default
          </button>
        </div>
      )}
    </div>
  );
}

/** Custom model picker that looks like a button / pill instead of a native <select>. */
function ModelPicker({
  model,
  onModelChange,
}: {
  model: string;
  onModelChange: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = MODELS.find((m) => m.value === model) ?? MODELS[0];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-[11px]"
        onClick={() => setOpen(!open)}
        title="Select model"
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1v4M4.5 3L8 5l3.5-2M1 6l7 4 7-4M1 10l7 4 7-4" />
        </svg>
        {selected.label}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[140px] bg-bg-secondary border border-border-primary rounded-md shadow-lg overflow-hidden z-50">
          {MODELS.map((m) => (
            <button
              key={m.value}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                m.value === model
                  ? "bg-accent/10 text-accent"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
              onClick={() => {
                onModelChange(m.value);
                setOpen(false);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Permission mode picker — dropdown styled like ModelPicker. */
function PermissionModePicker({
  mode,
  onModeChange,
}: {
  mode: AgentPermissionMode;
  onModeChange: (mode: AgentPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected =
    PERMISSION_MODES.find((m) => m.value === mode) ?? PERMISSION_MODES[0];
  const isHighlight = mode === "bypassPermissions" || mode === "plan";

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md border transition-colors text-[11px] ${
          isHighlight
            ? "border-accent bg-accent/10 text-accent"
            : "border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        }`}
        onClick={() => setOpen(!open)}
        title={selected.description}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="7" width="10" height="7" rx="1.5" />
          <path d="M5 7V5a3 3 0 0 1 6 0v2" />
        </svg>
        {selected.label}
        <svg
          width="8"
          height="8"
          viewBox="0 0 8 8"
          fill="none"
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path
            d="M1.5 3L4 5.5 6.5 3"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[170px] bg-bg-secondary border border-border-primary rounded-md shadow-lg overflow-hidden z-50">
          {PERMISSION_MODES.map((m) => (
            <button
              key={m.value}
              className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                m.value === mode
                  ? "bg-accent/10 text-accent"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
              onClick={() => {
                onModeChange(m.value);
                setOpen(false);
              }}
              title={m.description}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
