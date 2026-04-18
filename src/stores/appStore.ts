import { create } from "zustand";
import type { Project, Worktree, AppSettings, AgentSessionState, AgentMessage, AgentStatus, AgentCost, AgentPendingPermission, AgentPendingQuestion, EffortLevel, AgentPermissionMode, SlashCommand } from "../lib/types";
import { DEFAULT_SLASH_COMMANDS } from "../lib/slashCommandDefaults";
import * as commands from "../lib/commands";
import { playNotificationSound } from "../lib/sounds";
import { isWindowFocused } from "../lib/windowFocus";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

export type ClaudeStatus = "active" | "idle";

let _notifIdCounter = 0;

interface TabLocation {
  projectId: string;
  worktreeId: string;
  worktree: Worktree;
  tab: TabInfo;
}

/** Resolve the project, worktree, and tab objects that own the given tabId. */
function findTabLocation(state: Pick<AppState, "tabsByWorktree" | "worktreesByProject">, tabId: string): TabLocation | null {
  for (const [projectId, worktrees] of Object.entries(state.worktreesByProject)) {
    for (const worktree of worktrees) {
      const tab = (state.tabsByWorktree[worktree.id] ?? []).find((candidate) => candidate.id === tabId);
      if (tab) {
        return {
          projectId,
          worktreeId: worktree.id,
          worktree,
          tab,
        };
      }
    }
  }

  return null;
}

/** Fast check: find the worktree that owns the tab (skips the project lookup). */
function findWorktreeForTab(tabsByWorktree: Record<string, TabInfo[]>, tabId: string): string | null {
  for (const [wtId, tabs] of Object.entries(tabsByWorktree)) {
    if (tabs.some((t) => t.id === tabId)) return wtId;
  }
  return null;
}

// ── Agent tab cache persistence ──

const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced save of a single agent tab's state to the DB cache. */
function persistAgentTabDebounced(tabId: string, immediate = false) {
  const existing = _persistTimers.get(tabId);
  if (existing) clearTimeout(existing);

  const doSave = () => {
    _persistTimers.delete(tabId);
    const s = useAppStore.getState();
    const session = s.agentSessionByTab[tabId];
    if (!session) return;

    // Find the owning worktree and tab index
    let worktreeId: string | null = null;
    let tabOrder = 0;
    let tabInfo: TabInfo | undefined;
    for (const [wtId, tabs] of Object.entries(s.tabsByWorktree)) {
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx !== -1) {
        worktreeId = wtId;
        tabOrder = idx;
        tabInfo = tabs[idx];
        break;
      }
    }
    if (!worktreeId || !tabInfo || tabInfo.type !== "agent") return;

    // Don't persist tabs that have never been used (no messages, no SDK session)
    if (session.messages.length === 0 && !session.sdkSessionId) return;

    const cache: commands.AgentTabCache = {
      tab_id: tabInfo.id,
      worktree_id: worktreeId,
      label: tabInfo.label,
      cwd: tabInfo.cwd,
      sdk_session_id: session.sdkSessionId,
      model: session.model,
      effort: session.effort,
      permission_mode: session.permissionMode,
      status: session.status,
      cost_json: session.cost ? JSON.stringify(session.cost) : null,
      messages_json: JSON.stringify(session.messages),
      tab_order: tabOrder,
      extended_context: session.extendedContext,
      concise_mode: session.conciseMode,
      created_at: new Date().toISOString(),
    };
    commands.saveAgentTabCache(cache).catch(() => {});
  };

  if (immediate) {
    _persistTimers.delete(tabId);
    doSave();
  } else {
    _persistTimers.set(tabId, setTimeout(doSave, 500));
  }
}

