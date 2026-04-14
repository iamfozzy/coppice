import { create } from "zustand";
import type { Project, Worktree, AppSettings } from "../lib/types";
import * as commands from "../lib/commands";
import { playNotificationSound } from "../lib/sounds";

export type ClaudeStatus = "active" | "idle";

// ── Session types ──

export interface TabInfo {
  id: string;
  type: "terminal" | "claude" | "diff";
  label: string;
  command?: string;
  cwd: string;
  // For diff tabs
  diffFile?: string;
  diffMode?: "uncommitted" | "pr";
  diffBaseBranch?: string;
}

export type RunnerStatus = "running" | "stopped" | "idle";

export interface RunnerInfo {
  id: string;
  open: boolean;
  status: RunnerStatus;
  command: string;
  cwd: string;
}

interface AppState {
  // Data
  projects: Project[];
  worktreesByProject: Record<string, Worktree[]>;
  appSettings: AppSettings | null;

  // UI state
  selectedProjectId: string | null;
  selectedWorktreeId: string | null;
  editingProject: "new" | string | null;
  sidebarWidth: number;
  pendingClaudeCommand: string | null;
  pendingRunner: { key: string } | null;
  deletingWorktreeIds: Set<string>;

  // Per-worktree sessions (keyed by worktree ID)
  tabsByWorktree: Record<string, TabInfo[]>;
  activeTabByWorktree: Record<string, string | null>;
  runnersByWorktree: Record<string, Record<string, RunnerInfo>>;

  // Claude tab activity status (keyed by tab ID)
  claudeStatusByTab: Record<string, ClaudeStatus>;

  // PR comments (keyed by project ID)
  prCommentsByProject: Record<string, import("../lib/commands").PrComment[]>;

  // Actions — settings
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;

  // Actions — general
  loadProjects: () => Promise<void>;
  loadWorktrees: (projectId: string) => Promise<void>;
  selectProject: (id: string | null) => void;
  selectWorktree: (id: string | null) => void;
  openProjectSettings: (mode: "new" | string) => void;
  closeProjectSettings: () => void;
  setSidebarWidth: (width: number) => void;
  requestClaudeTab: (command: string) => void;
  consumeClaudeCommand: () => string | null;
  requestRunner: (key: string) => void;
  consumeRunner: () => { key: string } | null;

  // Actions — CRUD
  createProject: (data: Parameters<typeof commands.createProject>[0]) => Promise<void>;
  updateProject: (id: string, data: Parameters<typeof commands.updateProject>[1]) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createWorktree: (projectId: string, branch: string, name: string) => Promise<void>;
  renameWorktree: (id: string, projectId: string, name: string) => Promise<void>;
  setWorktreeTargetBranch: (id: string, projectId: string, targetBranch: string | null) => Promise<void>;
  deleteWorktree: (id: string, projectId: string) => Promise<void>;

  // Actions — app settings modal
  editingAppSettings: boolean;
  openAppSettings: () => void;
  closeAppSettings: () => void;

  // Actions — PR comments
  setPrComments: (projectId: string, comments: import("../lib/commands").PrComment[]) => void;

  // Actions — Claude status
  setClaudeStatus: (tabId: string, status: ClaudeStatus) => void;
  removeClaudeStatus: (tabId: string) => void;

  // Actions — tabs
  addTab: (worktreeId: string, type: "terminal" | "claude", cwd: string, command?: string) => void;
  openDiffTab: (worktreeId: string, file: string, cwd: string, mode: "uncommitted" | "pr", baseBranch?: string) => void;
  closeTab: (worktreeId: string, tabId: string) => void;
  setActiveTab: (worktreeId: string, tabId: string) => void;
  cycleTab: (worktreeId: string, direction: 1 | -1) => void;
  closeActiveTab: (worktreeId: string) => void;
  newTerminalTab: (worktreeId: string) => void;
  newClaudeTab: (worktreeId: string) => void;

  // Actions — runners
  expandRunner: (worktreeId: string, key: string, command: string, cwd: string) => void;
  openOrRestartRunner: (worktreeId: string, key: string, command: string, cwd: string) => void;
  toggleRunner: (worktreeId: string, key: string) => void;
  closeRunner: (worktreeId: string, key: string) => void;
  setRunnerStatus: (worktreeId: string, key: string, status: RunnerStatus) => void;

  // Helpers
  getWorktreePath: (worktreeId: string) => string;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  worktreesByProject: {},
  appSettings: null,
  selectedProjectId: null,
  selectedWorktreeId: null,
  editingProject: null,
  sidebarWidth: 310,
  pendingClaudeCommand: null,
  pendingRunner: null,
  deletingWorktreeIds: new Set(),
  tabsByWorktree: {},
  activeTabByWorktree: {},
  runnersByWorktree: {},
  claudeStatusByTab: {},
  prCommentsByProject: {},
  editingAppSettings: false,

