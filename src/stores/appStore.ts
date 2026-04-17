import { create } from "zustand";
import type { Project, Worktree, AppSettings, AgentSessionState, AgentMessage, AgentStatus, AgentCost, AgentPendingPermission, AgentPendingQuestion, EffortLevel, AgentPermissionMode } from "../lib/types";
import * as commands from "../lib/commands";
import { playNotificationSound } from "../lib/sounds";
import { isWindowFocused } from "../lib/windowFocus";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type ClaudeStatus = "active" | "idle";

// ── Session types ──

export interface TabInfo {
  id: string;
  type: "terminal" | "claude" | "agent" | "diff";
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
  pendingAgentPrompt: string | null;
  pendingRunner: { key: string } | null;
  deletingWorktreeIds: Set<string>;

  // Per-worktree sessions (keyed by worktree ID)
  tabsByWorktree: Record<string, TabInfo[]>;
  activeTabByWorktree: Record<string, string | null>;
  runnersByWorktree: Record<string, Record<string, RunnerInfo>>;

  // Claude tab activity status (keyed by tab ID — covers both claude and agent tabs)
  claudeStatusByTab: Record<string, ClaudeStatus>;

  // Agent session state (keyed by tab ID)
  agentSessionByTab: Record<string, AgentSessionState>;

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
  requestAgentTab: (prompt: string) => void;
  consumeAgentPrompt: () => string | null;
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
  updateWorktreeBranch: (worktreeId: string, branch: string) => void;

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
  addAgentTab: (worktreeId: string, cwd: string, prompt?: string) => void;
  newAgentTab: (worktreeId: string) => void;
  renameTab: (worktreeId: string, tabId: string, newLabel: string) => void;

