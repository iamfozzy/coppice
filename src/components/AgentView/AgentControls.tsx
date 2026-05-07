import { useState, useRef, useEffect } from "react";
import type { EffortLevel, AgentPermissionMode } from "../../lib/types";
import { CLAUDE_MODELS, modelSupports1MContext, type SupportedModel } from "../../lib/supportedModels";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../stores/appStore";

interface Props {
  model: string;
  effort: EffortLevel;
  permissionMode: AgentPermissionMode;
  conciseMode: boolean;
  chatMode: boolean;
  extendedContext: boolean;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onPermissionModeChange: (mode: AgentPermissionMode) => void;
  onConciseModeChange: (enabled: boolean) => void;
  onChatModeChange: (enabled: boolean) => void;
  onExtendedContextChange: (enabled: boolean) => void;
  /** Available models — dynamic for Pi backend, static for Claude. */
  availableModels?: SupportedModel[];
  /** Whether using Pi agent backend (affects which controls are shown). */
  isPiBackend?: boolean;
}

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

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
  conciseMode,
  chatMode,
  extendedContext,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onConciseModeChange,
  onChatModeChange,
  onExtendedContextChange,
  availableModels,
  isPiBackend,
}: Props) {
  const supports1M = !isPiBackend && modelSupports1MContext(model);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 pb-0 pt-2 border-t border-border-primary bg-bg-secondary text-xs shrink-0">
      {/* Model selector — custom dropdown */}
      <ModelPicker model={model} onModelChange={onModelChange} availableModels={availableModels} isPiBackend={isPiBackend} />

      {/* 1M context toggle — only visible for models that support it */}
      {supports1M && (
        <Tooltip text={extendedContext ? "1M context: ON — extended window enabled" : "1M context: OFF — using default 200K window"} side="top">
          <button
            className={`flex items-center gap-1 px-2.5 py-1 rounded-md border transition-colors text-[11px] ${
              extendedContext
                ? "border-accent bg-accent/10 text-accent"
                : "border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            onClick={() => onExtendedContextChange(!extendedContext)}
          >
            1M
          </button>
        </Tooltip>
      )}

      {/* Effort selector */}
      <div className="flex items-center rounded-md overflow-hidden border border-border-primary bg-bg-tertiary">
        {EFFORT_LEVELS.map((level) => (
          <Tooltip key={level} text={`Set effort to ${level}`} side="top">
            <button
              className={`px-2 py-1 text-[11px] capitalize transition-colors ${
                effort === level
                  ? "bg-accent text-white"
                  : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
              }`}
              onClick={() => onEffortChange(level)}
            >
              {level}
            </button>
          </Tooltip>
        ))}
      </div>

      {/* Permission mode picker */}
      <PermissionModePicker
        mode={permissionMode}
        onModeChange={onPermissionModeChange}
      />

      {/* Concise mode toggle */}
      <Tooltip text={conciseMode ? "Concise mode: ON — minimal tokens" : "Concise mode: OFF — normal responses"} side="top">
        <button
          className={`flex items-center gap-1 px-2.5 py-1 rounded-md border transition-colors text-[11px] ${
            conciseMode
              ? "border-accent bg-accent/10 text-accent"
              : "border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
          }`}
          onClick={() => onConciseModeChange(!conciseMode)}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 4h10M3 8h6M3 12h8" />
          </svg>
          Concise
        </button>
      </Tooltip>

      {/* Chat mode toggle */}
      <Tooltip text={chatMode ? "Chat mode: ON — no tools, lower cost" : "Chat mode: OFF — full agent with tools"} side="top">
        <button
          className={`flex items-center gap-1 px-2.5 py-1 rounded-md border transition-colors text-[11px] ${
            chatMode
              ? "border-accent bg-accent/10 text-accent"
              : "border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
          }`}
          onClick={() => onChatModeChange(!chatMode)}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 3h12v8H6l-3 3v-3H2z" />
          </svg>
          Chat
        </button>
      </Tooltip>

      {permissionMode === "plan" && (
        <Tooltip text="Exit plan mode and return to default permissions" side="top">
          <button
            className="ml-1 flex items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] text-warning hover:bg-warning/15 transition-colors"
            onClick={() => onPermissionModeChange("default")}
          >
            Plan mode — Exit
          </button>
        </Tooltip>
      )}
    </div>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", xai: "xAI", deepseek: "DeepSeek", openrouter: "OpenRouter",
  "amazon-bedrock": "Bedrock", "azure-openai-responses": "Azure OpenAI",
  "google-vertex": "Vertex AI", "github-copilot": "Copilot",
};
function fmtProvider(slug: string) {
  return PROVIDER_LABELS[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

function ModelPicker({
  model,
  onModelChange,
  availableModels,
  isPiBackend,
}: {
  model: string;
  onModelChange: (model: string) => void;
  availableModels?: SupportedModel[];
  isPiBackend?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const configuredProviders = useAppStore((s) => s.appSettings?.pi_configured_providers);

  const MODELS = availableModels && availableModels.length > 0 ? availableModels : CLAUDE_MODELS;
  const matchedPreset = MODELS.find((m) =>
    m.value === model || (m.provider && `${m.provider}/${m.value}` === model)
  );
  const displayLabel = matchedPreset?.label ?? model ?? MODELS[0].label;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setCustomInput(false);
        setExpandedProvider(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (customInput && inputRef.current) inputRef.current.focus();
  }, [customInput]);

  const usePiGrouped = isPiBackend && configuredProviders && configuredProviders.length > 0;

  const providerGroups = usePiGrouped
    ? configuredProviders!.map((p) => ({
        provider: p,
        models: MODELS.filter((m) => m.provider === p),
      })).filter((g) => g.models.length > 0)
    : [];

  const currentProvider = model.includes("/") ? model.split("/")[0] : matchedPreset?.provider;

  useEffect(() => {
    if (open && usePiGrouped && currentProvider) setExpandedProvider(currentProvider);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-[11px]"
        onClick={() => setOpen(!open)}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1v4M4.5 3L8 5l3.5-2M1 6l7 4 7-4M1 10l7 4 7-4" />
        </svg>
        {displayLabel}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[200px] max-h-[320px] overflow-y-auto bg-bg-secondary border border-border-primary rounded-md shadow-lg z-50">
          {usePiGrouped ? (
            <>
              {providerGroups.map((g) => {
                const isExpanded = expandedProvider === g.provider;
                return (
                  <div key={g.provider}>
                    <button
                      className={`w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium transition-colors ${
                        currentProvider === g.provider
                          ? "text-accent"
                          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                      }`}
                      onClick={() => setExpandedProvider(isExpanded ? null : g.provider)}
                    >
                      <span>{fmtProvider(g.provider)}</span>
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}>
                        <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                    {isExpanded && (
                      <div className="pb-1">
                        {g.models.map((m) => {
                          const isActive = m.value === model || `${m.provider}/${m.value}` === model;
                          return (
                            <button
                              key={m.value}
                              className={`w-full text-left pl-6 pr-3 py-1 text-[11px] transition-colors ${
                                isActive ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                              }`}
                              onClick={() => {
                                onModelChange(m.provider ? `${m.provider}/${m.value}` : m.value);
                                setOpen(false);
                                setExpandedProvider(null);
                              }}
                            >
                              {m.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            MODELS.map((m) => (
              <button
                key={m.value}
                className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                  (m.value === model || (m.provider && `${m.provider}/${m.value}` === model))
                    ? "bg-accent/10 text-accent"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
                onClick={() => {
                  onModelChange(m.provider ? `${m.provider}/${m.value}` : m.value);
                  setOpen(false);
                }}
              >
                {m.label}
              </button>
            ))
          )}
          <div className="border-t border-border-primary my-0.5" />
          {customInput ? (
            <div className="px-2 py-1.5">
              <input
                ref={inputRef}
                type="text"
                value={customValue}
                onChange={(e) => setCustomValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && customValue.trim()) {
                    onModelChange(customValue.trim());
                    setOpen(false);
                    setCustomInput(false);
                    setCustomValue("");
                  }
                  if (e.key === "Escape") {
                    setCustomInput(false);
                    setCustomValue("");
                  }
                }}
                placeholder="provider/model-id"
                className="w-full px-2 py-1 text-[11px] bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
              />
              <p className="mt-1 text-[9px] text-text-tertiary">Enter to confirm</p>
            </div>
          ) : (
            <button
              className="w-full text-left px-3 py-1.5 text-[11px] text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
              onClick={() => {
                setCustomInput(true);
                setCustomValue(matchedPreset ? "" : model);
              }}
            >
              Custom model...
            </button>
          )}
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