  // ── Settings ──

  loadSettings: async () => {
    const settings = await commands.getSettings();
    set({ appSettings: settings });
  },

  saveSettings: async (settings) => {
    await commands.updateSettings(settings);
    set({ appSettings: settings });
  },

  openAppSettings: () => set({ editingAppSettings: true }),
  closeAppSettings: () => set({ editingAppSettings: false }),

  // ── General ──

  requestClaudeTab: (command) => set({ pendingClaudeCommand: command }),
  consumeClaudeCommand: () => {
    const cmd = get().pendingClaudeCommand;
    if (cmd) set({ pendingClaudeCommand: null });
    return cmd;
  },
  requestRunner: (key) => set({ pendingRunner: { key } }),
  consumeRunner: () => {
    const r = get().pendingRunner;
    if (r) set({ pendingRunner: null });
    return r;
  },

  loadProjects: async () => {
    const projects = await commands.listProjects();
    set({ projects });
    for (const project of projects) {
      get().loadWorktrees(project.id);
    }
  },

  loadWorktrees: async (projectId) => {
    const worktrees = await commands.listWorktrees(projectId);
    set((s) => ({
      worktreesByProject: { ...s.worktreesByProject, [projectId]: worktrees },
    }));
  },

  selectProject: (id) => set({ selectedProjectId: id }),
  selectWorktree: (id) => {
    set({ selectedWorktreeId: id });
    // Clear idle indicators on ALL claude tabs in the newly selected worktree
    // so the sidebar dot disappears when the user navigates here.
    if (id) {
      const s = get();
      const tabs = s.tabsByWorktree[id] ?? [];
      const idleTabs = tabs.filter(
        (t) => t.type === "claude" && s.claudeStatusByTab[t.id] === "idle",
      );
      if (idleTabs.length > 0) {
        const updated = { ...s.claudeStatusByTab };
        for (const t of idleTabs) delete updated[t.id];
        set({ claudeStatusByTab: updated });
      }
    }
  },

