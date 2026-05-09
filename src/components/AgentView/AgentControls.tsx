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
  /** Whether the backend badge is toggleable (true when session hasn't started). */
  canToggleBackend?: boolean;
  /** Callback to toggle between Pi and Claude backends. */
  onBackendToggle?: () => void;
}

export const CLAUDE_EFFORT_LEVELS: Array<{ value: EffortLevel; label: string }> = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export const PI_EFFORT_LEVELS: Array<{ value: EffortLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
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
  canToggleBackend,
  onBackendToggle,
}: Props) {
  const supports1M = !isPiBackend && modelSupports1MContext(model);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 pb-0 pt-2 border-t border-border-primary bg-bg-secondary text-xs shrink-0">
      {/* Backend badge — always visible, toggleable before session starts */}
      <Tooltip
        text={
          canToggleBackend
            ? `Switch to ${isPiBackend ? "Claude" : "Pi"} backend`
            : `Using ${isPiBackend ? "Pi" : "Claude"} backend`
        }
        side="top"
      >
        <button
          className={`px-2 py-1 rounded-md text-[11px] font-semibold uppercase border transition-colors ${
            isPiBackend
              ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
              : "bg-orange-500/10 text-orange-400 border-orange-500/20"
          } ${canToggleBackend ? "cursor-pointer hover:brightness-125" : "cursor-default opacity-75"}`}
          onClick={canToggleBackend ? onBackendToggle : undefined}
          disabled={!canToggleBackend}
        >
          {isPiBackend ? "Pi" : "Cl"}
        </button>
      </Tooltip>

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

      {/* Effort selector — custom dropdown */}
      <EffortPicker effort={effort} onEffortChange={onEffortChange} isPiBackend={isPiBackend} />

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

function ModelPickerRow({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="w-full flex items-center gap-2 rounded-md border border-border-primary bg-bg-tertiary/60 px-2.5 py-2 text-left transition-colors hover:bg-bg-hover"
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-wide text-text-tertiary">{label}</div>
        <div className="truncate text-[11px] text-text-primary">{value}</div>
      </div>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0 text-text-tertiary">
        <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

export function ModelPicker({
  model,
  onModelChange,
  availableModels,
  isPiBackend,
  inline,
}: {
  model: string;
  onModelChange: (model: string) => void;
  availableModels?: SupportedModel[];
  isPiBackend?: boolean;
  /** Render the list directly without a trigger button / dropdown wrapper. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"main" | "provider" | "model">("main");
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const [customInput, setCustomInput] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const configuredProviders = useAppStore((s) => s.appSettings?.pi_configured_providers ?? []);

  const MODELS = availableModels && availableModels.length > 0 ? availableModels : CLAUDE_MODELS;
  const matchedPreset = MODELS.find((m) =>
    m.value === model || (m.provider && `${m.provider}/${m.value}` === model)
  );
  const providerChoices = isPiBackend
    ? (configuredProviders.filter((provider): provider is string => Boolean(provider)).length > 0
      ? configuredProviders.filter((provider): provider is string => Boolean(provider))
      : [...new Set(MODELS.map((candidate) => candidate.provider).filter((provider): provider is string => Boolean(provider)))])
    : [];
  const currentProvider = isPiBackend
    ? (model.includes("/")
      ? model.split("/")[0]
      : matchedPreset?.provider ?? providerChoices[0] ?? "anthropic")
    : "";
  const currentModelId = isPiBackend && model.includes("/") ? model.split("/").slice(1).join("/") : model;
  const displayLabel = matchedPreset?.label ?? currentModelId ?? MODELS[0]?.label ?? "SDK default";
  const currentProviderLabel = currentProvider ? fmtProvider(currentProvider) : "";

  useEffect(() => {
    if (!open || inline) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setPanel("main");
        setCustomInput(false);
        setExpandedProvider(null);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, inline]);

  useEffect(() => {
    if (!open) {
      setPanel("main");
      setCustomInput(false);
      setExpandedProvider(null);
      setSearch("");
    }
  }, [open]);

  useEffect(() => {
    if (customInput && inputRef.current) inputRef.current.focus();
  }, [customInput]);

  useEffect(() => {
    const shouldFocusSearch = inline || (open && panel === "model");
    if (shouldFocusSearch && !customInput && searchRef.current) searchRef.current.focus();
  }, [inline, open, panel, customInput]);

  const filterModel = (candidate: SupportedModel) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return candidate.label.toLowerCase().includes(q)
      || candidate.value.toLowerCase().includes(q)
      || (candidate.provider && candidate.provider.toLowerCase().includes(q));
  };

  const usePiGrouped = isPiBackend && configuredProviders.length > 0;
  const providerGroups = usePiGrouped
    ? configuredProviders.map((provider) => ({
        provider,
        models: MODELS.filter((candidate) => candidate.provider === provider && filterModel(candidate)),
      })).filter((group) => group.models.length > 0)
    : [];
  const filteredModels = search ? MODELS.filter(filterModel) : MODELS;
  const currentProviderModels = isPiBackend
    ? MODELS.filter((candidate) => candidate.provider === currentProvider && filterModel(candidate))
    : filteredModels;

  useEffect(() => {
    if (inline && usePiGrouped && currentProvider && !search) setExpandedProvider(currentProvider);
  }, [inline, usePiGrouped, currentProvider, search]);

  useEffect(() => {
    if (inline && search && usePiGrouped && providerGroups.length > 0) {
      setExpandedProvider(providerGroups[0].provider);
    }
  }, [inline, search, usePiGrouped, providerGroups]);

  const closeMenu = () => {
    setOpen(false);
    setPanel("main");
    setCustomInput(false);
    setExpandedProvider(null);
    setSearch("");
  };

  const handleSelect = (value: string) => {
    onModelChange(value);
    if (!inline) closeMenu();
  };

  const handleProviderSelect = (provider: string) => {
    const providerModels = MODELS.filter((candidate) => candidate.provider === provider);
    const nextModelId = provider === currentProvider
      ? currentModelId
      : providerModels.find((candidate) => candidate.value === currentModelId)?.value ?? providerModels[0]?.value ?? currentModelId;
    if (nextModelId) {
      handleSelect(`${provider}/${nextModelId}`);
    } else {
      closeMenu();
    }
  };

  const searchInput = !customInput && (
    <div className="px-2 pt-1.5 pb-1 border-b border-border-primary">
      <input
        ref={searchRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search models..."
        className="w-full px-2 py-1 text-[11px] bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
      />
    </div>
  );

  const customModelFooter = !search && (
    <>
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
                handleSelect(customValue.trim());
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
    </>
  );

  const inlineListContent = (
    <>
      {usePiGrouped ? (
        providerGroups.length > 0 ? providerGroups.map((group) => {
          const isExpanded = expandedProvider === group.provider || !!search;
          return (
            <div key={group.provider}>
              <button
                className={`w-full flex items-center justify-between px-3 py-1.5 text-[11px] font-medium transition-colors ${
                  currentProvider === group.provider
                    ? "text-accent"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
                onClick={() => setExpandedProvider(isExpanded && !search ? null : group.provider)}
              >
                <span>{fmtProvider(group.provider)}</span>
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${isExpanded ? "rotate-180" : ""}`}>
                  <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {isExpanded && (
                <div className="pb-1">
                  {group.models.map((candidate) => {
                    const isActive = candidate.value === model || `${candidate.provider}/${candidate.value}` === model;
                    return (
                      <button
                        key={candidate.value}
                        className={`w-full text-left pl-6 pr-3 py-1 text-[11px] transition-colors ${
                          isActive ? "bg-accent/10 text-accent" : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                        }`}
                        onClick={() => handleSelect(isPiBackend && candidate.provider ? `${candidate.provider}/${candidate.value}` : candidate.value)}
                      >
                        {candidate.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }) : (
          <div className="px-3 py-2 text-[11px] text-text-tertiary">{search ? "No matches" : "No models available"}</div>
        )
      ) : (
        filteredModels.length > 0 ? filteredModels.map((candidate) => (
          <button
            key={candidate.value}
            className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
              (candidate.value === model || (candidate.provider && `${candidate.provider}/${candidate.value}` === model))
                ? "bg-accent/10 text-accent"
                : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
            }`}
            onClick={() => handleSelect(isPiBackend && candidate.provider ? `${candidate.provider}/${candidate.value}` : candidate.value)}
          >
            {candidate.label}
          </button>
        )) : (
          <div className="px-3 py-2 text-[11px] text-text-tertiary">No matches</div>
        )
      )}
      {customModelFooter}
    </>
  );

  if (inline) {
    return (
      <div>
        {searchInput}
        <div className="max-h-[240px] overflow-y-auto">{inlineListContent}</div>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-[11px]"
        onClick={() => setOpen((value) => !value)}
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
        <div className="absolute bottom-full mb-1 left-0 w-56 bg-bg-secondary border border-border-primary rounded-md shadow-lg z-50 overflow-hidden">
          {panel === "main" ? (
            <div className="p-1.5 space-y-1.5">
              {isPiBackend && providerChoices.length > 0 && (
                <ModelPickerRow
                  label="Provider"
                  value={currentProviderLabel}
                  onClick={() => setPanel("provider")}
                />
              )}
              <ModelPickerRow
                label="Model"
                value={displayLabel}
                onClick={() => setPanel("model")}
              />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1.5">
                <button
                  type="button"
                  className="flex items-center justify-center w-6 h-6 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                  onClick={() => {
                    setPanel("main");
                    setCustomInput(false);
                    setSearch("");
                  }}
                  aria-label="Back"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M6.5 2L3.5 5l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className="min-w-0 flex-1 text-[11px] font-medium text-text-primary">
                  {panel === "provider" ? "Provider" : "Model"}
                </div>
                {panel === "model" && isPiBackend && (
                  <div className="max-w-[96px] truncate text-[10px] text-text-tertiary">{currentProviderLabel}</div>
                )}
              </div>

              {panel === "provider" ? (
                <div className="max-h-[240px] overflow-y-auto p-1.5">
                  {providerChoices.map((provider) => {
                    const active = provider === currentProvider;
                    return (
                      <button
                        key={provider}
                        type="button"
                        className={`w-full rounded-md px-2.5 py-2 text-left text-[11px] transition-colors ${
                          active
                            ? "bg-accent/10 text-accent"
                            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                        }`}
                        onClick={() => handleProviderSelect(provider)}
                      >
                        {fmtProvider(provider)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col max-h-[320px]">
                  {searchInput}
                  <div className="overflow-y-auto flex-1">
                    {currentProviderModels.length > 0 ? currentProviderModels.map((candidate) => {
                      const fullValue = isPiBackend && candidate.provider ? `${candidate.provider}/${candidate.value}` : candidate.value;
                      const isActive = fullValue === model || candidate.value === currentModelId;
                      return (
                        <button
                          key={fullValue}
                          type="button"
                          className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
                            isActive
                              ? "bg-accent/10 text-accent"
                              : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                          }`}
                          onClick={() => handleSelect(fullValue)}
                        >
                          {candidate.label}
                        </button>
                      );
                    }) : (
                      <div className="px-3 py-2 text-[11px] text-text-tertiary">{search ? "No matches" : "No models available"}</div>
                    )}
                    {customModelFooter}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function EffortPicker({
  effort,
  onEffortChange,
  isPiBackend,
  inline,
}: {
  effort: EffortLevel;
  onEffortChange: (effort: EffortLevel) => void;
  isPiBackend?: boolean;
  /** Render the list directly without a trigger button / dropdown wrapper. */
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const levels = isPiBackend ? PI_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
  const selected = levels.find((level) =>
    effort === level.value || (isPiBackend && effort === "max" && level.value === "xhigh")
  ) ?? levels[0];

  useEffect(() => {
    if (!open || inline) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, inline]);

  const handleSelect = (value: EffortLevel) => {
    onEffortChange(value);
    if (!inline) setOpen(false);
  };

  const listContent = levels.map((level) => {
    const isActive = effort === level.value || (isPiBackend && effort === "max" && level.value === "xhigh");
    return (
      <button
        key={level.value}
        className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
          isActive
            ? "bg-accent/10 text-accent"
            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
        }`}
        onClick={() => handleSelect(level.value)}
      >
        {level.label}
      </button>
    );
  });

  if (inline) {
    return <div className="max-h-[240px] overflow-y-auto">{listContent}</div>;
  }

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border-primary bg-bg-tertiary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors text-[11px]"
        onClick={() => setOpen(!open)}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 2v2M8 12v2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M2 8h2M12 8h2M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4" />
          <circle cx="8" cy="8" r="2.5" />
        </svg>
        {selected.label}
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[120px] bg-bg-secondary border border-border-primary rounded-md shadow-lg overflow-hidden z-50">
          {listContent}
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