  // Actions — agent session state
  appendAgentMessage: (tabId: string, message: AgentMessage) => void;
  updateAgentStreamingText: (tabId: string, text: string) => void;
  clearAgentStreamingText: (tabId: string) => void;
  setAgentStatus: (tabId: string, status: AgentStatus) => void;
  setAgentModel: (tabId: string, model: string) => void;
  setAgentEffort: (tabId: string, effort: EffortLevel) => void;
  setAgentPermissionMode: (tabId: string, mode: AgentPermissionMode) => void;
  setAgentCost: (tabId: string, cost: AgentCost) => void;
  setAgentSdkSessionId: (tabId: string, id: string) => void;
  setAgentPendingPermission: (tabId: string, pending: AgentPendingPermission | null) => void;
  setAgentPendingQuestion: (tabId: string, pending: AgentPendingQuestion | null) => void;
  removeAgentSession: (tabId: string) => void;

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
  pendingAgentPrompt: null,
  pendingRunner: null,
  deletingWorktreeIds: new Set(),
  tabsByWorktree: {},
  activeTabByWorktree: {},
  runnersByWorktree: {},
  claudeStatusByTab: {},
  agentSessionByTab: {},
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
  requestAgentTab: (prompt) => set({ pendingAgentPrompt: prompt }),
  consumeAgentPrompt: () => {
    const p = get().pendingAgentPrompt;
    if (p) set({ pendingAgentPrompt: null });
    return p;
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
    // Clear the idle dot for CLI claude tabs when the user navigates to the
    // worktree (they're now able to see it). Agent tabs keep the dot until
    // the user actually sends a new prompt — selecting a worktree isn't
    // really engagement with the agent tab contents, and losing the dot
    // here means users who switch away and come back never see the "done"
    // signal at all.
    if (id) {
      const s = get();
      const activeId = s.activeTabByWorktree[id];
      const activeTab = activeId ? s.tabsByWorktree[id]?.find((t) => t.id === activeId) : undefined;
      if (
        activeId &&
        activeTab?.type === "claude" &&
        s.claudeStatusByTab[activeId] === "idle"
      ) {
        const { [activeId]: _, ...rest } = s.claudeStatusByTab;
        set({ claudeStatusByTab: rest });
      }
      // Auto-create an agent tab when switching to a worktree with no tabs
      // and agent mode is the default.
      const tabs = s.tabsByWorktree[id];
      if ((!tabs || tabs.length === 0) && s.appSettings?.default_claude_mode === "agent") {
        get().newAgentTab(id);
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

  updateWorktreeBranch: (worktreeId, branch) => {
    set((s) => {
      const updated: Record<string, typeof s.worktreesByProject[string]> = {};
      for (const [pid, wts] of Object.entries(s.worktreesByProject)) {
        const idx = wts.findIndex((w) => w.id === worktreeId);
        if (idx !== -1 && wts[idx].branch !== branch) {
          const copy = [...wts];
          copy[idx] = { ...copy[idx], branch };
          updated[pid] = copy;
        }
      }
      if (Object.keys(updated).length === 0) return s;
      return { worktreesByProject: { ...s.worktreesByProject, ...updated } };
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
    const s = get();
    const prev = s.claudeStatusByTab[tabId];
    if (prev === status) return;

    // Determine whether the user is already watching this specific tab.
    // "Visible" means the tab is the active tab of the selected worktree;
    // "focused" means the whole window is in the foreground. Both must be
    // true for us to consider the user present.
    let isVisible = false;
    for (const [wtId, tabs] of Object.entries(s.tabsByWorktree)) {
      const tab = tabs.find((t) => t.id === tabId);
      if (tab) {
        isVisible = s.selectedWorktreeId === wtId && s.activeTabByWorktree[wtId] === tabId;
        break;
      }
    }
    const userIsWatching = isVisible && isWindowFocused();

    // Always write the status so the in-tab dot reflects what the agent is
    // actually doing (pulsing while active, warning when done/errored). We
    // used to skip the write when the user was watching to avoid "flashing"
    // a dot onto the visible tab, but that also suppressed the dot entirely
    // for users who stay on the agent tab — leaving them with no visual
    // completion cue at all. The setActiveTab + window-focus handlers still
    // clear idle state on the next real engagement (switching tabs, window
    // refocus), so the dot doesn't linger.
    set((state) => ({
      claudeStatusByTab: { ...state.claudeStatusByTab, [tabId]: status },
    }));

    // Notify when the agent becomes idle and the user can't see the tab.
    // Only agent SDK tabs drive this path (CLI tabs don't set claude status).
    if (status === "idle" && (prev === "active" || prev === undefined) && !userIsWatching) {
      if (s.appSettings?.notification_sound) {
        playNotificationSound();
      }

      // OS notification — shows even when Coppice is minimized or on
      // another virtual desktop. Respect the user's toggle and request
      // permission lazily on first use.
      if (s.appSettings?.notification_popup) {
        // Resolve tab label and worktree name for the notification body.
        let tabLabel = "";
        let worktreeName = "";
        for (const [wtId, tabs] of Object.entries(s.tabsByWorktree)) {
          const tab = tabs.find((t) => t.id === tabId);
          if (tab) {
            tabLabel = tab.label;
            // Find worktree name.
            for (const wts of Object.values(s.worktreesByProject)) {
              const wt = wts.find((w) => w.id === wtId);
              if (wt) { worktreeName = wt.name || wt.branch; break; }
            }
            break;
          }
        }

        (async () => {
          try {
            let granted = await isPermissionGranted();
            if (!granted) {
              const perm = await requestPermission();
              granted = perm === "granted";
            }
            if (granted) {
              sendNotification({
                title: "Claude is waiting",
                body: worktreeName
                  ? `${tabLabel} in ${worktreeName}`
                  : tabLabel || "A Claude tab needs attention",
              });
            }
          } catch {
            // Notification API unavailable — fail silently.
          }
        })();
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
    const prefix = type === "claude" ? "Claude" : "Terminal";
    // Use max existing number + 1 to avoid duplicates after closing tabs
    let maxNum = 0;
    for (const t of tabs) {
      if (t.type !== type) continue;
      const m = t.label.match(/^(?:Claude|Terminal) #(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    const label = `${prefix} #${maxNum + 1}`;
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
    const closedTab = tabs.find((t) => t.id === tabId);
    const next = tabs.filter((t) => t.id !== tabId);
    const activeTab = s.activeTabByWorktree[worktreeId];
    let newActive = activeTab;
    if (activeTab === tabId) {
      newActive = next.length > 0 ? next[next.length - 1].id : null;
    }
    const claudeStatus = tabId in s.claudeStatusByTab
      ? (() => { const { [tabId]: _, ...rest } = s.claudeStatusByTab; return rest; })()
      : s.claudeStatusByTab;
    const agentSession = tabId in s.agentSessionByTab
      ? (() => { const { [tabId]: _, ...rest } = s.agentSessionByTab; return rest; })()
      : s.agentSessionByTab;
    set({
      tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: next },
      activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: newActive },
      claudeStatusByTab: claudeStatus,
      agentSessionByTab: agentSession,
    });
    // Close the agent bridge process if this was an agent tab
    if (closedTab?.type === "agent") {
      commands.agentClose(tabId).catch(() => {});
    }
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

  addAgentTab: (worktreeId, cwd, prompt) => {
    const s = get();
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    let maxNum = 0;
    for (const t of tabs) {
      if (t.type !== "agent") continue;
      const m = t.label.match(/^Agent #(\d+)$/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    const label = `Agent #${maxNum + 1}`;
    const tab: TabInfo = {
      id: `agent-${worktreeId}-${Date.now()}`,
      type: "agent",
      label,
      command: prompt,
      cwd,
    };
    const sessionState: AgentSessionState = {
      messages: [],
      status: "idle",
      model: s.appSettings?.agent_default_model || "claude-opus-4-6",
      effort: s.appSettings?.agent_default_effort || "high",
      permissionMode: "acceptEdits",
      cost: null,
      sdkSessionId: null,
      pendingPermission: null,
      pendingQuestion: null,
      streamingText: "",
    };
    set((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktreeId]: [...(state.tabsByWorktree[worktreeId] ?? []), tab],
      },
      activeTabByWorktree: {
        ...state.activeTabByWorktree,
        [worktreeId]: tab.id,
      },
      agentSessionByTab: {
        ...state.agentSessionByTab,
        [tab.id]: sessionState,
      },
    }));
  },

  newAgentTab: (worktreeId) => {
    const path = get().getWorktreePath(worktreeId);
    if (!path) return;
    get().addAgentTab(worktreeId, path);
  },

  renameTab: (worktreeId, tabId, newLabel) => {
    set((s) => {
      const tabs = s.tabsByWorktree[worktreeId];
      if (!tabs) return s;
      return {
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: tabs.map((t) =>
            t.id === tabId ? { ...t, label: newLabel } : t
          ),
        },
      };
    });
  },

  // ── Agent session state ──

  appendAgentMessage: (tabId, message) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, messages: [...session.messages, message] },
        },
      };
    });
  },