/** Flush all pending agent tab saves immediately. Returns a promise that resolves when all saves complete. */
export async function flushAllAgentTabCaches(): Promise<void> {
  // Clear all pending debounce timers
  for (const [, timer] of _persistTimers) clearTimeout(timer);
  _persistTimers.clear();

  const s = useAppStore.getState();
  const saves: Promise<void>[] = [];

  for (const [worktreeId, tabs] of Object.entries(s.tabsByWorktree)) {
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      if (tab.type !== "agent") continue;
      const session = s.agentSessionByTab[tab.id];
      if (!session) continue;
      // Don't persist tabs that have never been used
      if (session.messages.length === 0 && !session.sdkSessionId) continue;

      const cache: commands.AgentTabCache = {
        tab_id: tab.id,
        worktree_id: worktreeId,
        label: tab.label,
        cwd: tab.cwd,
        sdk_session_id: session.sdkSessionId,
        model: session.model,
        effort: session.effort,
        permission_mode: session.permissionMode,
        status: session.status,
        cost_json: session.cost ? JSON.stringify(session.cost) : null,
        messages_json: JSON.stringify(session.messages),
        tab_order: i,
        extended_context: session.extendedContext,
        concise_mode: session.conciseMode,
        created_at: new Date().toISOString(),
      };
      saves.push(commands.saveAgentTabCache(cache));
    }
  }

  await Promise.allSettled(saves);
}

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
  collapsedProjectIds: Set<string>;
  pendingClaudeCommand: string | null;
  pendingAgentPrompt: { prompt: string; model?: string } | null;
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
  toggleProjectCollapsed: (projectId: string) => void;
  requestClaudeTab: (command: string) => void;
  consumeClaudeCommand: () => string | null;
  requestAgentTab: (prompt: string, model?: string) => void;
  consumeAgentPrompt: () => { prompt: string; model?: string } | null;
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
  restoreAgentTabs: (worktreeId: string) => Promise<void>;
  addTab: (worktreeId: string, type: "terminal" | "claude", cwd: string, command?: string) => void;
  openDiffTab: (worktreeId: string, file: string, cwd: string, mode: "uncommitted" | "pr", baseBranch?: string) => void;
  closeTab: (worktreeId: string, tabId: string) => void;
  setActiveTab: (worktreeId: string, tabId: string) => void;
  cycleTab: (worktreeId: string, direction: 1 | -1) => void;
  closeActiveTab: (worktreeId: string) => void;
  newTerminalTab: (worktreeId: string) => void;
  newClaudeTab: (worktreeId: string) => void;
  addAgentTab: (worktreeId: string, cwd: string, prompt?: string, model?: string) => void;
  newAgentTab: (worktreeId: string) => void;
  renameTab: (worktreeId: string, tabId: string, newLabel: string) => void;

  // Actions — agent session state
  appendAgentMessage: (tabId: string, message: AgentMessage) => void;
  updateAgentStreamingText: (tabId: string, text: string) => void;
  clearAgentStreamingText: (tabId: string) => void;
  setAgentStatus: (tabId: string, status: AgentStatus) => void;
  setAgentModel: (tabId: string, model: string) => void;
  setAgentEffort: (tabId: string, effort: EffortLevel) => void;
  setAgentExtendedContext: (tabId: string, enabled: boolean) => void;
  setAgentConciseMode: (tabId: string, enabled: boolean) => void;
  setAgentPermissionMode: (tabId: string, mode: AgentPermissionMode) => void;
  setAgentCost: (tabId: string, cost: AgentCost) => void;
  replaceAgentCost: (tabId: string, cost: AgentCost) => void;
  setAgentSdkSessionId: (tabId: string, id: string | null) => void;
  setAgentPendingPermission: (tabId: string, pending: AgentPendingPermission | null) => void;
  setAgentPendingQuestion: (tabId: string, pending: AgentPendingQuestion | null) => void;
  setAgentSlashCommands: (tabId: string, commands: SlashCommand[]) => void;
  removeAgentSession: (tabId: string) => void;
  pushAgentQueuedMessage: (tabId: string, text: string) => void;
  removeQueuedAgentMessages: (tabId: string) => void;
  shiftQueuedMessage: (tabId: string) => void;
  promoteAllQueuedMessages: (tabId: string) => void;

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
  collapsedProjectIds: new Set(JSON.parse(localStorage.getItem("coppice:collapsedProjects") || "[]") as string[]),
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
  requestAgentTab: (prompt, model) => set({ pendingAgentPrompt: { prompt, model } }),
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
    // Clear the idle dot for the active tab when the user navigates to the
    // worktree — they can now see it, so the notification has served its
    // purpose. This applies to both CLI claude tabs and agent tabs.
    if (id) {
      const s = get();
      const activeId = s.activeTabByWorktree[id];
      if (activeId && s.claudeStatusByTab[activeId] === "idle") {
        const { [activeId]: _, ...rest } = s.claudeStatusByTab;
        set({ claudeStatusByTab: rest });
      }
      // Restore cached agent tabs or auto-create a new one when switching
      // to a worktree with no tabs.
      const tabs = s.tabsByWorktree[id];
      if (!tabs || tabs.length === 0) {
        get().restoreAgentTabs(id);
      }
    }
  },

  openProjectSettings: (mode) => set({ editingProject: mode }),
  closeProjectSettings: () => set({ editingProject: null }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  toggleProjectCollapsed: (projectId) => {
    const next = new Set(get().collapsedProjectIds);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    localStorage.setItem("coppice:collapsedProjects", JSON.stringify([...next]));
    set({ collapsedProjectIds: next });
  },

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
    const owningWt = findWorktreeForTab(s.tabsByWorktree, tabId);
    const isVisible = owningWt !== null
      && s.selectedWorktreeId === owningWt
      && s.activeTabByWorktree[owningWt] === tabId;
    const userIsWatching = isVisible && isWindowFocused();

    // Write the status so the in-tab dot reflects what the agent is doing
    // (pulsing while active, warning when done/errored). However, if the
    // user is already watching this specific tab and it transitions to
    // "idle", skip writing it — the user can see the agent finished from
    // the tab content, and writing "idle" would light up the tab dot,
    // sidebar dot, and dock badge with no clearing trigger until the user
    // manually toggles away and back.
    if (status === "idle" && userIsWatching) {
      // Remove any previous status (e.g. "active") so the pulsing dot
      // stops, but don't write "idle" — no orange dot / badge needed.
      if (prev) {
        const { [tabId]: _, ...rest } = s.claudeStatusByTab;
        set({ claudeStatusByTab: rest });
      }
    } else {
      set((state) => ({
        claudeStatusByTab: { ...state.claudeStatusByTab, [tabId]: status },
      }));
    }

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
        // Full lookup needed only here — resolves project ID for the click handler.
        const tabLocation = findTabLocation(s, tabId);
        const tabLabel = tabLocation?.tab.label ?? "";
        const worktreeName = tabLocation ? (tabLocation.worktree.name || tabLocation.worktree.branch) : "";

        (async () => {
          try {
            let granted = await isPermissionGranted();
            if (!granted) {
              const perm = await requestPermission();
              granted = perm === "granted";
            }
            if (granted) {
              sendNotification({
                id: (_notifIdCounter = (_notifIdCounter + 1) % 0x7FFF_FFFF),
                title: "Claude is waiting",
                body: worktreeName
                  ? `${tabLabel} in ${worktreeName}`
                  : tabLabel || "A Claude tab needs attention",
                ...(tabLocation ? {
                  extra: {
                    projectId: tabLocation.projectId,
                    worktreeId: tabLocation.worktreeId,
                    tabId,
                  },
                } : {}),
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

  restoreAgentTabs: async (worktreeId) => {
    try {
      const cachedTabs = await commands.listAgentTabCache(worktreeId);
      if (cachedTabs.length === 0) {
        // No cached tabs — fall back to auto-create if agent mode is default
        const s = get();
        if (s.appSettings?.default_claude_mode === "agent") {
          if (!s.tabsByWorktree[worktreeId]?.length) {
            get().newAgentTab(worktreeId);
          }
        }
        return;
      }

      // Race guard: skip if tabs were already created while we were loading
      if (get().tabsByWorktree[worktreeId]?.length) return;

      const restoredTabs: TabInfo[] = [];
      const restoredSessions: Record<string, AgentSessionState> = {};

      for (const cached of cachedTabs) {
        const tab: TabInfo = {
          id: cached.tab_id,
          type: "agent",
          label: cached.label,
          cwd: cached.cwd,
          // command is intentionally omitted — restored tabs should NOT auto-start
        };
        restoredTabs.push(tab);

        const messages: AgentMessage[] = JSON.parse(cached.messages_json);
        const cost = cached.cost_json ? JSON.parse(cached.cost_json) : null;

        // Coerce transient statuses to "done" — the agent process isn't running after restart
        const status = cached.status === "done" || cached.status === "error"
          ? cached.status as AgentStatus
          : "done";

        restoredSessions[cached.tab_id] = {
          messages,
          status,
          model: cached.model,
          effort: cached.effort as EffortLevel,
          extendedContext: cached.extended_context,
          conciseMode: cached.concise_mode ?? false,
          permissionMode: cached.permission_mode as AgentPermissionMode,
          cost,
          sdkSessionId: cached.sdk_session_id,
          pendingPermission: null,
          pendingQuestion: null,
          streamingText: "",
          slashCommands: DEFAULT_SLASH_COMMANDS,
          queuedMessages: [],
        };
      }

      // Only set if the worktree still has no tabs (race guard)
      if (get().tabsByWorktree[worktreeId]?.length) return;

      set((s) => ({
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [worktreeId]: restoredTabs,
        },
        activeTabByWorktree: {
          ...s.activeTabByWorktree,
          [worktreeId]: restoredTabs[restoredTabs.length - 1]?.id ?? null,
        },
        agentSessionByTab: {
          ...s.agentSessionByTab,
          ...restoredSessions,
        },
      }));
    } catch (err) {
      console.error("Failed to restore agent tabs:", err);
      // Fall back to auto-create
      const s = get();
      if (s.appSettings?.default_claude_mode === "agent") {
        if (!s.tabsByWorktree[worktreeId]?.length) {
          get().newAgentTab(worktreeId);
        }
      }
    }
  },

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
    // Close the agent bridge process and remove cached state if this was an agent tab
    if (closedTab?.type === "agent") {
      commands.agentClose(tabId).catch(() => {});
      commands.deleteAgentTabCache(tabId).catch(() => {});
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

  addAgentTab: (worktreeId, cwd, prompt, model) => {
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
      model: model || s.appSettings?.agent_default_model || "claude-opus-4-7",
      effort: s.appSettings?.agent_default_effort || "high",
      extendedContext: s.appSettings?.agent_default_extended_context ?? false,
      permissionMode: "bypassPermissions",
      conciseMode: true,
      cost: null,
      sdkSessionId: null,
      pendingPermission: null,
      pendingQuestion: null,
      streamingText: "",
      slashCommands: DEFAULT_SLASH_COMMANDS,
      queuedMessages: [],
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
    // Persist label change for agent tabs
    const tab = get().tabsByWorktree[worktreeId]?.find((t) => t.id === tabId);
    if (tab?.type === "agent") persistAgentTabDebounced(tabId);
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
    persistAgentTabDebounced(tabId);
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
      // Flush cache immediately on terminal statuses — the session just finished.
      persistAgentTabDebounced(tabId, true);
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

  setAgentExtendedContext: (tabId, enabled) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, extendedContext: enabled },
        },
      };
    });
  },

  setAgentConciseMode: (tabId, enabled) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, conciseMode: enabled },
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
      const prev = session.cost;
      const accumulated = prev
        ? {
            inputTokens: prev.inputTokens + cost.inputTokens,
            outputTokens: prev.outputTokens + cost.outputTokens,
            cacheReadTokens: prev.cacheReadTokens + cost.cacheReadTokens,
            cacheWriteTokens: prev.cacheWriteTokens + cost.cacheWriteTokens,
            totalCostUsd: prev.totalCostUsd + cost.totalCostUsd,
          }
        : cost;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, cost: accumulated },
        },
      };
    });
    persistAgentTabDebounced(tabId);
  },

  replaceAgentCost: (tabId, cost) => {
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
    persistAgentTabDebounced(tabId);
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
    // Flush immediately — the SDK session ID is critical for resume.
    persistAgentTabDebounced(tabId, true);
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

  setAgentSlashCommands: (tabId, commands) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, slashCommands: commands },
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


  pushAgentQueuedMessage: (tabId, text) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, queuedMessages: [...session.queuedMessages, text] },
        },
      };
    });
  },

  removeQueuedAgentMessages: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: {
            ...session,
            queuedMessages: [],
            messages: session.messages.filter((m) => !m.isQueued),
          },
        },
      };
    });
  },

  shiftQueuedMessage: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session || session.queuedMessages.length === 0) return s;
      // Remove the first queued message from the queue and promote it in messages
      const [, ...rest] = session.queuedMessages;
      // Find the first queued message in the messages list and promote it
      let promoted = false;
      const updatedMessages = session.messages.map((m) => {
        if (!promoted && m.isQueued) {
          promoted = true;
          return { ...m, isQueued: false };
        }
        return m;
      });
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: {
            ...session,
            queuedMessages: rest,
            messages: updatedMessages,
          },
        },
      };
    });
  },

  promoteAllQueuedMessages: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: {
            ...session,
            queuedMessages: [],
            messages: session.messages.map((m) =>
              m.isQueued ? { ...m, isQueued: false } : m
            ),
          },
        },
      };
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
