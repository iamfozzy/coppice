import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useAppStore, type TabInfo } from "../../stores/appStore";
import { MessageList } from "../AgentView/MessageList";
import { AgentInputBar } from "../AgentView/AgentInputBar";
import { TerminalPanel } from "../Terminal/TerminalPanel";
import { CreateWorktreeModal } from "../Sidebar/CreateWorktreeModal";
import { Tooltip } from "../ui/Tooltip";
import { TileViewToggleButton } from "../ui/TileViewToggleButton";
import { McpStatusPopover, ModelConfigPopover, formatPiProvider, getPiModelsForProvider, stripPiProviderPrefix, type HeaderOption } from "../ui/AgentHeaderControls";
import { useAgentTabCloseConfirmation } from "../ui/useAgentTabCloseConfirmation";
import { CLAUDE_MODELS, modelSupports1MContext, type SupportedModel } from "../../lib/supportedModels";
import { CLAUDE_EFFORT_LEVELS, EffortPicker, ModelPicker, PI_EFFORT_LEVELS } from "../AgentView/AgentControls";
import * as commands from "../../lib/commands";
import type { AgentBackend, ImageAttachment, EffortLevel, AgentPermissionMode, Project } from "../../lib/types";
import { SCRATCHPAD_WORKTREE_ID } from "../../lib/types";
import { getDefaultSessionModeLabel, getDefaultSessionModeShortLabel, getNextDefaultSessionMode, isAgentDefaultSessionMode, resolveDefaultSessionMode } from "../../lib/defaultSessionMode";
import { DEFAULT_APP_FONT_SIZE, getScaledFontSize } from "../../lib/fontScale";
import { PermissionDialog } from "../AgentView/PermissionDialog";
import { AskUserDialog } from "../AgentView/AskUserDialog";
import { isPlanPermission } from "../AgentView/PlanApprovalDialog";

interface TileTab {
  tab: TabInfo;
  worktreeId: string;
  worktreeName: string;
  projectName: string;
}

/** Compute grid columns based on tile count. */
function computeCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  return Math.ceil(Math.sqrt(count));
}

let _tileMsgIdCounter = 0;
function nextTileMsgId() {
  return `tile-msg-${++_tileMsgIdCounter}-${Date.now()}`;
}


// ── Main TileView ──

export function TileView() {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const projects = useAppStore((s) => s.projects);
  const newDefaultSessionTab = useAppStore((s) => s.newDefaultSessionTab);

  const [creatingForProject, setCreatingForProject] = useState<string | null>(null);

  // Add a tab to an existing worktree using the app's default new-session setting.
  const handleAddExisting = useCallback((worktreeId: string, worktreePath: string) => {
    newDefaultSessionTab(worktreeId, worktreePath);
  }, [newDefaultSessionTab]);

  // Open CreateWorktreeModal for a project
  const handleCreateNew = useCallback((projectId: string) => {
    setCreatingForProject(projectId);
  }, []);

  const handleModalClose = useCallback(() => {
    setCreatingForProject(null);
  }, []);

  // Called by CreateWorktreeModal after a worktree is successfully created
  // and selected. Immediately creates the app's default session type for the tile view.
  const handleWorktreeCreated = useCallback((worktreeId: string) => {
    const state = useAppStore.getState();
    const path = state.getWorktreePath(worktreeId);
    if (path) {
      state.newDefaultSessionTab(worktreeId, path);
    }
  }, []);

  const tileTabs = useMemo<TileTab[]>(() => {
    const result: TileTab[] = [];
    // Include scratchpad agent tabs
    const spTabs = tabsByWorktree[SCRATCHPAD_WORKTREE_ID] ?? [];
    for (const tab of spTabs) {
      if (tab.type === "agent" || tab.type === "claude") {
        result.push({
          tab,
          worktreeId: SCRATCHPAD_WORKTREE_ID,
          worktreeName: "Home",
          projectName: "Scratchpad",
        });
      }
    }
    for (const project of projects) {
      const worktrees = worktreesByProject[project.id] ?? [];
      for (const wt of worktrees) {
        const tabs = tabsByWorktree[wt.id] ?? [];
        for (const tab of tabs) {
          if (tab.type === "agent" || tab.type === "claude") {
            result.push({
              tab,
              worktreeId: wt.id,
              worktreeName: wt.name,
              projectName: project.name,
            });
          }
        }
      }
    }
    return result;
  }, [tabsByWorktree, worktreesByProject, projects]);

  const cols = computeCols(tileTabs.length);
  const rows = Math.ceil(tileTabs.length / cols) || 1;
  const totalSlots = cols * rows;
  const hasEmptySlot = totalSlots > tileTabs.length;

  return (
    <div className="fixed inset-0 z-[100] bg-bg-primary overflow-hidden flex flex-col">
      {/* Header */}
      <TileHeader onAddExisting={handleAddExisting} onCreateNew={handleCreateNew} />

      {/* Grid */}
      <div
        className="flex-1 min-h-0 grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridAutoRows: "1fr",
          gap: "1px",
          background: "var(--color-border-primary, #333)",
        }}
      >
        {tileTabs.map((tile) => (
          <Tile key={tile.tab.id} tile={tile} />
        ))}
        {hasEmptySlot && <AddTileCell onAddExisting={handleAddExisting} onCreateNew={handleCreateNew} />}
      </div>

      {/* Create worktree modal — renders over the tile view */}
      {creatingForProject && (
        <CreateWorktreeModal
          projectId={creatingForProject}
          onClose={handleModalClose}
          onCreated={handleWorktreeCreated}
        />
      )}
    </div>
  );
}