  openProjectSettings: (mode) => set({ editingProject: mode }),
  closeProjectSettings: () => set({ editingProject: null }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  createProject: async (data) => {
    await commands.createProject(data);
    await get().loadProjects();
  },

  updateProject: async (id, data) => {
    await commands.updateProject(id, data);
    await get().loadProjects();
  },

  deleteProject: async (id) => {
    await commands.deleteProject(id);
    if (get().selectedProjectId === id) {
      set({ selectedProjectId: null, selectedWorktreeId: null });
    }
    await get().loadProjects();
  },

  createWorktree: async (projectId, branch, name) => {
    await commands.createWorktree(projectId, branch, name);
    await get().loadWorktrees(projectId);
  },

  renameWorktree: async (id, projectId, name) => {
    await commands.renameWorktree(id, name);
    await get().loadWorktrees(projectId);
  },

  setWorktreeTargetBranch: async (id, projectId, targetBranch) => {
    await commands.setWorktreeTargetBranch(id, targetBranch);
    await get().loadWorktrees(projectId);
  },

  deleteWorktree: async (id, projectId) => {
    // Mark as deleting immediately for UI feedback
    set((s) => ({
      deletingWorktreeIds: new Set([...s.deletingWorktreeIds, id]),
    }));
    if (get().selectedWorktreeId === id) {
      set({ selectedWorktreeId: null });
    }
    // Async cleanup
    await commands.deleteWorktree(id);
    await get().loadWorktrees(projectId);
    // Remove from deleting set
    set((s) => {
      const next = new Set(s.deletingWorktreeIds);
      next.delete(id);
      return { deletingWorktreeIds: next };
    });
  },

  // ── PR comments ──

  setPrComments: (projectId, comments) => {
    set((s) => ({
      prCommentsByProject: { ...s.prCommentsByProject, [projectId]: comments },
    }));
  },

  // ── Claude status ──

  setClaudeStatus: (tabId, status) => {
    const prev = get().claudeStatusByTab[tabId];
    if (prev === status) return;

    set((s) => ({
      claudeStatusByTab: { ...s.claudeStatusByTab, [tabId]: status },
    }));

    // Play notification sound when Claude becomes idle and the tab is not visible
    if (status === "idle" && prev === "active") {
      const s = get();
      if (!s.appSettings?.notification_sound) return;

      // Find which worktree owns this tab
      let isVisible = false;
      for (const [wtId, tabs] of Object.entries(s.tabsByWorktree)) {
        if (tabs.some((t) => t.id === tabId)) {
          isVisible = s.selectedWorktreeId === wtId && s.activeTabByWorktree[wtId] === tabId;
          break;
        }
      }
      if (!isVisible) {
        playNotificationSound();
      }
    }
  },

  removeClaudeStatus: (tabId) => {
    const s = get();
    if (!(tabId in s.claudeStatusByTab)) return;
    const { [tabId]: _, ...rest } = s.claudeStatusByTab;
    set({ claudeStatusByTab: rest });
  },

  // ── Tabs ──

  addTab: (worktreeId, type, cwd, command) => {
    const tabs = get().tabsByWorktree[worktreeId] ?? [];
    const count = tabs.filter((t) => t.type === type).length + 1;
    const label = type === "claude" ? `Claude #${count}` : `Terminal #${count}`;
    const tab: TabInfo = {
      id: `${type}-${worktreeId}-${Date.now()}`,
      type,
      label,
      command,
      cwd,
    };
    set((s) => ({
      tabsByWorktree: {
        ...s.tabsByWorktree,
        [worktreeId]: [...(s.tabsByWorktree[worktreeId] ?? []), tab],
      },
      activeTabByWorktree: {
        ...s.activeTabByWorktree,
        [worktreeId]: tab.id,
      },
    }));
  },

  openDiffTab: (worktreeId, file, cwd, mode, baseBranch) => {
    const tabs = get().tabsByWorktree[worktreeId] ?? [];
    // Reuse existing diff tab for same file+mode
    const existing = tabs.find(
      (t) => t.type === "diff" && t.diffFile === file && t.diffMode === mode
    );
    if (existing) {
      set((s) => ({
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: existing.id },
      }));
      return;
    }
    const shortName = file.split(/[/\\]/).pop() ?? file;
    const tab: TabInfo = {
      id: `diff-${worktreeId}-${Date.now()}`,
      type: "diff",
      label: `${shortName} (${mode === "pr" ? "PR" : "diff"})`,
      cwd,
      diffFile: file,
      diffMode: mode,
      diffBaseBranch: baseBranch,
    };
    set((s) => ({
      tabsByWorktree: {
        ...s.tabsByWorktree,
        [worktreeId]: [...(s.tabsByWorktree[worktreeId] ?? []), tab],
      },
      activeTabByWorktree: {
        ...s.activeTabByWorktree,
        [worktreeId]: tab.id,
      },
    }));
  },

