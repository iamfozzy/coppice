import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useAppStore, type TabInfo } from "../../stores/appStore";
import { MessageList } from "../AgentView/MessageList";
import { AgentInputBar } from "../AgentView/AgentInputBar";
import { CreateWorktreeModal } from "../Sidebar/CreateWorktreeModal";
import { SUPPORTED_MODELS, modelSupports1MContext } from "../../lib/supportedModels";
import * as commands from "../../lib/commands";
import type { ImageAttachment, EffortLevel, AgentPermissionMode, Project } from "../../lib/types";

interface PinnedTab {
  tab: TabInfo;
  worktreeId: string;
  worktreeName: string;
  projectName: string;
}

/** Compute grid columns based on pinned tile count only. */
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
  const addPinnedAgentTab = useAppStore((s) => s.addPinnedAgentTab);

  const [creatingForProject, setCreatingForProject] = useState<string | null>(null);

  // Add a pinned agent tab to an existing worktree
  const handleAddExisting = useCallback((worktreeId: string, worktreePath: string) => {
    addPinnedAgentTab(worktreeId, worktreePath);
  }, [addPinnedAgentTab]);

  // Open CreateWorktreeModal for a project
  const handleCreateNew = useCallback((projectId: string) => {
    setCreatingForProject(projectId);
  }, []);

  const handleModalClose = useCallback(() => {
    setCreatingForProject(null);
  }, []);

  // Called by CreateWorktreeModal after a worktree is successfully created
  // and selected. Immediately creates a pinned agent tab for the tile view.
  const handleWorktreeCreated = useCallback((worktreeId: string) => {
    const state = useAppStore.getState();
    const path = state.getWorktreePath(worktreeId);
    if (path) {
      state.addPinnedAgentTab(worktreeId, path);
    }
  }, []);

  const pinnedTabs = useMemo<PinnedTab[]>(() => {
    const result: PinnedTab[] = [];
    for (const project of projects) {
      const worktrees = worktreesByProject[project.id] ?? [];
      for (const wt of worktrees) {
        const tabs = tabsByWorktree[wt.id] ?? [];
        for (const tab of tabs) {
          if (tab.pinned && tab.type === "agent") {
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
    result.sort((left, right) => (left.tab.pinnedAt ?? 0) - (right.tab.pinnedAt ?? 0));
    return result;
  }, [tabsByWorktree, worktreesByProject, projects]);

  const cols = computeCols(pinnedTabs.length);
  const rows = Math.ceil(pinnedTabs.length / cols) || 1;
  const totalSlots = cols * rows;
  const hasEmptySlot = totalSlots > pinnedTabs.length;

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
        {pinnedTabs.map((pinned) => (
          <Tile key={pinned.tab.id} pinned={pinned} />
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
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

  return (
    <div className="flex items-center h-10 px-3 shrink-0 bg-bg-secondary border-b border-border-primary">
      {/* Left: close toggle */}
      <button
        onClick={toggleTileView}
        className="w-7 h-7 flex items-center justify-center rounded text-accent hover:text-accent-hover hover:bg-accent/10 transition-colors"
        title="Close tile view (Esc)"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>

      <span className="text-[11px] text-text-tertiary ml-2 select-none">Tile View</span>

      {/* Right: add tile */}
      <div className="ml-auto relative" ref={pickerRef}>
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="w-7 h-7 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Add tile"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>

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

function Tile({ pinned }: { pinned: PinnedTab }) {
  const { tab, worktreeName, projectName } = pinned;
  const session = useAppStore((s) => s.agentSessionByTab[tab.id]);
  const claudeStatus = useAppStore((s) => s.claudeStatusByTab[tab.id] ?? null);
  const appSettings = useAppStore((s) => s.appSettings);
  const [dotHovered, setDotHovered] = useState(false);

  const selectProject = useAppStore((s) => s.selectProject);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const clearClaudeIdleStatus = useAppStore((s) => s.clearClaudeIdleStatus);
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const toggleTabPin = useAppStore((s) => s.toggleTabPin);
  const closeTab = useAppStore((s) => s.closeTab);
  const appendMessage = useAppStore((s) => s.appendAgentMessage);
  const setStatus = useAppStore((s) => s.setAgentStatus);
  const pushQueuedMessage = useAppStore((s) => s.pushAgentQueuedMessage);
  const appendTrace = useAppStore((s) => s.appendTraceEvent);
  const setModel = useAppStore((s) => s.setAgentModel);
  const setEffort = useAppStore((s) => s.setAgentEffort);
  const setPermissionMode = useAppStore((s) => s.setAgentPermissionMode);
  const setConciseMode = useAppStore((s) => s.setAgentConciseMode);
  const setChatMode = useAppStore((s) => s.setAgentChatMode);
  const setExtendedContext = useAppStore((s) => s.setAgentExtendedContext);

  const sessionId = tab.id;
  const cwd = tab.cwd;

  const clearTileNotification = useCallback(() => {
    clearClaudeIdleStatus(tab.id);
  }, [clearClaudeIdleStatus, tab.id]);

  const handleNavigate = useCallback(() => {
    const store = useAppStore.getState();
    for (const [projectId, worktrees] of Object.entries(store.worktreesByProject)) {
      if (worktrees.some((w) => w.id === pinned.worktreeId)) {
        selectProject(projectId);
        break;
      }
    }
    selectWorktree(pinned.worktreeId);
    setActiveTab(pinned.worktreeId, tab.id);
    toggleTileView();
  }, [pinned.worktreeId, tab.id, selectProject, selectWorktree, setActiveTab, toggleTileView]);

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
      appendTrace(sessionId, { type: "query_start", content: text, id: `tile-tr-${Date.now()}`, timestamp: Date.now() });
      setStatus(sessionId, "thinking");

      const opts: Parameters<typeof commands.agentStart>[3] = {
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
  }, [session, sessionId, cwd, appendMessage, setStatus, pushQueuedMessage, appendTrace, appSettings]);

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

  if (!session) return <div className="bg-bg-primary" />;

  const isInputDisabled = session.status === "waiting_permission";
  const isAgentBusy = session.status === "thinking" || session.status === "tool_use";

  // Status dot — same fixed-width hover-to-pin pattern as the tab bar
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

  const pinIcon = (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1L5 5l-3 1 4 4 1-3 4-4z" />
      <path d="M5 11L1 15" />
    </svg>
  );

  const placeholder =
    session.status === "done"
      ? "Send a follow-up message..."
      : session.status === "waiting_input"
        ? "Answer Claude's question..."
        : session.status === "idle"
          ? "Send a message to start..."
          : "Queue a message for when Claude finishes...";

  return (
    <div
      className="bg-bg-primary flex flex-col min-h-0 relative"
    >
      {/* Tile header */}
      <div className="flex items-center gap-2 px-3 h-8 shrink-0 border-b border-border-primary bg-bg-secondary">
        <span
          className={`w-4 h-4 flex items-center justify-center shrink-0 rounded-sm cursor-pointer transition-colors ${dotHovered ? "text-accent hover:bg-accent/10" : ""}`}
          onMouseEnter={() => setDotHovered(true)}
          onMouseLeave={() => setDotHovered(false)}
          onClick={() => toggleTabPin(pinned.worktreeId, tab.id)}
          title="Unpin from tiles"
        >
          {dotHovered ? pinIcon : dotInner}
        </span>
        <span className="text-[11px] text-text-secondary truncate">
          {projectName}
          <span className="text-text-tertiary mx-1">/</span>
          {worktreeName}
          <span className="text-text-tertiary mx-1">&mdash;</span>
          <span className="font-semibold">{tab.label}</span>
        </span>
        <div className="ml-auto flex items-center gap-2.5">
          <TileRunnerButtons worktreeId={pinned.worktreeId} />
          <button
            className="flex items-center justify-center w-4 h-4 text-text-tertiary hover:text-text-primary transition-colors"
            onClick={handleNavigate}
            title="Go to tab"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4.5 2.5h5v5M9.5 2.5L4 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button
            className="flex items-center justify-center w-4 h-4 text-text-tertiary hover:text-text-primary transition-colors"
            onClick={() => closeTab(pinned.worktreeId, tab.id)}
            title="Close tab"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden" onPointerDown={clearTileNotification}>
        <MessageList
          messages={session.messages}
          streamingText={session.streamingText}
          streamingThinkingText={session.streamingThinkingText}
          status={session.status}
        />
      </div>

      {/* Input with inline controls dropdown */}
      <div className="shrink-0" onPointerDown={clearTileNotification}>
        <AgentInputBar
          sessionId={sessionId}
          disabled={isInputDisabled}
          isAgentBusy={isAgentBusy}
          placeholder={placeholder}
          slashCommands={session.slashCommands}
          onSend={handleSend}
          leftAddon={
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
            />
          }
        />
      </div>
    </div>
  );
}

// ── Compact controls dropdown for tile input bars ──

const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES: { value: AgentPermissionMode; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "acceptEdits", label: "Accept Edits" },
  { value: "bypassPermissions", label: "Allow All" },
  { value: "plan", label: "Plan Only" },
];

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
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const supports1M = modelSupports1MContext(model);

  return (
    <div className="relative self-stretch" ref={ref}>
      <button
        type="button"
        className={`h-full shrink-0 flex items-center justify-center w-8 rounded-lg border transition-colors ${
          open
            ? "border-accent bg-accent/10 text-accent"
            : "border-border-primary text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary"
        }`}
        onClick={() => setOpen((v) => !v)}
        title="Agent settings"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="2.5" />
          <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 min-w-[200px] bg-bg-secondary border border-border-primary rounded-lg shadow-lg overflow-hidden z-50">
          {/* Model */}
          <div className="px-3 py-2 border-b border-border-primary">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1.5">Model</div>
            <div className="flex flex-wrap gap-1">
              {SUPPORTED_MODELS.map((m) => (
                <button
                  key={m.value}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                    m.value === model
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                  onClick={() => onModelChange(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Effort */}
          <div className="px-3 py-2 border-b border-border-primary">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1.5">Effort</div>
            <div className="flex rounded-md overflow-hidden border border-border-primary bg-bg-tertiary">
              {EFFORT_LEVELS.map((level) => (
                <button
                  key={level}
                  className={`flex-1 px-1.5 py-0.5 text-[10px] capitalize transition-colors ${
                    effort === level
                      ? "bg-accent text-white"
                      : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                  }`}
                  onClick={() => onEffortChange(level)}
                >
                  {level}
                </button>
              ))}
            </div>
          </div>

          {/* Permission mode */}
          <div className="px-3 py-2 border-b border-border-primary">
            <div className="text-[10px] text-text-tertiary uppercase tracking-wider mb-1.5">Permissions</div>
            <div className="flex flex-wrap gap-1">
              {PERMISSION_MODES.map((m) => (
                <button
                  key={m.value}
                  className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                    m.value === permissionMode
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                  onClick={() => onPermissionModeChange(m.value)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Toggles */}
          <div className="px-3 py-2 flex flex-wrap gap-1.5">
            {supports1M && (
              <button
                className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
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
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                conciseMode
                  ? "bg-accent/15 text-accent"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
              onClick={() => onConciseModeChange(!conciseMode)}
            >
              Concise
            </button>
            <button
              className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
                chatMode
                  ? "bg-accent/15 text-accent"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
              onClick={() => onChatModeChange(!chatMode)}
            >
              Chat
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Runner buttons for tile headers ──

function getAvailableRunners(project: Project) {
  return [
    ...(project.setup_scripts.length > 0
      ? [{ key: "setup", label: "Setup", command: project.setup_scripts.join(" && ") }]
      : []),
    ...(project.build_command
      ? [{ key: "build", label: "Build", command: project.build_command }]
      : []),
    ...(project.run_command
      ? [{ key: "run", label: "Run", command: project.run_command }]
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
            <button
              key={key}
              onClick={async (e) => {
                e.stopPropagation();
                if (runner) {
                  await commands.terminalKill(runner.id).catch(() => {});
                  setRunnerStatus(worktreeId, key, "stopped");
                }
              }}
              className="px-1.5 py-0.5 text-[10px] rounded text-error/70 hover:text-error hover:bg-error/10 transition-colors"
              title={`Stop ${label}`}
            >
              Stop
            </button>
          );
        }

        return (
          <button
            key={key}
            onClick={(e) => {
              e.stopPropagation();
              openOrRestartRunner(worktreeId, key, command, worktreePath);
            }}
            className="px-1.5 py-0.5 text-[10px] rounded text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title={`${label}`}
          >
            {label}
          </button>
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
  const [expandedId, setExpandedId] = useState<string | null>(
    // Auto-expand if there's only one project
    projects.length === 1 ? projects[0].id : null
  );

  const wrapperClass =
    position === "dropdown"
      ? "absolute right-0 top-full mt-1 w-64 max-h-80 flex flex-col bg-bg-secondary rounded-lg border border-border-primary shadow-lg overflow-hidden z-10"
      : "flex-1 overflow-y-auto min-h-0";

  const content = projects.length === 0 ? (
    <div className="flex items-center justify-center py-6 text-text-tertiary text-xs">
      No projects available
    </div>
  ) : (
    projects.map((project) => {
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
            <span className="text-[12px] font-medium truncate">{project.name}</span>
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
                <span className="text-[12px]">New worktree…</span>
              </button>
              {/* Existing worktrees */}
              {worktrees.map((wt) => (
                <button
                  key={wt.id}
                  className="w-full text-left pl-7 pr-3 py-1.5 hover:bg-bg-hover transition-colors flex items-center gap-2"
                  onClick={() => onAddExisting(wt.id, wt.path)}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                  <span className="text-[12px] text-text-primary font-mono truncate">
                    {wt.branch}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    })
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

