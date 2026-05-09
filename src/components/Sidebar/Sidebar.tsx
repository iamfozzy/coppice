import { useEffect, useRef, useCallback, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import type { AgentBackend } from "../../lib/types";
import { CLAUDE_MODELS, type SupportedModel } from "../../lib/supportedModels";
import { ProjectTree } from "./ProjectTree";
import { ScratchpadNode } from "./ScratchpadNode";
import { ChangesPanel } from "./ChangesPanel";
import { SidebarRunners } from "./SidebarRunners";
import { Tooltip } from "../ui/Tooltip";
import { TileViewToggleButton } from "../ui/TileViewToggleButton";
import { AppInfoButton } from "../ui/AppInfoButton";

type HeaderOption = {
  value: string;
  label: string;
  hint?: string;
};

export function Sidebar() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const openAppSettings = useAppStore((s) => s.openAppSettings);
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const showTileView = useAppStore((s) => s.showTileView);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const appSettings = useAppStore((s) => s.appSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setDefaultAgentBackend = useAppStore((s) => s.setDefaultAgentBackend);
  const setAgentBackend = useAppStore((s) => s.setAgentBackend);
  const setAgentModel = useAppStore((s) => s.setAgentModel);
  const piAvailableModels = useAppStore((s) => s.piAvailableModels);
  const ensurePiModelsLoaded = useAppStore((s) => s.ensurePiModelsLoaded);

  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const [switchingBackend, setSwitchingBackend] = useState(false);

  const currentBackend = appSettings?.agent_backend ?? "claude";
  const currentClaudeModel = appSettings?.agent_default_model || "";
  const currentClaudePreset = CLAUDE_MODELS.find((model) => model.value === currentClaudeModel);
  const claudeModelLabel = currentClaudePreset?.label || currentClaudeModel || "SDK default";
  const claudeModelOptions: HeaderOption[] = [
    ...(currentClaudeModel && !currentClaudePreset
      ? [{ value: currentClaudeModel, label: currentClaudeModel, hint: "Custom model" }]
      : []),
    { value: "", label: "SDK default", hint: "Use the Claude SDK default model" },
    ...CLAUDE_MODELS.map((model) => ({ value: model.value, label: model.label })),
  ];

  const currentPiProvider: string = appSettings?.pi_default_provider || appSettings?.pi_configured_providers?.[0] || "anthropic";
  const configuredPiProviders: string[] = (() => {
    const fromSettings = appSettings?.pi_configured_providers?.filter((provider): provider is string => Boolean(provider)) ?? [];
    if (fromSettings.length > 0) {
      return fromSettings.includes(currentPiProvider) ? fromSettings : [...fromSettings, currentPiProvider];
    }
    const fromSdk = [...new Set(
      piAvailableModels
        .map((model) => model.provider)
        .filter((provider): provider is string => Boolean(provider))
    )];
    return fromSdk.length > 0 ? fromSdk : [currentPiProvider];
  })();
  const currentPiModelId = stripPiProviderPrefix(appSettings?.pi_default_model || "");
  const currentPiModels = getPiModelsForProvider(currentPiProvider, piAvailableModels);
  const currentPiPreset = currentPiModels.find((model) => model.value === currentPiModelId);
  const piModelLabel = currentPiPreset?.label || currentPiModelId || "Select model";
  const piProviderOptions: HeaderOption[] = configuredPiProviders.map((provider) => ({
    value: provider,
    label: formatPiProvider(provider),
  }));
  const piModelOptions: HeaderOption[] = [
    ...(currentPiModelId && !currentPiPreset
      ? [{ value: currentPiModelId, label: currentPiModelId, hint: "Custom model" }]
      : []),
    ...currentPiModels.map((model) => ({
      value: model.value,
      label: model.label,
    })),
  ];

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (currentBackend !== "pi" || piAvailableModels.length > 0) return;
    ensurePiModelsLoaded().catch(() => {});
  }, [currentBackend, piAvailableModels.length, ensurePiModelsLoaded]);

  const syncActiveIdleAgentModel = useCallback((backend: AgentBackend, model: string) => {
    const s = useAppStore.getState();
    const wtId = s.selectedWorktreeId;
    const activeTabId = wtId ? s.activeTabByWorktree[wtId] : null;
    const activeTab = wtId && activeTabId ? s.tabsByWorktree[wtId]?.find((tab) => tab.id === activeTabId) : null;
    const activeSession = activeTabId ? s.agentSessionByTab[activeTabId] : null;
    if (
      activeTabId
      && activeTab?.type === "agent"
      && activeSession
      && activeSession.backend === backend
      && activeSession.status === "idle"
      && activeSession.messages.length === 0
      && !activeSession.sdkSessionId
    ) {
      setAgentModel(activeTabId, model);
    }
  }, [setAgentModel]);

  const handleBackendToggle = useCallback(async () => {
    const settings = useAppStore.getState().appSettings;
    if (!settings) return;
    const nextBackend: AgentBackend = settings.agent_backend === "pi" ? "claude" : "pi";
    setSwitchingBackend(true);
    try {
      await setDefaultAgentBackend(nextBackend);
      const s = useAppStore.getState();
      const wtId = s.selectedWorktreeId;
      const activeTabId = wtId ? s.activeTabByWorktree[wtId] : null;
      const activeTab = wtId && activeTabId ? s.tabsByWorktree[wtId]?.find((tab) => tab.id === activeTabId) : null;
      const activeSession = activeTabId ? s.agentSessionByTab[activeTabId] : null;
      if (
        activeTabId
        && activeTab?.type === "agent"
        && activeSession
        && activeSession.status === "idle"
        && activeSession.messages.length === 0
        && !activeSession.sdkSessionId
      ) {
        setAgentBackend(
          activeTabId,
          nextBackend,
          nextBackend === "pi" ? settings.pi_default_model || "" : settings.agent_default_model || "",
        );
      }
    } finally {
      setSwitchingBackend(false);
    }
  }, [setDefaultAgentBackend, setAgentBackend]);

  const handleClaudeModelSelect = useCallback(async (model: string) => {
    const settings = useAppStore.getState().appSettings;
    if (!settings || settings.agent_default_model === model) return;
    await saveSettings({ ...settings, agent_default_model: model });
    syncActiveIdleAgentModel("claude", model);
  }, [saveSettings, syncActiveIdleAgentModel]);

  const handlePiProviderSelect = useCallback(async (provider: string) => {
    const settings = useAppStore.getState().appSettings;
    if (!settings) return;
    const providerModels = getPiModelsForProvider(provider, useAppStore.getState().piAvailableModels);
    const nextModel = providerModels[0] ? `${provider}/${providerModels[0].value}` : "";
    if (settings.pi_default_provider === provider && settings.pi_default_model === nextModel) return;
    await saveSettings({
      ...settings,
      pi_default_provider: provider,
      pi_default_model: nextModel,
    });
    syncActiveIdleAgentModel("pi", nextModel);
  }, [saveSettings, syncActiveIdleAgentModel]);

  const handlePiModelSelect = useCallback(async (model: string) => {
    const settings = useAppStore.getState().appSettings;
    if (!settings) return;
    const provider = settings.pi_default_provider || settings.pi_configured_providers?.[0] || "anthropic";
    const nextModel = `${provider}/${model}`;
    if (settings.pi_default_model === nextModel) return;
    await saveSettings({
      ...settings,
      pi_default_provider: provider,
      pi_default_model: nextModel,
    });
    syncActiveIdleAgentModel("pi", nextModel);
  }, [saveSettings, syncActiveIdleAgentModel]);

  const onMouseDown = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.body.dataset.resizingSidebar = "1";

    let pendingWidth: number | null = null;
    let rafId: number | null = null;

    const flush = () => {
      rafId = null;
      if (pendingWidth !== null && sidebarRef.current) {
        sidebarRef.current.style.width = `${pendingWidth}px`;
      }
      pendingWidth = null;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      pendingWidth = Math.max(310, Math.min(500, e.clientX));
      if (rafId === null) {
        rafId = requestAnimationFrame(flush);
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      delete document.body.dataset.resizingSidebar;
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      const finalWidth = Math.max(310, Math.min(500, e.clientX));
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${finalWidth}px`;
      }
      setSidebarWidth(finalWidth);
      window.dispatchEvent(new Event("sidebar-resize-end"));
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [setSidebarWidth]);

  const backendTooltip = currentBackend === "pi" ? "Switch to CL" : "Switch to PI";
  const modelTooltip = currentBackend === "pi"
    ? `${formatPiProvider(currentPiProvider)} · ${piModelLabel}`
    : claudeModelLabel;

  return (
    <aside
      ref={sidebarRef}
      className="flex flex-col bg-bg-secondary border-r border-border-primary h-full relative no-select"
      style={{ width: sidebarWidth }}
    >
      <div className="flex items-center justify-between gap-3 px-3 py-2 h-12 border-b border-border-primary shrink-0">
        <div className="flex items-center gap-2 min-w-0 shrink-0">
          <div className="flex items-center gap-1.5 shrink-0">
            <TileViewToggleButton
              active={showTileView}
              onClick={toggleTileView}
              tooltip="Tile view"
              align="left"
            />
          </div>

          <div className="w-px h-5 bg-border-primary/70 shrink-0" />

          <div className="flex items-center gap-1.5 shrink-0">
            <Tooltip text={backendTooltip} align="right">
              <button
                type="button"
                onClick={() => void handleBackendToggle()}
                disabled={!appSettings || switchingBackend}
                className={`h-7 min-w-8 px-2.5 flex items-center justify-center rounded-md text-[11px] font-semibold uppercase border transition-colors ${currentBackend === "pi" ? "bg-purple-500/10 text-purple-400 border-purple-500/20" : "bg-orange-500/10 text-orange-400 border-orange-500/20"} ${appSettings && !switchingBackend ? "hover:brightness-125" : ""} disabled:opacity-50`}
              >
                {currentBackend === "pi" ? "Pi" : "Cl"}
              </button>
            </Tooltip>

            <ModelConfigPopover
              tone={currentBackend}
              backend={currentBackend}
              disabled={!appSettings || switchingBackend}
              tooltip={modelTooltip}
              dropdownAlign="left"
              providerLabel={formatPiProvider(currentPiProvider)}
              providerValue={currentPiProvider}
              providerOptions={piProviderOptions}
              onProviderSelect={handlePiProviderSelect}
              modelLabel={currentBackend === "pi" ? piModelLabel : claudeModelLabel}
              modelValue={currentBackend === "pi" ? currentPiModelId : currentClaudeModel}
              modelOptions={currentBackend === "pi" ? piModelOptions : claudeModelOptions}
              onModelSelect={currentBackend === "pi" ? handlePiModelSelect : handleClaudeModelSelect}
            />
          </div>

          <div className="w-px h-5 bg-border-primary/70 shrink-0" />

          <Tooltip text="Add project" align="right">
            <button
              onClick={() => openProjectSettings("new")}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M7 1v12M1 7h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </Tooltip>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <AppInfoButton align="right" />
          <Tooltip text="Settings" align="right">
            <button
              onClick={openAppSettings}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path
                  d="M5.7 1h2.6l.4 1.5a4.5 4.5 0 011.1.6l1.5-.5 1.3 2.3-1.1 1a4.5 4.5 0 010 1.2l1.1 1-1.3 2.3-1.5-.5a4.5 4.5 0 01-1.1.6L8.3 13H5.7l-.4-1.5a4.5 4.5 0 01-1.1-.6l-1.5.5-1.3-2.3 1.1-1a4.5 4.5 0 010-1.2l-1.1-1L2.7 3.6l1.5.5a4.5 4.5 0 011.1-.6L5.7 1z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
                <circle cx="7" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        <ScratchpadNode />
        <ProjectTree />
      </div>

      <ChangesPanel />
      <SidebarRunners />

      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30 active:bg-accent/50"
        onMouseDown={onMouseDown}
      />
    </aside>
  );
}

function ModelConfigPopover({
  tone,
  backend,
  disabled,
  tooltip,
  dropdownAlign = "right",
  providerLabel,
  providerValue,
  providerOptions,
  onProviderSelect,
  modelLabel,
  modelValue,
  modelOptions,
  onModelSelect,
}: {
  tone: AgentBackend;
  backend: AgentBackend;
  disabled?: boolean;
  tooltip?: string;
  dropdownAlign?: "left" | "right";
  providerLabel: string;
  providerValue: string;
  providerOptions: HeaderOption[];
  onProviderSelect: (value: string) => void | Promise<void>;
  modelLabel: string;
  modelValue: string;
  modelOptions: HeaderOption[];
  onModelSelect: (value: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toneButtonClass = tone === "pi"
    ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
    : "bg-orange-500/10 text-orange-400 border-orange-500/20";

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const button = (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      disabled={disabled}
      className={`w-7 h-7 flex items-center justify-center rounded-md border transition-colors ${toneButtonClass} ${disabled ? "opacity-50" : "hover:brightness-125"}`}
      aria-label="Default model"
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1v4M4.5 3L8 5l3.5-2M1 6l7 4 7-4M1 10l7 4 7-4" />
      </svg>
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      {tooltip ? <Tooltip text={tooltip}>{button}</Tooltip> : button}
      {open && (
        <div className={`absolute top-8 z-20 w-60 rounded-md border border-border-primary bg-bg-secondary shadow-xl p-1.5 ${dropdownAlign === "left" ? "left-0" : "right-0"}`}>
          <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border-primary/60 bg-bg-primary/40 px-2 py-1.5">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-tertiary">
              <path d="M8 1v4M4.5 3L8 5l3.5-2M1 6l7 4 7-4M1 10l7 4 7-4" />
            </svg>
            <div className="min-w-0 text-[10px] font-medium text-text-primary truncate">
              {backend === "pi" ? `${providerLabel} · ${modelLabel}` : modelLabel}
            </div>
          </div>

          {backend === "pi" && (
            <InlineChipGroup
              label="Provider"
              tone={tone}
              selectedValue={providerValue}
              options={providerOptions}
              onSelect={onProviderSelect}
            />
          )}

          <InlineOptionList
            label="Model"
            tone={tone}
            selectedValue={modelValue}
            options={modelOptions}
            onSelect={(value) => {
              setOpen(false);
              return onModelSelect(value);
            }}
            emptyLabel={backend === "pi" ? "No models available" : "SDK default"}
          />
        </div>
      )}
    </div>
  );
}

function InlineChipGroup({
  label,
  tone,
  selectedValue,
  options,
  onSelect,
}: {
  label: string;
  tone: AgentBackend;
  selectedValue: string;
  options: HeaderOption[];
  onSelect: (value: string) => void | Promise<void>;
}) {
  const toneActiveClass = tone === "pi"
    ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
    : "border-orange-500/30 bg-orange-500/10 text-orange-400";

  return (
    <div className="mb-2">
      <label className="mb-1 block px-1 text-[9px] uppercase tracking-wide text-text-tertiary">{label}</label>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = option.value === selectedValue;
          return (
            <button
              key={option.value}
              type="button"
              title={option.hint ? `${option.label} — ${option.hint}` : option.label}
              onClick={() => { void onSelect(option.value); }}
              className={`max-w-full rounded-md border px-2 py-1 text-[10px] transition-colors ${active ? toneActiveClass : "border-border-primary bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
            >
              <span className="block truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InlineOptionList({
  label,
  tone,
  selectedValue,
  options,
  onSelect,
  emptyLabel,
}: {
  label: string;
  tone: AgentBackend;
  selectedValue: string;
  options: HeaderOption[];
  onSelect: (value: string) => void | Promise<void>;
  emptyLabel?: string;
}) {
  const toneActiveClass = tone === "pi"
    ? "bg-purple-500/10 text-purple-400"
    : "bg-orange-500/10 text-orange-400";

  return (
    <div>
      <label className="mb-1 block px-1 text-[9px] uppercase tracking-wide text-text-tertiary">{label}</label>
      <div className="max-h-48 overflow-y-auto rounded-md border border-border-primary bg-bg-tertiary/40 py-0.5">
        {options.length > 0 ? options.map((option) => {
          const active = option.value === selectedValue;
          return (
            <button
              key={option.value || "__empty__"}
              type="button"
              title={option.hint ? `${option.label} — ${option.hint}` : option.label}
              onClick={() => { void onSelect(option.value); }}
              className={`w-full px-2.5 py-1 text-left transition-colors ${active ? toneActiveClass : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
            >
              <div className="truncate text-[10px] font-medium">{option.label || emptyLabel || "Select"}</div>
              {option.hint && (
                <div className="truncate text-[9px] text-text-tertiary">{option.hint}</div>
              )}
            </button>
          );
        }) : (
          <div className="px-2.5 py-1.5 text-[10px] text-text-tertiary">{emptyLabel || "No options"}</div>
        )}
      </div>
    </div>
  );
}

function stripPiProviderPrefix(value: string): string {
  return value.includes("/") ? value.split("/").slice(1).join("/") : value;
}

function formatPiProvider(slug: string): string {
  const overrides: Record<string, string> = {
    openai: "OpenAI",
    xai: "xAI",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    "amazon-bedrock": "Bedrock",
    "azure-openai-responses": "Azure OpenAI",
    "google-vertex": "Vertex AI",
    "github-copilot": "Copilot",
    "cloudflare-ai-gateway": "CF Gateway",
    "cloudflare-workers-ai": "CF Workers",
    "openai-codex": "Codex",
    "vercel-ai-gateway": "Vercel AI",
  };
  return overrides[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

const PI_FALLBACK_MODELS: Record<string, SupportedModel[]> = {
  anthropic: [
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", provider: "anthropic", contextWindow: 200000, reasoning: true },
    { value: "claude-opus-4-20250515", label: "Claude Opus 4", provider: "anthropic", contextWindow: 200000, reasoning: true },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic", contextWindow: 200000, reasoning: true },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o", provider: "openai", contextWindow: 128000 },
    { value: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai", contextWindow: 128000 },
    { value: "o3", label: "o3", provider: "openai", contextWindow: 200000, reasoning: true },
    { value: "o4-mini", label: "o4 Mini", provider: "openai", contextWindow: 200000, reasoning: true },
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google", contextWindow: 1048576, reasoning: true },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google", contextWindow: 1048576, reasoning: true },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek", contextWindow: 65536 },
    { value: "deepseek-reasoner", label: "DeepSeek Reasoner", provider: "deepseek", contextWindow: 65536, reasoning: true },
  ],
  mistral: [
    { value: "mistral-large-latest", label: "Mistral Large", provider: "mistral", contextWindow: 131072 },
    { value: "codestral-latest", label: "Codestral", provider: "mistral", contextWindow: 262144 },
  ],
  groq: [
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", provider: "groq", contextWindow: 131072 },
  ],
  xai: [
    { value: "grok-3-fast", label: "Grok 3 Fast", provider: "xai", contextWindow: 131072, reasoning: true },
    { value: "grok-3-mini-fast", label: "Grok 3 Mini Fast", provider: "xai", contextWindow: 131072, reasoning: true },
  ],
  openrouter: [
    { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", provider: "openrouter", contextWindow: 200000 },
    { value: "openai/gpt-4o", label: "GPT-4o", provider: "openrouter", contextWindow: 128000 },
    { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", contextWindow: 1048576 },
  ],
};

function getPiModelsForProvider(provider: string, models: SupportedModel[]): SupportedModel[] {
  const sdkModels = models.filter((model) => model.provider === provider);
  return sdkModels.length > 0 ? sdkModels : (PI_FALLBACK_MODELS[provider] || []);
}