  updateAgentStreamingText: (tabId, text) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, streamingText: session.streamingText + text },
        },
      };
    });
  },

  clearAgentStreamingText: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, streamingText: "" },
        },
      };
    });
  },

  setAgentStatus: (tabId, status) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, status },
        },
      };
    });
    // Map agent status to claude status for unified notifications.
    // "active" = agent is working; "idle" = agent stopped and may need attention.
    // Permission/input waiting are NOT mapped to idle — they're visible in the
    // agent UI and shouldn't burn the cooldown that protects the "done" notification.
    const store = get();
    if (status === "thinking" || status === "tool_use" || status === "waiting_permission" || status === "waiting_input") {
      store.setClaudeStatus(tabId, "active");
    } else if (status === "done" || status === "error") {
      store.setClaudeStatus(tabId, "idle");
    }
    // Note: "idle" (initial state before first prompt) is intentionally excluded
    // so opening an agent tab doesn't trigger a spurious notification.
  },

  setAgentModel: (tabId, model) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, model },
        },
      };
    });
  },

  setAgentEffort: (tabId, effort) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, effort },
        },
      };
    });
  },

  setAgentPermissionMode: (tabId, mode) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, permissionMode: mode },
        },
      };
    });
  },

  setAgentCost: (tabId, cost) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, cost },
        },
      };
    });
  },

  setAgentSdkSessionId: (tabId, id) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, sdkSessionId: id },
        },
      };
    });
  },

  setAgentPendingPermission: (tabId, pending) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, pendingPermission: pending },
        },
      };
    });
  },

  setAgentPendingQuestion: (tabId, pending) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, pendingQuestion: pending },
        },
      };
    });
  },

  removeAgentSession: (tabId) => {
    set((s) => {
      const { [tabId]: _, ...rest } = s.agentSessionByTab;
      return { agentSessionByTab: rest };
    });
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

      // Tell the TerminalPanel to clear its buffer before the new run starts.
      window.dispatchEvent(new CustomEvent("terminal-clear", { detail: old.id }));

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
