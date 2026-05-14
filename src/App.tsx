import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { onAction } from "@tauri-apps/plugin-notification";
import { Sidebar } from "./components/Sidebar/Sidebar";
import { WorktreeView } from "./components/WorktreeView/WorktreeView";
import { ProjectSettingsModal } from "./components/ProjectSettings/ProjectSettingsModal";
import { AppSettingsModal } from "./components/AppSettings/AppSettingsModal";
import { TerminalPanel } from "./components/Terminal/TerminalPanel";
import { AgentPanel } from "./components/AgentView/AgentPanel";
import { TileView } from "./components/TileView/TileView";
import { useAppStore, flushAllAgentTabCaches } from "./stores/appStore";
import { SCRATCHPAD_WORKTREE_ID } from "./lib/types";
import { setWindowFocused } from "./lib/windowFocus";
import { applyTheme } from "./lib/theme";
import { DEFAULT_APP_FONT_SIZE, applyAppFontSize, getScaledFontSize } from "./lib/fontScale";
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
  const showTileView = useAppStore((s) => s.showTileView);

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

  // Apply app-wide font scaling.
  useEffect(() => {
    applyAppFontSize(appSettings?.app_font_size ?? DEFAULT_APP_FONT_SIZE);
  }, [appSettings?.app_font_size]);

  // Apply theme setting and listen for OS preference changes in "system" mode
  useEffect(() => {
    const mode = appSettings?.theme ?? "dim";
    applyTheme(mode);
    if (mode === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [appSettings?.theme]);

  // On macOS with overlay titlebar, push content below the traffic lights.
  // In fullscreen or when decorations are off, the inset is 0.

  const appFontSize = appSettings?.app_font_size ?? DEFAULT_APP_FONT_SIZE;
  const termFontFamily = appSettings?.terminal_font_family || undefined;
  const termFontSize = appSettings?.terminal_font_size || getScaledFontSize(13, appFontSize);
  const runnerTermFontSize = appSettings?.terminal_font_size
    ? Math.max(8, appSettings.terminal_font_size - 3)
    : getScaledFontSize(10, appFontSize);

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
      s.clearClaudeIdleStatus(activeId);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Keep the dock/taskbar badge in sync with the number of idle agent tabs.
  // macOS: shows a number badge on the dock icon.
  // Linux: depends on desktop env (Unity, GNOME with extension).
  // Windows: not supported by set_badge_count (no-op).
  //
  // The Zustand `subscribe` callback fires on *every* store mutation —
  // including each per-token `updateAgentStreamingText` during agent
  // streaming. The Object.values + filter walk over `claudeStatusByTab` is
  // cheap individually but adds up to thousands of unnecessary calls per
  // second at typical token rates. Gate the walk on a reference-equality
  // check: `claudeStatusByTab` is only re-assigned when an action actually
  // touches it (setClaudeStatus, removeClaudeStatus, clearClaudeIdleStatus,
  // closeTab, setActiveTab, cycleTab) — never by streaming-text updates.
  useEffect(() => {
    let prevStatusMap = useAppStore.getState().claudeStatusByTab;
    let prevCount = Object.values(prevStatusMap).filter((s) => s === "idle").length;
    // Initialise the badge on mount so a restart with idle tabs already
    // shows the count without waiting for the next status change.
    getCurrentWindow()
      .setBadgeCount(prevCount > 0 ? prevCount : undefined)
      .catch(() => {});

    const unsub = useAppStore.subscribe((state) => {
      if (state.claudeStatusByTab === prevStatusMap) return;
      prevStatusMap = state.claudeStatusByTab;
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
    const listener = onAction((notification) => {
      const projectId = typeof notification.extra?.projectId === "string"
        ? notification.extra.projectId
        : null;
      const worktreeId = typeof notification.extra?.worktreeId === "string"
        ? notification.extra.worktreeId
        : null;
      const tabId = typeof notification.extra?.tabId === "string"
        ? notification.extra.tabId
        : null;
      if (projectId && worktreeId && tabId) {
        const store = useAppStore.getState();
        store.selectProject(projectId);
        store.selectWorktree(worktreeId);
        store.setActiveTab(worktreeId, tabId);
      }
      getCurrentWindow().unminimize().catch(() => {});
      getCurrentWindow().setFocus().catch(() => {});
    });
    return () => { listener.then((l) => l.unregister()); };
  }, []);

  // Single window-level file drop handler — routes to active session only.
  // For agent tabs, image files are converted to base64 and queued as image
  // attachments for the agent input bar; for terminal tabs, file paths are
  // written as text.
  useEffect(() => {
    const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const store = useAppStore.getState();
      const wtId = store.selectedWorktreeId;
      if (!wtId) return;
      const activeSessionId = store.activeTabByWorktree[wtId];
      if (!activeSessionId) return;

      const paths: string[] = event.payload.paths;
      if (paths.length === 0) return;

      // Determine if the active tab is an agent tab
      const tabs = store.tabsByWorktree[wtId] ?? [];
      const activeTab = tabs.find((t) => t.id === activeSessionId);

      if (activeTab?.type === "agent") {
        // Filter to image files only and read them as base64
        const imagePaths = paths.filter((p) => {
          const ext = p.split(".").pop()?.toLowerCase() ?? "";
          return IMAGE_EXTENSIONS.has(ext);
        });
        if (imagePaths.length === 0) return;

        Promise.all(imagePaths.map((p) => commands.readImageBase64(p)))
          .then((results) => {
            const attachments = results.map((r) => ({
              data: r.data,
              mediaType: r.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              fileName: r.file_name,
            }));
            useAppStore.getState().pushDroppedImages(activeSessionId, attachments);
          })
          .catch(() => {});
      } else {
        // Terminal tab — write file paths as text
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

  // Refresh project/worktree data when the Rust backend signals a change
  // (e.g. a Coppice tool created a new worktree).
  useEffect(() => {
    const unlisten = listen<string>("worktrees-changed", () => {
      useAppStore.getState().loadProjects();
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // ── Coppice IDE tool actions ──
  // The Rust backend emits "coppice-action" events when an agent calls a Coppice
  // tool that requires frontend/UI work (spawning tabs or opening files).
  useEffect(() => {
    const unlisten = listen<string>("coppice-action", (event) => {
      let action: Record<string, unknown>;
      try {
        action = JSON.parse(event.payload as string);
      } catch {
        return;
      }

      const store = useAppStore.getState();

      switch (action.action) {
        case "spawn_terminal": {
          const cwd = (action.cwd as string) || "";
          const command = (action.command as string) || undefined;
          // Rust resolves the worktree ID from the cwd; fall back to selected
          const wtId = (action.worktreeId as string) || store.selectedWorktreeId;
          if (wtId) {
            store.addTab(wtId, "terminal", cwd, command);
          }
          break;
        }

        case "open_file": {
          const filePath = (action.path as string) || "";
          const wtId = (action.worktreeId as string) || store.selectedWorktreeId;
          if (wtId) {
            // Derive the relative file path from the worktree root
            const worktreePath = store.getWorktreePath(wtId);
            const relFile = filePath.startsWith(worktreePath)
              ? filePath.slice(worktreePath.length).replace(/^[/\\]/, "")
              : filePath;
            store.openDiffTab(wtId, relFile, worktreePath, "uncommitted");
          }
          break;
        }

        case "open_scratchpad": {
          const content = (action.content as string) || "";
          const title = (action.title as string) || undefined;
          const spWorktree = store.scratchpadWorktree;
          if (spWorktree) {
            store.addAgentTab(SCRATCHPAD_WORKTREE_ID, spWorktree.path, content);
            // If a title was provided, rename the newly created tab
            if (title) {
              const tabs = store.tabsByWorktree[SCRATCHPAD_WORKTREE_ID] ?? [];
              const lastTab = tabs[tabs.length - 1];
              if (lastTab) store.renameTab(SCRATCHPAD_WORKTREE_ID, lastTab.id, title);
            }
          }
          break;
        }

        case "worktree_created": {
          const projectId = (action.projectId as string) || "";
          const worktreeId = (action.worktreeId as string) || "";
          const prompt = (action.prompt as string) || "";
          // Refresh projects so the new worktree appears, then switch to it
          (async () => {
            await store.loadProjects();
            const s = useAppStore.getState();
            if (projectId) s.selectProject(projectId);
            if (worktreeId) s.selectWorktree(worktreeId);
            // Spawn an agent tab with the delegated task
            if (prompt && worktreeId) {
              const wtPath = s.getWorktreePath(worktreeId);
              if (wtPath) {
                s.addAgentTab(worktreeId, wtPath, prompt);
              }
            }
          })();
          break;
        }

      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Tab keyboard shortcuts — capture phase so xterm and the webview's native
  // Ctrl+W / Ctrl+T don't get a chance to consume them first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes tile view
      if (e.key === "Escape") {
        const state = useAppStore.getState();
        if (state.showTileView) {
          e.preventDefault();
          state.toggleTileView();
          return;
        }
      }

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
        {showTileView && <TileView />}
      </main>

      {/* Runner terminal pool */}
      <div id="runner-terminal-pool" style={{ position: "fixed", left: -9999, top: -9999, width: 400, height: 9999 }}>
        {allRunners.map((r) => (
          <div key={r.id} id={`runner-term-${r.id}`} style={{ width: "100%", height: 150 }}>
            <TerminalPanel sessionId={r.id} cwd={r.cwd} command={r.command} fontSize={runnerTermFontSize} fontFamily={termFontFamily} keepAlive />
          </div>
        ))}
      </div>

      {editingProject !== null && <ProjectSettingsModal />}
      {editingAppSettings && <AppSettingsModal />}
    </div>
  );
}

export default App;
