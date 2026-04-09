import { create } from "zustand";
import type { Project, Worktree } from "../lib/types";
import * as commands from "../lib/commands";

// ── Session types ──

export interface TabInfo {
  id: string;
  type: "terminal" | "claude";
  label: string;
  command?: string;
  cwd: string;
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

  // UI state
  selectedProjectId: string | null;
  selectedWorktreeId: string | null;
  editingProject: "new" | string | null;
  sidebarWidth: number;
  pendingClaudeCommand: string | null;
  pendingRunner: { key: string } | null;

  // Per-worktree sessions (keyed by worktree ID)
  tabsByWorktree: Record<string, TabInfo[]>;
  activeTabByWorktree: Record<string, string | null>;
  runnersByWorktree: Record<string, Record<string, RunnerInfo>>;

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
  deleteWorktree: (id: string, projectId: string) => Promise<void>;

  // Actions — tabs
  addTab: (worktreeId: string, type: "terminal" | "claude", cwd: string, command?: string) => void;
  closeTab: (worktreeId: string, tabId: string) => void;
  setActiveTab: (worktreeId: string, tabId: string) => void;

  // Actions — runners
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
  selectedProjectId: null,
  selectedWorktreeId: null,
  editingProject: null,
  sidebarWidth: 260,
  pendingClaudeCommand: null,
  pendingRunner: null,
  tabsByWorktree: {},
  activeTabByWorktree: {},
  runnersByWorktree: {},

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
  selectWorktree: (id) => set({ selectedWorktreeId: id }),

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

  deleteWorktree: async (id, projectId) => {
    await commands.deleteWorktree(id);
    if (get().selectedWorktreeId === id) {
      set({ selectedWorktreeId: null });
    }
    await get().loadWorktrees(projectId);
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

  closeTab: (worktreeId, tabId) => {
    const s = get();
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    const next = tabs.filter((t) => t.id !== tabId);
    const activeTab = s.activeTabByWorktree[worktreeId];
    let newActive = activeTab;
    if (activeTab === tabId) {
      newActive = next.length > 0 ? next[next.length - 1].id : null;
    }
    set({
      tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: next },
      activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: newActive },
    });
  },

  setActiveTab: (worktreeId, tabId) => {
    set((s) => ({
      activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: tabId },
    }));
  },

  // ── Runners ──

  openOrRestartRunner: async (worktreeId, key, command, cwd) => {
    const s = get();
    const runners = s.runnersByWorktree[worktreeId] ?? {};
    const old = runners[key];

    // Kill old PTY if it exists
    if (old) {
      await commands.terminalKill(old.id).catch(() => {});
    }

    const runner: RunnerInfo = {
      id: `runner-${key}-${worktreeId}-${Date.now()}`,
      open: true,
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
