import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useAppStore, type TabInfo } from "../../stores/appStore";
import { MessageList } from "../AgentView/MessageList";
import { CreateWorktreeModal } from "../Sidebar/CreateWorktreeModal";
import * as commands from "../../lib/commands";

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

  // Ref to hold the unsubscribe function for the pending-pin subscription.
  // Cleaned up on unmount or when a new creation starts.
  const pendingPinUnsub = useRef<(() => void) | null>(null);

  // Cleanup subscription on unmount
  useEffect(() => {
    return () => pendingPinUnsub.current?.();
  }, []);

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
  // and selected. Reactively waits for the first agent tab to appear, then
  // pins it — no timeouts, fully event-driven.
  const handleWorktreeCreated = useCallback((worktreeId: string) => {
    // Clean up any previous subscription
    pendingPinUnsub.current?.();

    // Check if an agent tab already exists (synchronous fast-path)
    const state = useAppStore.getState();
    const existing = (state.tabsByWorktree[worktreeId] ?? []).find(
      (t) => t.type === "agent"
    );
    if (existing) {
      state.toggleTabPin(worktreeId, existing.id);
      pendingPinUnsub.current = null;
      return;
    }

    // Subscribe to store — pin the first agent tab as soon as it appears
    const unsub = useAppStore.subscribe((s) => {
      const tabs = s.tabsByWorktree[worktreeId] ?? [];
      const firstAgent = tabs.find((t) => t.type === "agent");
      if (firstAgent) {
        unsub();
        pendingPinUnsub.current = null;
        useAppStore.getState().toggleTabPin(worktreeId, firstAgent.id);
      }
    });
    pendingPinUnsub.current = unsub;
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
          background: "var(--color-accent, #6366f1)",
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
    <div className="flex items-center h-10 px-3 shrink-0 bg-bg-secondary border-b border-accent/30">
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
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [dotHovered, setDotHovered] = useState(false);

  const showInput = isHovered || isFocused;

  const selectProject = useAppStore((s) => s.selectProject);
  const selectWorktree = useAppStore((s) => s.selectWorktree);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const clearClaudeIdleStatus = useAppStore((s) => s.clearClaudeIdleStatus);
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const toggleTabPin = useAppStore((s) => s.toggleTabPin);

  const clearTileNotification = useCallback(() => {
    clearClaudeIdleStatus(tab.id);
  }, [clearClaudeIdleStatus, tab.id]);

  useEffect(() => {
    if (isFocused && claudeStatus === "idle") {
      clearClaudeIdleStatus(tab.id);
    }
  }, [isFocused, claudeStatus, clearClaudeIdleStatus, tab.id]);

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

  if (!session) return <div className="bg-bg-primary" />;

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

  return (
    <div
      className="bg-bg-primary flex flex-col min-h-0 relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
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
          {tab.label}
        </span>
        <button
          className="ml-auto text-text-tertiary hover:text-text-primary transition-colors"
          onClick={handleNavigate}
          title="Go to tab"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M4 1h7v7M11 1L5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden" onPointerDown={clearTileNotification}>
        <MessageList
          messages={session.messages}
          streamingText={session.streamingText}
          status={session.status}
        />
      </div>

      {/* Simplified input — visible on hover or focus */}
      <div
        className={`transition-all duration-150 ${showInput ? "max-h-24 opacity-100" : "max-h-0 opacity-0"} overflow-hidden`}
      >
        <TileInputBar
          sessionId={tab.id}
          cwd={tab.cwd}
          onInteract={clearTileNotification}
          onFocusChange={setIsFocused}
        />
      </div>
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

// ── Tile input bar (simplified, no model/effort controls) ──

function TileInputBar({
  sessionId,
  cwd,
  onInteract,
  onFocusChange,
}: {
  sessionId: string;
  cwd: string;
  onInteract: () => void;
  onFocusChange: (focused: boolean) => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const session = useAppStore((s) => s.agentSessionByTab[sessionId]);
  const appendMessage = useAppStore((s) => s.appendAgentMessage);
  const setStatus = useAppStore((s) => s.setAgentStatus);
  const pushQueuedMessage = useAppStore((s) => s.pushAgentQueuedMessage);
  const appendTrace = useAppStore((s) => s.appendTraceEvent);
  const appSettings = useAppStore((s) => s.appSettings);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 80) + "px";
  }, [text]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || !session) return;

    const msgId = nextTileMsgId();

    if (session.status === "done" || session.status === "error" || session.status === "idle") {
      appendMessage(sessionId, {
        id: msgId,
        type: "user",
        content: trimmed,
        timestamp: Date.now(),
      });
      appendTrace(sessionId, { type: "query_start", content: trimmed, id: `tile-tr-${Date.now()}`, timestamp: Date.now() });
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

      commands.agentStart(sessionId, cwd, trimmed, opts).catch((err) => {
        appendMessage(sessionId, {
          id: nextTileMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
        setStatus(sessionId, "error");
      });
    } else if (session.status === "thinking" || session.status === "tool_use") {
      pushQueuedMessage(sessionId, trimmed);
      appendMessage(sessionId, {
        id: msgId,
        type: "user",
        content: trimmed,
        isQueued: true,
        timestamp: Date.now(),
      });
    } else if (session.status === "waiting_input") {
      appendMessage(sessionId, {
        id: msgId,
        type: "user",
        content: trimmed,
        timestamp: Date.now(),
      });
      setStatus(sessionId, "thinking");
      commands.agentSendInput(sessionId, trimmed).catch((err) => {
        appendMessage(sessionId, {
          id: nextTileMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
      });
    }

    setText("");
  }, [text, session, sessionId, cwd, appendMessage, setStatus, pushQueuedMessage, appendTrace, appSettings]);

  const isDisabled = session?.status === "waiting_permission";
  const isBusy = session?.status === "thinking" || session?.status === "tool_use";

  return (
    <div className="flex items-end gap-1.5 px-2 py-1.5 bg-bg-secondary border-t border-border-primary">
      <textarea
        ref={textareaRef}
        className="flex-1 resize-none overflow-hidden bg-transparent border border-border-primary rounded px-2 py-1 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/60 font-mono leading-relaxed"
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPointerDown={onInteract}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
          }
        }}
        onFocus={() => {
          onInteract();
          onFocusChange(true);
        }}
        onBlur={() => onFocusChange(false)}
        placeholder={isBusy ? "Queue a message..." : "Send a message..."}
        disabled={isDisabled}
        spellCheck={false}
      />
      <button
        className={`shrink-0 w-7 h-7 flex items-center justify-center rounded text-white transition-colors disabled:opacity-30 ${
          isBusy ? "bg-amber-500/80 hover:bg-amber-500" : "bg-accent hover:bg-accent-hover"
        }`}
        onClick={handleSend}
        disabled={isDisabled || !text.trim()}
        title={isBusy ? "Queue" : "Send"}
      >
        {isBusy ? (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 3v3.5l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
            <path d="M1 7h12M8 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
    </div>
  );
}