  closeTab: (worktreeId, tabId) => {
    const s = get();
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    const next = tabs.filter((t) => t.id !== tabId);
    const activeTab = s.activeTabByWorktree[worktreeId];
    let newActive = activeTab;
    if (activeTab === tabId) {
      newActive = next.length > 0 ? next[next.length - 1].id : null;
    }
    const claudeStatus = tabId in s.claudeStatusByTab
      ? (() => { const { [tabId]: _, ...rest } = s.claudeStatusByTab; return rest; })()
      : s.claudeStatusByTab;
    set({
      tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: next },
      activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: newActive },
      claudeStatusByTab: claudeStatus,
    });
  },

  setActiveTab: (worktreeId, tabId) => {
    set((s) => {
      const update: Partial<AppState> = {
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: tabId },
      };
      // Clear "idle" indicator when the user switches to that tab
      if (s.claudeStatusByTab[tabId] === "idle") {
        const { [tabId]: _, ...rest } = s.claudeStatusByTab;
        update.claudeStatusByTab = rest;
      }
      return update;
    });
  },

  cycleTab: (worktreeId, direction) => {
    const s = get();
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    if (tabs.length < 2) return;
    const activeId = s.activeTabByWorktree[worktreeId];
    const idx = tabs.findIndex((t) => t.id === activeId);
    const next = ((idx === -1 ? 0 : idx) + direction + tabs.length) % tabs.length;
    const nextId = tabs[next].id;
    // Clear "idle" indicator when cycling to an idle claude tab
    if (s.claudeStatusByTab[nextId] === "idle") {
      const updated = { ...s.claudeStatusByTab };
      delete updated[nextId];
      set({
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: nextId },
        claudeStatusByTab: updated,
      });
    } else {
      set({
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: nextId },
      });
    }
  },

  closeActiveTab: (worktreeId) => {
    const activeId = get().activeTabByWorktree[worktreeId];
    if (activeId) get().closeTab(worktreeId, activeId);
  },

  newTerminalTab: (worktreeId) => {
    const path = get().getWorktreePath(worktreeId);
    if (!path) return;
    get().addTab(worktreeId, "terminal", path);
  },

  newClaudeTab: (worktreeId) => {
    const s = get();
    const path = s.getWorktreePath(worktreeId);
    if (!path) return;
    // Find the project that owns this worktree to resolve its claude_command override.
    let projectId: string | null = null;
    for (const [pid, wts] of Object.entries(s.worktreesByProject)) {
      if (wts.some((w) => w.id === worktreeId)) { projectId = pid; break; }
    }
    const project = projectId ? s.projects.find((p) => p.id === projectId) : undefined;
    const claudeCmd = project?.claude_command || s.appSettings?.claude_command || "claude";
    s.addTab(worktreeId, "claude", path, claudeCmd);
  },

  // ── Runners ──

  expandRunner: (worktreeId, key, command, cwd) => {
    const runners = get().runnersByWorktree[worktreeId] ?? {};
    if (runners[key]) {
      // Already exists, just open it
      set((s) => ({
        runnersByWorktree: {
          ...s.runnersByWorktree,
          [worktreeId]: { ...s.runnersByWorktree[worktreeId], [key]: { ...runners[key], open: true } },
        },
      }));
      return;
    }
    // Create slot without spawning — idle status, no terminal ID yet
    const runner: RunnerInfo = {
      id: `runner-${key}-${worktreeId}-idle`,
      open: true,
      status: "idle",
      command,
      cwd,
    };
    set((s) => ({
      runnersByWorktree: {
        ...s.runnersByWorktree,
        [worktreeId]: { ...(s.runnersByWorktree[worktreeId] ?? {}), [key]: runner },
      },
    }));
  },

  openOrRestartRunner: async (worktreeId, key, command, cwd) => {
    const s = get();
    const runners = s.runnersByWorktree[worktreeId] ?? {};
    const old = runners[key];

    if (old && old.status !== "idle") {
      // Reuse same ID — kill old PTY, then respawn with same session ID.
      // This avoids React removing/adding DOM nodes which crashes the reparenting.
      await commands.terminalKill(old.id).catch(() => {});

      // Mark as running, keep same ID
      set((s2) => ({
        runnersByWorktree: {
          ...s2.runnersByWorktree,
          [worktreeId]: {
            ...(s2.runnersByWorktree[worktreeId] ?? {}),
            [key]: { ...old, status: "running", command, cwd },
          },
        },
      }));

      // Respawn PTY with same session ID after a short delay
      setTimeout(() => {
        commands.terminalSpawn(old.id, cwd, command).catch(() => {});
      }, 100);
    } else {
      // First run — create new entry
      const id = old?.id ?? `runner-${key}-${worktreeId}-${Date.now()}`;

      // Kill idle placeholder if it exists
      if (old) {
        await commands.terminalKill(old.id).catch(() => {});
      }

      const runner: RunnerInfo = {
        id,
        open: old?.open ?? false,
        status: "running",
        command,
        cwd,
      };
      set((s2) => ({
        runnersByWorktree: {
          ...s2.runnersByWorktree,
          [worktreeId]: { ...(s2.runnersByWorktree[worktreeId] ?? {}), [key]: runner },
        },
      }));
    }
  },

  toggleRunner: (worktreeId, key) => {
    set((s) => {
      const runners = s.runnersByWorktree[worktreeId] ?? {};
      const r = runners[key];
      if (!r) return s;
      return {
        runnersByWorktree: {
          ...s.runnersByWorktree,
          [worktreeId]: { ...runners, [key]: { ...r, open: !r.open } },
        },
      };
    });
  },

  closeRunner: async (worktreeId, key) => {
    const s = get();
    const runners = s.runnersByWorktree[worktreeId] ?? {};
    const old = runners[key];
    if (old) {
      await commands.terminalKill(old.id).catch(() => {});
    }
    const next = { ...runners };
    delete next[key];
    set({
      runnersByWorktree: { ...s.runnersByWorktree, [worktreeId]: next },
    });
  },

  setRunnerStatus: (worktreeId, key, status) => {
    set((s) => {
      const runners = s.runnersByWorktree[worktreeId] ?? {};
      const r = runners[key];
      if (!r) return s;
      return {
        runnersByWorktree: {
          ...s.runnersByWorktree,
          [worktreeId]: { ...runners, [key]: { ...r, status } },
        },
      };
    });
  },

  // ── Helpers ──

  getWorktreePath: (worktreeId) => {
    for (const wts of Object.values(get().worktreesByProject)) {
      const wt = wts.find((w) => w.id === worktreeId);
      if (wt) return wt.path;
    }
    return "";
  },
}));
