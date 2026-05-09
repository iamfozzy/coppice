import { useEffect, useRef, useCallback, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import type { AgentBackend } from "../../lib/types";
import { CLAUDE_MODELS } from "../../lib/supportedModels";
import { ProjectTree } from "./ProjectTree";
import { ScratchpadNode } from "./ScratchpadNode";
import { ChangesPanel } from "./ChangesPanel";
import { SidebarRunners } from "./SidebarRunners";
import { Tooltip } from "../ui/Tooltip";
import { TileViewToggleButton } from "../ui/TileViewToggleButton";
import { AppInfoButton } from "../ui/AppInfoButton";
import { ModelConfigPopover, formatPiProvider, getPiModelsForProvider, stripPiProviderPrefix, type HeaderOption } from "../ui/AgentHeaderControls";

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

