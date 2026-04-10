import { useEffect, useRef, useCallback } from "react";
import { useAppStore } from "../../stores/appStore";
import { ProjectTree } from "./ProjectTree";
import { ChangesPanel } from "./ChangesPanel";
import { SidebarRunners } from "./SidebarRunners";

export function Sidebar() {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const openProjectSettings = useAppStore((s) => s.openProjectSettings);
  const loadProjects = useAppStore((s) => s.loadProjects);

  const isResizing = useRef(false);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const onMouseDown = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const width = Math.max(310, Math.min(500, e.clientX));
      setSidebarWidth(width);
    };

    const onMouseUp = () => {
      isResizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, [setSidebarWidth]);

  return (
    <aside
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
        className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors"
        onMouseDown={onMouseDown}
      />
    </aside>
  );
}
