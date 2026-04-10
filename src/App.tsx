import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WorktreeView } from "./components/WorktreeView/WorktreeView";
import { ProjectSettingsModal } from "./components/ProjectSettings/ProjectSettingsModal";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { useAppStore } from "./stores/appStore";
import * as commands from "./lib/commands";

function App() {
  const editingProject = useAppStore((s) => s.editingProject);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const activeTabByWorktree = useAppStore((s) => s.activeTabByWorktree);
  const runnersByWorktree = useAppStore((s) => s.runnersByWorktree);

  // Memoize terminal tab list — only recompute when tabs/active/selection change
  const terminalTabs = useMemo(() => {
    const result: Array<{ id: string; cwd: string; command?: string; visible: boolean }> = [];
    for (const [wtId, tabs] of Object.entries(tabsByWorktree)) {
      const activeTab = activeTabByWorktree[wtId];
      for (const tab of tabs) {
        if (tab.type === "diff") continue;
        result.push({
          id: tab.id,
          cwd: tab.cwd,
          command: tab.command,
          visible: wtId === selectedWorktreeId && tab.id === activeTab,
        });
      }
    }
    return result;
  }, [tabsByWorktree, activeTabByWorktree, selectedWorktreeId]);

  // Memoize runner list
  const allRunners = useMemo(() => {
    const result: Array<{ id: string; cwd: string; command: string }> = [];
    for (const [, runners] of Object.entries(runnersByWorktree)) {
      for (const [, runner] of Object.entries(runners)) {
        if (runner.status === "idle") continue;
        result.push({ id: runner.id, cwd: runner.cwd, command: runner.command });
      }
    }
    return result;
  }, [runnersByWorktree]);

  // Single window-level file drop handler — routes to active session only
  useEffect(() => {
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const { selectedWorktreeId: wtId, activeTabByWorktree: activeTab } = useAppStore.getState();
      if (!wtId) return;
      const activeSessionId = activeTab[wtId];
      if (!activeSessionId) return;
      const paths = event.payload.paths;
      if (paths.length > 0) {
        const text = paths.map((p: string) => `"${p}"`).join(" ");
        commands.terminalWrite(activeSessionId, text).catch(() => {});
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 bg-bg-primary relative">
        <WorktreeView />
        {/* Terminal layer — always mounted */}
        <div id="terminal-layer" className="absolute inset-0" style={{ top: "calc(3rem + 2.5rem)", pointerEvents: "none" }}>
          {terminalTabs.map((t) => (
            <div
              key={t.id}
              className="absolute inset-0"
              style={{
                visibility: t.visible ? "visible" : "hidden",
                pointerEvents: t.visible ? "auto" : "none",
              }}
            >
              <TerminalPanel sessionId={t.id} cwd={t.cwd} command={t.command} keepAlive />
            </div>
          ))}
        </div>
      </main>

      {/* Runner terminal pool */}
      <div id="runner-terminal-pool" style={{ position: "fixed", left: -9999, top: -9999, width: 400, height: 9999 }}>
        {allRunners.map((r) => (
          <div key={r.id} id={`runner-term-${r.id}`} style={{ width: "100%", height: 150 }}>
            <TerminalPanel sessionId={r.id} cwd={r.cwd} command={r.command} fontSize={10} keepAlive />
          </div>
        ))}
      </div>

      {editingProject !== null && <ProjectSettingsModal />}
    </div>
  );
}

export default App;
