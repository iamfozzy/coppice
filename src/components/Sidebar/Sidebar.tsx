import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { ProjectTree } from "./ProjectTree";
import { ChangesPanel } from "./ChangesPanel";
import { SidebarRunners } from "./SidebarRunners";

export function Sidebar() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const openAppSettings = useAppStore((s) => s.openAppSettings);
  const loadProjects = useAppStore((s) => s.loadProjects);

  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

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
        <div className="flex items-center gap-1">
          <button
            onClick={openAppSettings}
            className="w-6 h-6 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="App settings"
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
          <button
            onClick={() => openProjectSettings("new")}
            className="w-6 h-6 flex items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
            title="Add project"
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
        </div>
      </div>

      {/* Project list — scrollable */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">
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