// ── Header bar ──

interface TilePickerProps {
  onAddExisting: (worktreeId: string, worktreePath: string) => void;
  onCreateNew: (projectId: string) => void;
}

function TileHeader({ onAddExisting, onCreateNew }: TilePickerProps) {
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const openAppSettings = useAppStore((s) => s.openAppSettings);
  const appSettings = useAppStore((s) => s.appSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const setDefaultSessionMode = useAppStore((s) => s.setDefaultSessionMode);
  const setAgentBackend = useAppStore((s) => s.setAgentBackend);
  const setAgentModel = useAppStore((s) => s.setAgentModel);
  const piAvailableModels = useAppStore((s) => s.piAvailableModels);
  const ensurePiModelsLoaded = useAppStore((s) => s.ensurePiModelsLoaded);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const activeTabByWorktree = useAppStore((s) => s.activeTabByWorktree);
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const agentSessionByTab = useAppStore((s) => s.agentSessionByTab);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [switchingBackend, setSwitchingBackend] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const currentDefaultMode = resolveDefaultSessionMode(appSettings);
  const currentBackend: AgentBackend = currentDefaultMode === "pi" ? "pi" : "claude";
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
    if (currentBackend !== "pi" || piAvailableModels.length > 0) return;
    ensurePiModelsLoaded().catch(() => {});
  }, [currentBackend, piAvailableModels.length, ensurePiModelsLoaded]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

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
    const nextMode = getNextDefaultSessionMode(resolveDefaultSessionMode(settings));
    setSwitchingBackend(true);
    try {
      await setDefaultSessionMode(nextMode);
      if (isAgentDefaultSessionMode(nextMode)) {
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
            nextMode,
            nextMode === "pi" ? settings.pi_default_model || "" : settings.agent_default_model || "",
          );
        }
      }
    } finally {
      setSwitchingBackend(false);
    }
  }, [setDefaultSessionMode, setAgentBackend]);

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

  const backendTooltip = `Switch to ${getDefaultSessionModeLabel(getNextDefaultSessionMode(currentDefaultMode))}`;
  const modeButtonClass = currentDefaultMode === "terminal"
    ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
    : currentDefaultMode === "pi"
      ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
      : "bg-orange-500/10 text-orange-400 border-orange-500/20";
  const modelTooltip = currentBackend === "pi"
    ? `${formatPiProvider(currentPiProvider)} · ${piModelLabel}`
    : claudeModelLabel;
  const activeHeaderTabId = selectedWorktreeId ? activeTabByWorktree[selectedWorktreeId] ?? null : null;
  const activeHeaderTab = selectedWorktreeId && activeHeaderTabId
    ? tabsByWorktree[selectedWorktreeId]?.find((tab) => tab.id === activeHeaderTabId)
    : null;
  const activeHeaderSession = activeHeaderTab?.type === "agent" && activeHeaderTabId
    ? agentSessionByTab[activeHeaderTabId] ?? null
    : null;

  return (
    <div className="flex items-center justify-between h-12 px-3 py-2 shrink-0 bg-bg-secondary border-b border-border-primary gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <div className="flex items-center shrink-0">
          <TileViewToggleButton
            active
            onClick={toggleTileView}
            tooltip="Close tile view (Esc)"
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
              className={`h-7 min-w-8 px-2.5 flex items-center justify-center rounded-md text-[length:var(--app-font-11)] font-semibold uppercase border transition-colors ${modeButtonClass} ${appSettings && !switchingBackend ? "hover:brightness-125" : ""} disabled:opacity-50`}
            >
              {getDefaultSessionModeShortLabel(currentDefaultMode)}
            </button>
          </Tooltip>

          {currentDefaultMode !== "terminal" && (
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
          )}

          <McpStatusPopover
            configuredServers={appSettings?.mcp_servers ?? {}}
            sessionServers={activeHeaderSession?.mcpServers ?? []}
            disabled={!appSettings}
            dropdownAlign="left"
          />
        </div>

        <div className="w-px h-5 bg-border-primary/70 shrink-0" />

        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip text="Settings">
            <button
              onClick={openAppSettings}
              className="w-7 h-7 flex items-center justify-center rounded-md border border-border-primary/25 text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
          <Tooltip text="Add project">
            <button
              onClick={() => openProjectSettings("new")}
              className="w-7 h-7 flex items-center justify-center rounded-md border border-border-primary/25 text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="relative flex items-center shrink-0" ref={pickerRef}>
        <Tooltip text="Add tile" align="right">
          <button
            onClick={() => setPickerOpen((v) => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-md border border-border-primary/25 text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>

        {pickerOpen && (
          <TilePickerDropdown
            onAddExisting={(id, path) => { setPickerOpen(false); onAddExisting(id, path); }}
            onCreateNew={(id) => { setPickerOpen(false); onCreateNew(id); }}
            position="dropdown"
          />
        )}
      </div>
    </div>
  );
}

// ── Individual tile ──

function Tile({ tile }: { tile: TileTab }) {
  if (tile.tab.type === "claude") {
    return <ClaudeCliTile tile={tile} />;
  }
  return <AgentTile tile={tile} />;
}

function AgentTile({ tile }: { tile: TileTab }) {
  const { tab, worktreeId, worktreeName, projectName } = tile;
  const session = useAppStore((s) => s.agentSessionByTab[tab.id]);
  const claudeStatus = useAppStore((s) => s.claudeStatusByTab[tab.id] ?? null);
  const appSettings = useAppStore((s) => s.appSettings);
  const piAvailableModels = useAppStore((s) => s.piAvailableModels);
  const ensurePiModelsLoaded = useAppStore((s) => s.ensurePiModelsLoaded);
  const setAgentBackend = useAppStore((s) => s.setAgentBackend);

  const selectProject = useAppStore((s) => s.selectProject);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const clearClaudeIdleStatus = useAppStore((s) => s.clearClaudeIdleStatus);
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const { requestCloseTab, closeConfirmation } = useAgentTabCloseConfirmation();
  const appendMessage = useAppStore((s) => s.appendAgentMessage);
  const setStatus = useAppStore((s) => s.setAgentStatus);
  const pushQueuedMessage = useAppStore((s) => s.pushAgentQueuedMessage);
  const setModel = useAppStore((s) => s.setAgentModel);
  const setEffort = useAppStore((s) => s.setAgentEffort);
  const setPermissionMode = useAppStore((s) => s.setAgentPermissionMode);
  const setConciseMode = useAppStore((s) => s.setAgentConciseMode);
  const setChatMode = useAppStore((s) => s.setAgentChatMode);
  const setExtendedContext = useAppStore((s) => s.setAgentExtendedContext);
  const setPendingPermission = useAppStore((s) => s.setAgentPendingPermission);
  const setPendingQuestion = useAppStore((s) => s.setAgentPendingQuestion);

  const sessionId = tab.id;
  const cwd = tab.cwd;

  useEffect(() => {
    if (session?.backend !== "pi" || piAvailableModels.length > 0) return;
    ensurePiModelsLoaded().catch(() => {});
  }, [session?.backend, piAvailableModels.length, ensurePiModelsLoaded]);

  const clearTileNotification = useCallback(() => {
    clearClaudeIdleStatus(tab.id);
  }, [clearClaudeIdleStatus, tab.id]);

  const handleNavigate = useCallback(() => {
    const store = useAppStore.getState();
    for (const [projectId, worktrees] of Object.entries(store.worktreesByProject)) {
      if (worktrees.some((w) => w.id === worktreeId)) {
        selectProject(projectId);
        break;
      }
    }
    selectWorktree(worktreeId);
    setActiveTab(worktreeId, tab.id);
    toggleTileView();
  }, [worktreeId, tab.id, selectProject, selectWorktree, setActiveTab, toggleTileView]);

  const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
    if (!session) return;
    const msgId = nextTileMsgId();
    const imageNote = images?.length ? ` [${images.length} image${images.length > 1 ? "s" : ""} attached]` : "";

    if (session.status === "done" || session.status === "error" || session.status === "idle") {
      appendMessage(sessionId, {
        id: msgId,
        type: "user",
        content: text + imageNote,
        timestamp: Date.now(),
      });
      setStatus(sessionId, "thinking");

      const opts: Parameters<typeof commands.agentStart>[3] = {
        backend: session.backend,
        model: session.model || undefined,
        effort: session.effort || undefined,
        permissionMode: session.permissionMode || undefined,
        conciseMode: session.conciseMode || undefined,
        chatMode: session.chatMode || undefined,
        extendedContext: session.extendedContext || undefined,
        apiKey: appSettings?.agent_api_key || undefined,
        priorCost: session.cost ?? undefined,
        resume: session.sdkSessionId ?? undefined,
      };

      commands.agentStart(sessionId, cwd, text, opts, images).catch((err) => {
        appendMessage(sessionId, {
          id: nextTileMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
        setStatus(sessionId, "error");
      });
    } else if (session.status === "thinking" || session.status === "tool_use") {
      pushQueuedMessage(sessionId, text, images);
      appendMessage(sessionId, {
        id: msgId,
        type: "user",
        content: text + imageNote,
        isQueued: true,
        timestamp: Date.now(),
      });
    } else if (session.status === "waiting_input") {
      appendMessage(sessionId, {
        id: msgId,
        type: "user",
        content: text + imageNote,
        timestamp: Date.now(),
      });
      setStatus(sessionId, "thinking");
      commands.agentSendInput(sessionId, text, images).catch((err) => {
        appendMessage(sessionId, {
          id: nextTileMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
      });
    }
  }, [session, sessionId, cwd, appendMessage, setStatus, pushQueuedMessage, appSettings]);

  const handleModelChange = useCallback((model: string) => {
    setModel(sessionId, model);
    commands.agentSetModel(sessionId, model).catch(() => {});
  }, [sessionId, setModel]);

  const handleEffortChange = useCallback((effort: EffortLevel) => {
    setEffort(sessionId, effort);
  }, [sessionId, setEffort]);

  const handlePermissionModeChange = useCallback((mode: AgentPermissionMode) => {
    setPermissionMode(sessionId, mode);
    commands.agentSetPermissionMode(sessionId, mode).catch(() => {});
  }, [sessionId, setPermissionMode]);

  const handleConciseModeChange = useCallback((enabled: boolean) => {
    setConciseMode(sessionId, enabled);
  }, [sessionId, setConciseMode]);

  const handleChatModeChange = useCallback((enabled: boolean) => {
    setChatMode(sessionId, enabled);
  }, [sessionId, setChatMode]);

  const handleExtendedContextChange = useCallback((enabled: boolean) => {
    setExtendedContext(sessionId, enabled);
  }, [sessionId, setExtendedContext]);

  const handleBackendToggle = useCallback(() => {
    if (!session || session.status !== "idle") return;
    const newBackend = session.backend === "pi" ? "claude" as const : "pi" as const;
    const settings = useAppStore.getState().appSettings;
    const defaultModel = newBackend === "pi"
      ? settings?.pi_default_model || ""
      : settings?.agent_default_model || "";
    setAgentBackend(sessionId, newBackend, defaultModel);
    if (newBackend === "pi") ensurePiModelsLoaded().catch(() => {});
  }, [session, sessionId, setAgentBackend, ensurePiModelsLoaded]);

  const handleInterrupt = useCallback(() => {
    commands.agentInterrupt(sessionId).catch(() => {});
  }, [sessionId]);

  const handleToolResponse = useCallback((behavior: "allow" | "deny", opts?: { message?: string; updatedInput?: unknown }) => {
    const pending = session?.pendingPermission;
    if (!pending) return;
    commands.agentToolResponse(sessionId, pending.callId, behavior, opts?.message, opts?.updatedInput).catch(() => {});
    setPendingPermission(sessionId, null);
    setStatus(sessionId, "tool_use");
  }, [session?.pendingPermission, sessionId, setPendingPermission, setStatus]);

  const handleAskResponse = useCallback((answers: Record<string, string>) => {
    const pending = session?.pendingQuestion;
    if (!pending) return;
    commands.agentAskResponse(sessionId, pending.callId, answers).catch(() => {});
    setPendingQuestion(sessionId, null);
    setStatus(sessionId, "thinking");
  }, [session?.pendingQuestion, sessionId, setPendingQuestion, setStatus]);

  if (!session) return <div className="bg-bg-primary" />;

  const isInputDisabled = session.status === "waiting_permission";
  const isAgentBusy = session.status === "thinking" || session.status === "tool_use";

  let dotInner: React.ReactNode;
  if (claudeStatus === "active") {
    dotInner = (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
      </span>
    );
  } else if (claudeStatus === "idle") {
    dotInner = <span className="w-2 h-2 rounded-full bg-warning shrink-0" />;
  } else {
    dotInner = <span className="w-2 h-2 rounded-full bg-accent shrink-0" />;
  }

  const placeholder =
    session.status === "done"
      ? "Send a follow-up message..."
      : session.status === "waiting_input"
        ? "Answer the agent's question..."
        : session.status === "idle"
          ? "Send a message to start..."
          : "Queue message...";

  return (
    <div
      className="bg-bg-primary flex flex-col min-h-0 min-w-0 overflow-hidden relative"
    >
      {/* Tile header */}
      <div className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-border-primary bg-bg-secondary">
        <span className="w-4 h-4 flex items-center justify-center shrink-0">
          {dotInner}
        </span>
        <span className="text-[length:var(--app-font-11)] text-text-secondary truncate min-w-0">
          {projectName}
          <span className="text-text-tertiary mx-1">/</span>
          {worktreeName}
          <span className="text-text-tertiary mx-1">&mdash;</span>
          <span className="font-semibold">{tab.label}</span>
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <TileRunnerButtons worktreeId={worktreeId} />
          <Tooltip text="Go to tab" align="right">
            <button
              className="flex items-center justify-center w-4 h-4 text-text-tertiary hover:text-text-primary transition-colors"
              onClick={handleNavigate}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 2.5h5v5M9.5 2.5L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="Close tab" align="right">
            <button
              className="flex items-center justify-center w-4 h-4 text-text-tertiary hover:text-text-primary transition-colors"
              onClick={(event) => requestCloseTab(worktreeId, tab.id, event)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Messages */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden" onPointerDown={clearTileNotification}>
        <MessageList
          messages={session.messages}
          streamingText={session.streamingText}
          streamingThinkingText={session.streamingThinkingText}
          status={session.status}
          pendingPlan={session.pendingPermission && isPlanPermission(session.pendingPermission) ? session.pendingPermission : null}
          onPlanApprove={(updatedInput) => handleToolResponse("allow", { updatedInput })}
          onPlanRequestChanges={(feedback) => handleToolResponse("deny", { message: `Please revise the plan: ${feedback}` })}
          onPlanDeny={() => handleToolResponse("deny")}
          worktreePath={cwd}
        />
      </div>

      {/* Permission dialog — non-plan permissions */}
      {session.pendingPermission && !isPlanPermission(session.pendingPermission) && (
        <PermissionDialog
          pending={session.pendingPermission}
          onAllow={() => handleToolResponse("allow")}
          onDeny={() => handleToolResponse("deny")}
        />
      )}

      {closeConfirmation}

      {/* Ask user dialog */}
      {session.pendingQuestion && (
        <AskUserDialog
          pending={session.pendingQuestion}
          onSubmit={handleAskResponse}
        />
      )}

      {/* Input with inline controls dropdown */}
      <div className="shrink-0" onPointerDown={clearTileNotification}>
        <AgentInputBar
          sessionId={sessionId}
          disabled={isInputDisabled}
          isAgentBusy={isAgentBusy}
          placeholder={placeholder}
          slashCommands={session.slashCommands}
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          leftAddon={
            <div className="flex self-stretch items-stretch gap-2 shrink-0">
              <TileBackendToggle
                isPiBackend={session.backend === "pi"}
                canToggleBackend={session.status === "idle"}
                onToggle={handleBackendToggle}
              />
              <TileControlsDropdown
                model={session.model}
                effort={session.effort}
                permissionMode={session.permissionMode}
                conciseMode={session.conciseMode}
                chatMode={session.chatMode}
                extendedContext={session.extendedContext}
                onModelChange={handleModelChange}
                onEffortChange={handleEffortChange}
                onPermissionModeChange={handlePermissionModeChange}
                onConciseModeChange={handleConciseModeChange}
                onChatModeChange={handleChatModeChange}
                onExtendedContextChange={handleExtendedContextChange}
                availableModels={session.backend === "pi" ? piAvailableModels : undefined}
                isPiBackend={session.backend === "pi"}
              />
            </div>
          }
        />
      </div>
    </div>
  );
}

function ClaudeCliTile({ tile }: { tile: TileTab }) {
  const { tab, worktreeId, worktreeName, projectName } = tile;
  const claudeStatus = useAppStore((s) => s.claudeStatusByTab[tab.id] ?? null);
  const appSettings = useAppStore((s) => s.appSettings);
  const selectProject = useAppStore((s) => s.selectProject);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const clearClaudeIdleStatus = useAppStore((s) => s.clearClaudeIdleStatus);
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const { requestCloseTab, closeConfirmation } = useAgentTabCloseConfirmation();

  const appFontSize = appSettings?.app_font_size ?? DEFAULT_APP_FONT_SIZE;
  const termFontSize = appSettings?.terminal_font_size || getScaledFontSize(13, appFontSize);
  const termFontFamily = appSettings?.terminal_font_family || undefined;

  const clearTileNotification = useCallback(() => {
    clearClaudeIdleStatus(tab.id);
  }, [clearClaudeIdleStatus, tab.id]);

  const handleNavigate = useCallback(() => {
    const store = useAppStore.getState();
    for (const [projectId, worktrees] of Object.entries(store.worktreesByProject)) {
      if (worktrees.some((w) => w.id === worktreeId)) {
        selectProject(projectId);
        break;
      }
    }
    selectWorktree(worktreeId);
    setActiveTab(worktreeId, tab.id);
    toggleTileView();
  }, [worktreeId, tab.id, selectProject, selectWorktree, setActiveTab, toggleTileView]);

  let dotInner: React.ReactNode;
  if (claudeStatus === "active") {
    dotInner = (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
      </span>
    );
  } else if (claudeStatus === "idle") {
    dotInner = <span className="w-2 h-2 rounded-full bg-warning shrink-0" />;
  } else {
    dotInner = <span className="w-2 h-2 rounded-full bg-text-tertiary shrink-0" />;
  }

  return (
    <div className="bg-bg-primary flex flex-col min-h-0 min-w-0 overflow-hidden relative">
      <div className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-border-primary bg-bg-secondary">
        <span className="w-4 h-4 flex items-center justify-center shrink-0">
          {dotInner}
        </span>
        <span className="text-[length:var(--app-font-11)] text-text-secondary truncate min-w-0">
          {projectName}
          <span className="text-text-tertiary mx-1">/</span>
          {worktreeName}
          <span className="text-text-tertiary mx-1">&mdash;</span>
          <span className="font-semibold">{tab.label}</span>
        </span>
        <span className="shrink-0 rounded border border-border-primary px-1.5 py-0.5 text-[length:var(--app-font-10)] uppercase tracking-wide text-text-tertiary">
          CLI
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <TileRunnerButtons worktreeId={worktreeId} />
          <Tooltip text="Go to tab" align="right">
            <button
              className="flex items-center justify-center w-4 h-4 text-text-tertiary hover:text-text-primary transition-colors"
              onClick={handleNavigate}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M4.5 2.5h5v5M9.5 2.5L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="Close tab" align="right">
            <button
              className="flex items-center justify-center w-4 h-4 text-text-tertiary hover:text-text-primary transition-colors"
              onClick={(event) => requestCloseTab(worktreeId, tab.id, event)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex-1 min-h-0 relative" onPointerDown={clearTileNotification}>
        <TerminalPanel
          sessionId={tab.id}
          cwd={tab.cwd}
          command={tab.command}
          fontSize={termFontSize}
          fontFamily={termFontFamily}
          kind="claude"
          resumeSessionId={tab.claudeSessionId}
          resumeLatest={tab.resumeOnLaunch}
          keepAlive
        />
      </div>

      {closeConfirmation}
    </div>
  );
}

// ── Compact controls dropdown for tile input bars ──

const PERMISSION_MODES: { value: AgentPermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "bypassPermissions", label: "Allow All" },
  { value: "plan", label: "Plan Only" },
];

function TileBackendToggle({
  isPiBackend,
  canToggleBackend,
  onToggle,
}: {
  isPiBackend?: boolean;
  canToggleBackend?: boolean;
  onToggle?: () => void;
}) {
  const isPi = !!isPiBackend;

  return (
    <Tooltip
      text={
        canToggleBackend
          ? `Switch to ${isPi ? "Claude" : "Pi"} backend`
          : `Using ${isPi ? "Pi" : "Claude"} backend`
      }
      side="top"
      align="left"
    >
      <button
        type="button"
        className={`shrink-0 self-stretch flex items-center justify-center min-w-8 px-2 rounded-lg border text-[length:var(--app-font-10)] font-semibold uppercase transition-colors ${
          isPi
            ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
            : "bg-orange-500/10 text-orange-400 border-orange-500/20"
        } ${canToggleBackend ? "hover:brightness-125" : "opacity-60 cursor-default"}`}
        onClick={canToggleBackend ? onToggle : undefined}
        disabled={!canToggleBackend}
      >
        {isPi ? "Pi" : "Cl"}
      </button>
    </Tooltip>
  );
}

function TileSettingsRow({
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
        <div className="text-[length:var(--app-font-9)] uppercase tracking-wide text-text-tertiary">{label}</div>
        <div className="truncate text-[length:var(--app-font-11)] text-text-primary">{value}</div>
      </div>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0 text-text-tertiary">
        <path d="M3.5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function TileControlsDropdown({
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
}: {
  model: string;
  effort: EffortLevel;
  permissionMode: AgentPermissionMode;
  conciseMode: boolean;
  chatMode: boolean;
  extendedContext: boolean;
  onModelChange: (m: string) => void;
  onEffortChange: (e: EffortLevel) => void;
  onPermissionModeChange: (m: AgentPermissionMode) => void;
  onConciseModeChange: (v: boolean) => void;
  onChatModeChange: (v: boolean) => void;
  onExtendedContextChange: (v: boolean) => void;
  availableModels?: SupportedModel[];
  isPiBackend?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<"main" | "provider" | "model" | "effort" | "permission">("main");
  const ref = useRef<HTMLDivElement>(null);
  const configuredProviders = useAppStore((s) => s.appSettings?.pi_configured_providers ?? []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) setPanel("main");
  }, [open]);

  const supports1M = !isPiBackend && modelSupports1MContext(model);

  const piProviders = useMemo(() => {
    const fromSettings = configuredProviders.filter((provider): provider is string => Boolean(provider));
    if (fromSettings.length > 0) return fromSettings;
    const fromModels = [...new Set((availableModels ?? [])
      .map((candidate) => candidate.provider)
      .filter((provider): provider is string => Boolean(provider)))];
    return fromModels.length > 0 ? fromModels : ["anthropic"];
  }, [configuredProviders, availableModels]);

  const currentPiProvider = useMemo(() => {
    if (!isPiBackend) return "";
    if (model.includes("/")) return model.split("/")[0];
    const matched = (availableModels ?? []).find((candidate) => candidate.value === model);
    return matched?.provider ?? piProviders[0] ?? "anthropic";
  }, [availableModels, isPiBackend, model, piProviders]);

  const currentModelId = isPiBackend ? stripPiProviderPrefix(model) : model;
  const currentProviderModels = useMemo(
    () => (isPiBackend ? getPiModelsForProvider(currentPiProvider, availableModels ?? []) : []),
    [availableModels, currentPiProvider, isPiBackend],
  );

  const currentModelLabel = useMemo(() => {
    const pool = isPiBackend
      ? currentProviderModels
      : (availableModels && availableModels.length > 0 ? availableModels : CLAUDE_MODELS);
    const matched = pool.find((candidate) =>
      candidate.value === currentModelId || (candidate.provider && `${candidate.provider}/${candidate.value}` === model)
    );
    return matched?.label ?? (currentModelId || "SDK default");
  }, [availableModels, currentModelId, currentProviderModels, isPiBackend, model]);

  const currentEffortLabel = useMemo(() => {
    const levels = isPiBackend ? PI_EFFORT_LEVELS : CLAUDE_EFFORT_LEVELS;
    const selected = levels.find((level) =>
      effort === level.value || (isPiBackend && effort === "max" && level.value === "xhigh")
    );
    return selected?.label ?? effort;
  }, [effort, isPiBackend]);

  const currentPermissionLabel = useMemo(
    () => PERMISSION_MODES.find((candidate) => candidate.value === permissionMode)?.label ?? "Default",
    [permissionMode],
  );

  const closeMenu = useCallback(() => {
    setOpen(false);
    setPanel("main");
  }, []);

  const handleProviderChange = useCallback((provider: string) => {
    const nextModels = getPiModelsForProvider(provider, availableModels ?? []);
    const nextModelId = nextModels.find((candidate) => candidate.value === currentModelId)?.value
      ?? nextModels[0]?.value
      ?? currentModelId;
    if (!nextModelId) {
      setPanel("main");
      return;
    }
    const nextValue = `${provider}/${nextModelId}`;
    if (nextValue !== model) onModelChange(nextValue);
    setPanel("model");
  }, [availableModels, currentModelId, model, onModelChange]);

  const handleModelSelect = useCallback((value: string) => {
    const nextValue = isPiBackend && !value.includes("/")
      ? `${currentPiProvider}/${value}`
      : value;
    if (nextValue !== model) onModelChange(nextValue);
    setPanel("main");
  }, [currentPiProvider, isPiBackend, model, onModelChange]);

  const panelTitle = panel === "provider"
    ? "Provider"
    : panel === "model"
      ? "Model"
      : panel === "effort"
        ? "Effort"
        : "Permissions";

  return (
    <div className="relative flex self-stretch" ref={ref}>
      <Tooltip text="Agent settings" side="top" align="left">
        <button
          type="button"
          className={`h-full shrink-0 flex items-center justify-center w-8 rounded-lg border transition-colors ${
            open
              ? "border-accent bg-accent/10 text-accent"
              : "border-border-primary text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary"
          }`}
          onClick={() => setOpen((value) => !value)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="2.5" />
            <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
          </svg>
        </button>
      </Tooltip>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-56 bg-bg-secondary border border-border-primary rounded-lg shadow-lg overflow-hidden z-50">
          {panel === "main" ? (
            <>
              <div className="p-1.5 space-y-1.5 border-b border-border-primary">
                {isPiBackend && piProviders.length > 0 && (
                  <TileSettingsRow
                    label="Provider"
                    value={formatPiProvider(currentPiProvider)}
                    onClick={() => setPanel("provider")}
                  />
                )}
                <TileSettingsRow
                  label="Model"
                  value={currentModelLabel}
                  onClick={() => setPanel("model")}
                />
                <TileSettingsRow
                  label="Effort"
                  value={currentEffortLabel}
                  onClick={() => setPanel("effort")}
                />
                <TileSettingsRow
                  label="Permissions"
                  value={currentPermissionLabel}
                  onClick={() => setPanel("permission")}
                />
              </div>

              <div className="px-3 py-2 flex flex-wrap gap-1.5">
                {supports1M && (
                  <button
                    type="button"
                    className={`px-2 py-0.5 rounded text-[length:var(--app-font-11)] transition-colors ${
                      extendedContext
                        ? "bg-accent/15 text-accent"
                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    }`}
                    onClick={() => onExtendedContextChange(!extendedContext)}
                  >
                    1M
                  </button>
                )}
                <button
                  type="button"
                  className={`px-2 py-0.5 rounded text-[length:var(--app-font-11)] transition-colors ${
                    conciseMode
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                  onClick={() => onConciseModeChange(!conciseMode)}
                >
                  Concise
                </button>
                <button
                  type="button"
                  className={`px-2 py-0.5 rounded text-[length:var(--app-font-11)] transition-colors ${
                    chatMode
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                  onClick={() => onChatModeChange(!chatMode)}
                >
                  Chat
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1.5">
                <button
                  type="button"
                  className="flex items-center justify-center w-6 h-6 rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                  onClick={() => setPanel("main")}
                  aria-label="Back"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M6.5 2L3.5 5l3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <div className="min-w-0 flex-1 text-[length:var(--app-font-11)] font-medium text-text-primary">{panelTitle}</div>
                {panel === "model" && isPiBackend && (
                  <div className="max-w-[96px] truncate text-[length:var(--app-font-10)] text-text-tertiary">
                    {formatPiProvider(currentPiProvider)}
                  </div>
                )}
              </div>

              {panel === "provider" ? (
                <div className="max-h-[240px] overflow-y-auto p-1.5">
                  {piProviders.map((provider) => {
                    const active = provider === currentPiProvider;
                    return (
                      <button
                        key={provider}
                        type="button"
                        className={`w-full rounded-md px-2.5 py-2 text-left text-[length:var(--app-font-11)] transition-colors ${
                          active
                            ? "bg-accent/10 text-accent"
                            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                        }`}
                        onClick={() => handleProviderChange(provider)}
                      >
                        {formatPiProvider(provider)}
                      </button>
                    );
                  })}
                </div>
              ) : panel === "model" ? (
                <ModelPicker
                  model={model}
                  onModelChange={handleModelSelect}
                  availableModels={isPiBackend ? currentProviderModels : availableModels}
                  inline
                />
              ) : panel === "effort" ? (
                <EffortPicker
                  effort={effort}
                  onEffortChange={(value) => {
                    onEffortChange(value);
                    setPanel("main");
                  }}
                  isPiBackend={isPiBackend}
                  inline
                />
              ) : (
                <div className="max-h-[240px] overflow-y-auto p-1.5">
                  {PERMISSION_MODES.map((mode) => {
                    const active = mode.value === permissionMode;
                    return (
                      <button
                        key={mode.value}
                        type="button"
                        className={`w-full rounded-md px-2.5 py-2 text-left text-[length:var(--app-font-11)] transition-colors ${
                          active
                            ? "bg-accent/10 text-accent"
                            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                        }`}
                        onClick={() => {
                          onPermissionModeChange(mode.value);
                          closeMenu();
                        }}
                      >
                        {mode.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Runner buttons for tile headers ──

function getAvailableRunners(project: Project) {
  return [
    ...(project.run_command
      ? [{ key: "run", label: "Run", command: project.run_command }]
      : []),
    ...(project.build_command
      ? [{ key: "build", label: "Build", command: project.build_command }]
      : []),
    ...(project.setup_scripts.length > 0
      ? [{ key: "setup", label: "Setup", command: project.setup_scripts.join(" && ") }]
      : []),
  ];
}

function TileRunnerButtons({ worktreeId }: { worktreeId: string }) {
  const projects = useAppStore((s) => s.projects);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const runnersByWorktree = useAppStore((s) => s.runnersByWorktree);
  const openOrRestartRunner = useAppStore((s) => s.openOrRestartRunner);
  const setRunnerStatus = useAppStore((s) => s.setRunnerStatus);

  const { project, worktreePath } = useMemo(() => {
    for (const p of projects) {
      const wts = worktreesByProject[p.id] ?? [];
      const wt = wts.find((w) => w.id === worktreeId);
      if (wt) return { project: p, worktreePath: wt.path };
    }
    return { project: null, worktreePath: "" };
  }, [projects, worktreesByProject, worktreeId]);

  const runners = runnersByWorktree[worktreeId] ?? {};
  const available = project ? getAvailableRunners(project) : [];

  if (available.length === 0) return null;

  return (
    <div className="flex items-center gap-1">
      {available.map(({ key, label, command }) => {
        const runner = runners[key];
        const status = runner?.status ?? "idle";

        if (status === "running") {
          return (
            <Tooltip key={key} text={`Stop ${label.toLowerCase()}`} side="top">
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  if (runner) {
                    await commands.terminalKill(runner.id).catch(() => {});
                    setRunnerStatus(worktreeId, key, "stopped");
                  }
                }}
                className="px-1.5 py-0.5 text-[length:var(--app-font-10)] rounded text-error/70 hover:text-error hover:bg-error/10 transition-colors"
              >
                Stop
              </button>
            </Tooltip>
          );
        }

        return (
          <Tooltip key={key} text={`Run ${label.toLowerCase()}`} side="top">
            <button
              onClick={(e) => {
                e.stopPropagation();
                openOrRestartRunner(worktreeId, key, command, worktreePath);
              }}
              className="px-1.5 py-0.5 text-[length:var(--app-font-10)] rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            >
              {label}
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ── Shared picker dropdown (projects → worktrees + "New worktree…") ──

function TilePickerDropdown({
  onAddExisting,
  onCreateNew,
  position,
}: TilePickerProps & { position: "dropdown" | "inline" }) {
  const projects = useAppStore((s) => s.projects);
  const worktreesByProject = useAppStore((s) => s.worktreesByProject);
  const spWorktree = useAppStore((s) => s.scratchpadWorktree);
  const [expandedId, setExpandedId] = useState<string | null>(
    // Auto-expand if there's only one project
    projects.length === 1 ? projects[0].id : null
  );

  const wrapperClass =
    position === "dropdown"
      ? "absolute right-0 top-full mt-1 w-64 max-h-80 flex flex-col bg-bg-secondary rounded-lg border border-border-primary shadow-lg overflow-hidden z-10"
      : "flex-1 overflow-y-auto min-h-0";

  const content = projects.length === 0 && !spWorktree ? (
    <div className="flex items-center justify-center py-6 text-text-tertiary text-xs">
      No projects available
    </div>
  ) : (
    <>
    {spWorktree && (
      <button
        className="w-full text-left px-3 py-2 flex items-center gap-2 text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        onClick={() => onAddExisting(SCRATCHPAD_WORKTREE_ID, spWorktree.path)}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 opacity-60">
          <rect x="2" y="1" width="12" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
        </svg>
        <span className="text-[length:var(--app-font-12)] font-medium">Scratchpad</span>
      </button>
    )}
    {projects.map((project) => {
      const expanded = expandedId === project.id;
      const worktrees = (worktreesByProject[project.id] ?? []).filter(
        (wt) => !wt.archived
      );
      return (
        <div key={project.id}>
          {/* Project row — click to expand/collapse */}
          <button
            className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
              expanded
                ? "text-text-primary bg-bg-hover/50"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            }`}
            onClick={() => setExpandedId(expanded ? null : project.id)}
          >
            <svg
              width="8"
              height="8"
              viewBox="0 0 8 8"
              className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
            </svg>
            <span className="text-[length:var(--app-font-12)] font-medium truncate">{project.name}</span>
          </button>
          {/* Submenu */}
          {expanded && (
            <div>
              {/* New worktree — always first */}
              <button
                className="w-full text-left pl-7 pr-3 py-1.5 hover:bg-bg-hover transition-colors flex items-center gap-2 text-accent"
                onClick={() => onCreateNew(project.id)}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0">
                  <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span className="text-[length:var(--app-font-12)]">New worktree…</span>
              </button>
              {/* Existing worktrees */}
              {worktrees.map((wt) => (
                <button
                  key={wt.id}
                  className="w-full text-left pl-7 pr-3 py-1.5 hover:bg-bg-hover transition-colors flex items-center gap-2"
                  onClick={() => onAddExisting(wt.id, wt.path)}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  <span className="text-[length:var(--app-font-12)] text-text-primary font-mono truncate">
                    {wt.branch}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    })}
    </>
  );

  if (position === "inline") {
    return <div className={wrapperClass}>{content}</div>;
  }

  return (
    <div className={wrapperClass}>
      <div className="px-3 py-2 border-b border-border-primary shrink-0">
        <span className="text-xs font-medium text-text-primary">Add tile</span>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">{content}</div>
    </div>
  );
}

// ── Add-tile cell (inline, only shown when grid has a leftover slot) ──

function AddTileCell({ onAddExisting, onCreateNew }: TilePickerProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <div className="bg-bg-primary flex items-center justify-center relative">
      {!pickerOpen ? (
        <button
          className="flex flex-col items-center gap-3 text-text-tertiary hover:text-accent transition-colors group"
          onClick={() => setPickerOpen(true)}
        >
          <div className="w-12 h-12 rounded-xl border-2 border-dashed border-text-tertiary/30 group-hover:border-accent/50 flex items-center justify-center transition-colors">
            <svg width="20" height="20" viewBox="0 0 14 14" fill="none">
              <path
                d="M7 1v12M1 7h12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <span className="text-xs">Add tile</span>
        </button>
      ) : (
        <div className="absolute inset-4 flex flex-col bg-bg-secondary rounded-lg border border-border-primary shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border-primary shrink-0">
            <span className="text-xs font-medium text-text-primary">Add tile</span>
            <button
              className="text-text-tertiary hover:text-text-primary transition-colors"
              onClick={() => setPickerOpen(false)}
            >
              <svg width="10" height="10" viewBox="0 0 8 8" fill="none">
                <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <TilePickerDropdown
            onAddExisting={(id, path) => { setPickerOpen(false); onAddExisting(id, path); }}
            onCreateNew={(id) => { setPickerOpen(false); onCreateNew(id); }}
            position="inline"
          />
        </div>
      )}
    </div>
  );
}

