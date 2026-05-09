import { useEffect, useRef, useCallback, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import type { AgentBackend } from "../../lib/types";
import { ProjectTree } from "./ProjectTree";
import { ScratchpadNode } from "./ScratchpadNode";
import { ChangesPanel } from "./ChangesPanel";
import { SidebarRunners } from "./SidebarRunners";
import { Tooltip } from "../ui/Tooltip";

export function Sidebar() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const openAppSettings = useAppStore((s) => s.openAppSettings);
  const toggleTileView = useAppStore((s) => s.toggleTileView);
  const showTileView = useAppStore((s) => s.showTileView);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const appSettings = useAppStore((s) => s.appSettings);
  const setDefaultAgentBackend = useAppStore((s) => s.setDefaultAgentBackend);
  const setAgentBackend = useAppStore((s) => s.setAgentBackend);

  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const backendMenuRef = useRef<HTMLDivElement>(null);
  const [backendMenuOpen, setBackendMenuOpen] = useState(false);
  const [switchingBackend, setSwitchingBackend] = useState(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!backendMenuOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (backendMenuRef.current && !backendMenuRef.current.contains(e.target as Node)) {
        setBackendMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBackendMenuOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [backendMenuOpen]);

  const handleBackendSelect = useCallback(async (backend: AgentBackend) => {
    const settings = useAppStore.getState().appSettings;
    if (!settings || settings.agent_backend === backend) {
      setBackendMenuOpen(false);
      return;
    }
    setSwitchingBackend(true);
    try {
      await setDefaultAgentBackend(backend);
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
          backend,
          backend === "pi" ? settings.pi_default_model || "" : settings.agent_default_model || "",
        );
      }
    } finally {
      setSwitchingBackend(false);
      setBackendMenuOpen(false);
    }
  }, [setDefaultAgentBackend, setAgentBackend]);

  const onMouseDown = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // Signal heavy components (xterm fit, terminalResize IPC, etc.) to skip
    // layout work while the sidebar is being dragged. They re-sync on
    // "sidebar-resize-end".
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
      // Let suppressed components run one final layout now that the drag
      // has settled.
      window.dispatchEvent(new Event("sidebar-resize-end"));
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [setSidebarWidth]);

  const currentBackend = appSettings?.agent_backend ?? "claude";

  return (
    <aside
      ref={sidebarRef}
      className="flex flex-col bg-bg-secondary border-r border-border-primary h-full relative no-select"
      style={{ width: sidebarWidth }}
    >
      {/* Header */}
            <div className="flex items-center justify-between px-3 h-12 border-b border-border-primary shrink-0">
        <div className="flex items-center gap-2">
          <img src="/icon.png" alt="" className="w-5 h-5" />
          <span className="text-sm font-semibold text-text-primary tracking-tight">
            Coppice
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative" ref={backendMenuRef}>
            <Tooltip text={`Default agent: ${currentBackend === "pi" ? "Pi" : "Claude"}`} align="right">
              <button
                onClick={() => setBackendMenuOpen((open) => !open)}
                disabled={!appSettings || switchingBackend}
                className={`h-6 min-w-7 px-2 flex items-center justify-center rounded-md text-[11px] font-semibold uppercase border transition-colors ${currentBackend === "pi" ? "bg-purple-500/10 text-purple-400 border-purple-500/20" : "bg-orange-500/10 text-orange-400 border-orange-500/20"} ${appSettings && !switchingBackend ? "hover:brightness-125" : ""} disabled:opacity-50`}
              >
                {currentBackend === "pi" ? "Pi" : "Cl"}
              </button>
            </Tooltip>
            {backendMenuOpen && (
              <div className="absolute right-0 top-8 z-20 w-44 rounded-md border border-border-primary bg-bg-secondary shadow-xl p-1.5">
                {([
                  { value: "claude", label: "Claude agent", hint: appSettings?.agent_default_model || "Default model" },
                  { value: "pi", label: "Pi agent", hint: appSettings?.pi_default_model || "Default model" },
                ] as const).map((option) => {
                  const active = currentBackend === option.value;
                  return (
                    <button
                      key={option.value}
                      onClick={() => handleBackendSelect(option.value)}
                      className={`w-full text-left rounded px-2 py-1.5 transition-colors ${active ? option.value === "pi" ? "bg-purple-500/10 text-purple-400" : "bg-orange-500/10 text-orange-400" : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"}`}
                    >
                      <div className="text-[11px] font-medium">{option.label}</div>
                      <div className="text-[10px] text-text-tertiary truncate">{option.hint}</div>
                    </button>
                  );
                })}
                <div className="px-2 pt-1 text-[10px] text-text-tertiary">New agent tabs use this.</div>
              </div>
            )}
          </div>
          <Tooltip text="Tile view">
            <button
              onClick={toggleTileView}
              className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${showTileView ? "text-accent bg-accent/10" : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"}`}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip text="Settings">
            <button
              onClick={openAppSettings}
              className="w-6 h-6 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
          <Tooltip text="Add project" align="right">
            <button
              onClick={() => openProjectSettings("new")}
              className="w-6 h-6 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
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
      </div>

      {/* Project list — scrollable */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
        <ScratchpadNode />
        <ProjectTree />
      </div>

      {/* Changes / PR panel */}
      <ChangesPanel />

      {/* Setup / Build / Run runners */}
      <SidebarRunners />

      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30 active:bg-accent/50"
        onMouseDown={onMouseDown}
      />
    </aside>
  );
}
