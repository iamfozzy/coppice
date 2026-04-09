import { Sidebar } from "./components/Sidebar/Sidebar";
import { WorktreeView } from "./components/WorktreeView/WorktreeView";
import { ProjectSettingsModal } from "./components/ProjectSettings/ProjectSettingsModal";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { useAppStore } from "./stores/appStore";

function App() {
  const editingProject = useAppStore((s) => s.editingProject);
  const selectedWorktreeId = useAppStore((s) => s.selectedWorktreeId);
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree);
  const activeTabByWorktree = useAppStore((s) => s.activeTabByWorktree);
  const runnersByWorktree = useAppStore((s) => s.runnersByWorktree);

  // Collect ALL tab terminals across all worktrees
  const allTabs: Array<{
    id: string;
    cwd: string;
    command?: string;
    visible: boolean;
  }> = [];

  for (const [wtId, tabs] of Object.entries(tabsByWorktree)) {
    const activeTab = activeTabByWorktree[wtId];
    for (const tab of tabs) {
      allTabs.push({
        id: tab.id,
        cwd: tab.cwd,
        command: tab.command,
        visible: wtId === selectedWorktreeId && tab.id === activeTab,
      });
    }
  }

  // Collect ALL runner terminals across all worktrees
  const allRunners: Array<{
    id: string;
    cwd: string;
    command: string;
  }> = [];

  for (const [, runners] of Object.entries(runnersByWorktree)) {
    for (const [, runner] of Object.entries(runners)) {
      allRunners.push({
        id: runner.id,
        cwd: runner.cwd,
        command: runner.command,
      });
    }
  }

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 bg-bg-primary relative">
        <WorktreeView />
        {/* All tab terminals — always mounted, visibility-controlled */}
        <div id="terminal-layer" className="absolute inset-0" style={{ top: "calc(3rem + 2.25rem)", pointerEvents: "none" }}>
          {allTabs.map((t) => (
            <div
              key={t.id}
              className="absolute inset-0"
              style={{
                visibility: t.visible ? "visible" : "hidden",
                pointerEvents: t.visible ? "auto" : "none",
              }}
            >
              <TerminalPanel
                sessionId={t.id}
                cwd={t.cwd}
                command={t.command}
                keepAlive
              />
            </div>
          ))}
        </div>
      </main>

      {/* Hidden pool for runner terminals — always mounted, never unmounts.
          SidebarRunners uses DOM reparenting to move these into visible slots. */}
      <div id="runner-terminal-pool" style={{ position: "fixed", left: -9999, top: -9999, width: 400, height: 9999 }}>
        {allRunners.map((r) => (
          <div key={r.id} id={`runner-term-${r.id}`} style={{ width: "100%", height: 150 }}>
            <TerminalPanel
              sessionId={r.id}
              cwd={r.cwd}
              command={r.command}
              fontSize={10}
              keepAlive
            />
          </div>
        ))}
      </div>

      {editingProject !== null && <ProjectSettingsModal />}
    </div>
  );
}

export default App;
