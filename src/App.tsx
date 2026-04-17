import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { onAction } from "@tauri-apps/plugin-notification";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WorktreeView } from "./components/WorktreeView/WorktreeView";
import { ProjectSettingsModal } from "./components/ProjectSettings/ProjectSettingsModal";
import { AppSettingsModal } from "./components/AppSettings/AppSettingsModal";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { AgentPanel } from "./components/AgentView/AgentPanel";
import { useAppStore, flushAllAgentTabCaches } from "./stores/appStore";
import { setWindowFocused } from "./lib/windowFocus";
import * as commands from "./lib/commands";

function App() {
  const editingProject = useAppStore((s) => s.editingProject);
  const editingAppSettings = useAppStore((s) => s.editingAppSettings);
  const appSettings = useAppStore((s) => s.appSettings);
  const loadSettings = useAppStore((s) => s.loadSettings);
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
        if (tab.type === "diff" || tab.type === "agent") continue;
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

  // Memoize agent tab list
  const agentTabs = useMemo(() => {
    const result: Array<{ id: string; cwd: string; command?: string; visible: boolean }> = [];
    for (const [wtId, tabs] of Object.entries(tabsByWorktree)) {
      const activeTab = activeTabByWorktree[wtId];
      for (const tab of tabs) {
        if (tab.type !== "agent") continue;
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

  // Load app settings on mount
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Apply window decorations setting
  useEffect(() => {
    if (appSettings !== null) {
      getCurrentWindow().setDecorations(appSettings.window_decorations).catch(() => {});
    }
  }, [appSettings?.window_decorations]);

  const termFontFamily = appSettings?.terminal_font_family || undefined;
  const termFontSize = appSettings?.terminal_font_size || undefined;

  // Track window focus + clear idle on focus-regain. Two things happen here:
  //   1. setWindowFocused() keeps the shared flag in sync so the store's
  //      notification gating (appStore.setClaudeStatus) knows whether the
  //      user can actually see the visible tab.
  //   2. When focus is regained, clear the idle indicator on the currently
  //      visible agent tab (the tab the user can now actually see). Other
  //      idle agent tabs stay lit so the user can tell which specific tab
  //      needs attention.
  useEffect(() => {
    // Seed the shared flag with the real window state on mount, in case
    // the first onFocusChanged event lags behind our first PTY output.
    getCurrentWindow().isFocused().then(setWindowFocused).catch(() => {});

    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      setWindowFocused(focused);
      if (!focused) return;
      const s = useAppStore.getState();
      const wtId = s.selectedWorktreeId;
      if (!wtId) return;
      const activeId = s.activeTabByWorktree[wtId];
      if (!activeId) return;
      if (s.claudeStatusByTab[activeId] !== "idle") return;
      const { [activeId]: _, ...rest } = s.claudeStatusByTab;
      useAppStore.setState({ claudeStatusByTab: rest });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Keep the dock/taskbar badge in sync with the number of idle agent tabs.
  // macOS: shows a number badge on the dock icon.
  // Linux: depends on desktop env (Unity, GNOME with extension).
  // Windows: not supported by set_badge_count (no-op).
  useEffect(() => {
    let prevCount = 0;
    const unsub = useAppStore.subscribe((state) => {
      const idleCount = Object.values(state.claudeStatusByTab).filter(
        (s) => s === "idle"
      ).length;
      if (idleCount !== prevCount) {
        prevCount = idleCount;
        getCurrentWindow()
          .setBadgeCount(idleCount > 0 ? idleCount : undefined)
          .catch(() => {});
      }
    });
    return unsub;
  }, []);

  // Bring window to foreground when user clicks an OS notification.
  useEffect(() => {
    const listener = onAction(() => {
      getCurrentWindow().unminimize().catch(() => {});
      getCurrentWindow().setFocus().catch(() => {});
    });
    return () => { listener.then((l) => l.unregister()); };
  }, []);

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

  // Flush all agent tab caches to the DB before the window unloads, so that
  // conversations can be restored on the next launch.
  // We intentionally use the browser `beforeunload` event instead of Tauri's
  // `onCloseRequested`, because onCloseRequested wraps each listener with its
  // own `await handler(); window.destroy()` — registering multiple handlers
  // causes double-destroy and blocks the window from closing.
  useEffect(() => {
    const handler = () => { flushAllAgentTabCaches().catch(() => {}); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  // Tab keyboard shortcuts — capture phase so xterm and the webview's native
  // Ctrl+W / Ctrl+T don't get a chance to consume them first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
      if (!mod) return;
      const state = useAppStore.getState();
      const wt = state.selectedWorktreeId;
      if (!wt) return;

      // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs. Handled first so the Shift
      // branch below doesn't fight with Ctrl+Shift+Tab.
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopImmediatePropagation();
        state.cycleTab(wt, e.shiftKey ? -1 : 1);
        return;
      }

      // Use e.code for letter combos so non-US layouts that remap Shift+T
      // still work.
      if (e.shiftKey) {
        if (e.code === "KeyT") {
          e.preventDefault();
          e.stopImmediatePropagation();
          // Ctrl+Shift+T creates the default Claude tab type
          const mode = state.appSettings?.default_claude_mode;
          if (mode === "agent") {
            state.newAgentTab(wt);
          } else {
            state.newClaudeTab(wt);
          }
        } else if (e.code === "KeyA") {
          // Ctrl+Shift+A always creates an agent tab
          e.preventDefault();
          e.stopImmediatePropagation();
          state.newAgentTab(wt);
        }
        return;
      }

      switch (e.key) {
        case "PageDown":
          e.preventDefault();
          e.stopImmediatePropagation();
          state.cycleTab(wt, 1);
          break;
        case "PageUp":
          e.preventDefault();
          e.stopImmediatePropagation();
          state.cycleTab(wt, -1);
          break;
        case "w":
        case "W":
          e.preventDefault();
          e.stopImmediatePropagation();
          state.closeActiveTab(wt);
          break;
        case "t":
        case "T":
          e.preventDefault();
          e.stopImmediatePropagation();
          state.newTerminalTab(wt);
          break;
      }
    };
    document.addEventListener("keydown", onKey, { capture: true });
    return () => document.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0 bg-bg-primary relative">
        <WorktreeView />
        {/* Terminal + Agent layer — always mounted */}
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
              <TerminalPanel sessionId={t.id} cwd={t.cwd} command={t.command} fontSize={termFontSize} fontFamily={termFontFamily} keepAlive />
            </div>
          ))}
          {agentTabs.map((t) => (
            <div
              key={t.id}
              className="absolute inset-0"
              style={{
                visibility: t.visible ? "visible" : "hidden",
                pointerEvents: t.visible ? "auto" : "none",
              }}
            >
              <AgentPanel sessionId={t.id} cwd={t.cwd} initialPrompt={t.command} visible={t.visible} />
            </div>
          ))}
        </div>
      </main>

      {/* Runner terminal pool */}
      <div id="runner-terminal-pool" style={{ position: "fixed", left: -9999, top: -9999, width: 400, height: 9999 }}>
        {allRunners.map((r) => (
          <div key={r.id} id={`runner-term-${r.id}`} style={{ width: "100%", height: 150 }}>
            <TerminalPanel sessionId={r.id} cwd={r.cwd} command={r.command} fontSize={termFontSize ? Math.max(8, termFontSize - 3) : 10} fontFamily={termFontFamily} keepAlive />
          </div>
        ))}
      </div>

      {editingProject !== null && <ProjectSettingsModal />}
      {editingAppSettings && <AppSettingsModal />}
    </div>
  );
}

export default App;
