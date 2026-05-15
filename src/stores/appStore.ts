import { create } from "zustand";
import type { Project, Worktree, AppSettings, AgentSessionState, AgentMessage, AgentStatus, AgentCost, TokenUsage, AgentPendingPermission, AgentPendingQuestion, EffortLevel, AgentPermissionMode, SlashCommand, ImageAttachment, QueuedMessage, AgentBackend, McpServerStatus, DefaultSessionMode } from "../lib/types";
import { SCRATCHPAD_PROJECT_ID, SCRATCHPAD_WORKTREE_ID } from "../lib/types";
import { getDefaultSlashCommands } from "../lib/slashCommandDefaults";
import { resolveDefaultSessionMode } from "../lib/defaultSessionMode";
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

// Hot-path tab→worktree lookups go through the `tabWorktreeIndex` field on
// the store (maintained in every tab-mutating action). The previous
// `findWorktreeForTab` helper that scanned `tabsByWorktree` is gone — that
// scan ran inside `setClaudeStatus` / `setAgentStatus` and was hit on every
// streaming token.

function clearIdleClaudeStatus(
  claudeStatusByTab: Record<string, ClaudeStatus>,
  tabId: string,
): Record<string, ClaudeStatus> | null {
  if (claudeStatusByTab[tabId] !== "idle") return null;
  const { [tabId]: _, ...rest } = claudeStatusByTab;
  return rest;
}

function isDefaultClaudeLabel(label: string) {
  return /^Claude #(\d+)$/.test(label);
}

function titleFromPrompt(prompt: string) {
  const cleaned = prompt
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[/\\][\w-]+\s*/, "");
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
  if (!words) return "";
  return words.length > 30 ? `${words.slice(0, 30)}...` : words;
}

const CLI_TABS_STORAGE_KEY = "coppice:cliTabs:v1";

interface PersistedCliTabs {
  tabsByWorktree: Record<string, TabInfo[]>;
  activeTabByWorktree: Record<string, string | null>;
}

function persistCliTabsSnapshot(state: Pick<AppState, "tabsByWorktree" | "activeTabByWorktree">) {
  const tabsByWorktree: Record<string, TabInfo[]> = {};
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const cliTabs = tabs
      .filter((tab) => tab.type === "terminal" || tab.type === "claude")
      .map((tab) => {
        // resumeOnLaunch is intentionally transient: it means "this tab was
        // restored from a previous app run" and should be recomputed on load.
        const { resumeOnLaunch: _resumeOnLaunch, ...persisted } = tab;
        return persisted;
      });
    if (cliTabs.length > 0) tabsByWorktree[worktreeId] = cliTabs;
  }
  localStorage.setItem(CLI_TABS_STORAGE_KEY, JSON.stringify({ tabsByWorktree, activeTabByWorktree: state.activeTabByWorktree }));
}

function readPersistedCliTabs(): PersistedCliTabs | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLI_TABS_STORAGE_KEY) || "null") as PersistedCliTabs | null;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Agent tab cache persistence ──

const _persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const _streamPersistLast = new Map<string, number>();

function messagesWithStreamingSnapshot(tabId: string, session: AgentSessionState): AgentMessage[] {
  if (!session.streamingText && !session.streamingThinkingText) return session.messages;
  return [
    ...session.messages,
    {
      id: `streaming-snapshot-${tabId}`,
      type: "assistant",
      content: session.streamingText,
      thinkingText: session.streamingThinkingText || undefined,
      timestamp: Date.now(),
    },
  ];
}

/** Persist in-flight streaming text periodically so a renderer hang/restart does
 * not lose the partial assistant response that was already visible.
 *
 * The 2s throttle gates how often we even *schedule* a save; the underlying
 * `persistAgentTabDebounced` then defers the actual full-history
 * `JSON.stringify` + IPC by 500ms (debounced — so a burst of message-appends
 * coalesces with the streaming snapshot into a single save). Using the
 * debounced path keeps the megabyte-sized stringify off the main thread on
 * every fire — previously this ran synchronously every 2s during streaming. */
function persistAgentStreamingSnapshot(tabId: string) {
  const now = Date.now();
  const last = _streamPersistLast.get(tabId) ?? 0;
  if (now - last < 2000) return;
  _streamPersistLast.set(tabId, now);
  persistAgentTabDebounced(tabId);
}

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
      backend: session.backend,
      model: session.model,
      effort: session.effort,
      permission_mode: session.permissionMode,
      status: session.status,
      cost_json: session.cost ? JSON.stringify(session.cost) : null,
      messages_json: JSON.stringify(messagesWithStreamingSnapshot(tabId, session)),
      tab_order: tabOrder,
      extended_context: session.extendedContext,
      concise_mode: session.conciseMode,
      chat_mode: session.chatMode,
      created_at: new Date().toISOString(),
      last_turn_cost_json: session.lastTurnCost ? JSON.stringify(session.lastTurnCost) : null,
      sdk_context_window: session.sdkContextWindow,
      pinned: false,
      pinned_at: null,
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

let _piModelsLoadPromise: Promise<void> | null = null;

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
        backend: session.backend,
        model: session.model,
        effort: session.effort,
        permission_mode: session.permissionMode,
        status: session.status,
        cost_json: session.cost ? JSON.stringify(session.cost) : null,
        messages_json: JSON.stringify(messagesWithStreamingSnapshot(tab.id, session)),
        tab_order: i,
        extended_context: session.extendedContext,
        concise_mode: session.conciseMode,
        chat_mode: session.chatMode,
        created_at: new Date().toISOString(),
        last_turn_cost_json: session.lastTurnCost ? JSON.stringify(session.lastTurnCost) : null,
        sdk_context_window: session.sdkContextWindow,
        pinned: false,
        pinned_at: null,
      };
      saves.push(commands.saveAgentTabCache(cache));
    }
  }

  await Promise.allSettled(saves);
}

// ── Session types ──

export interface TabInfo {
  id: string;
  type: "terminal" | "claude" | "agent" | "diff" | "file";
  label: string;
  command?: string;
  cwd: string;
  /** Claude Code CLI session id captured from hooks, used to resume restored CLI tabs. */
  claudeSessionId?: string;
  /** True after the first Claude CLI user prompt has been used/considered for auto-title. */
  claudeFirstPromptTitleSet?: boolean;
  /** Transient: true only for CLI tabs restored after app launch. */
  resumeOnLaunch?: boolean;
  // For diff tabs
  diffFile?: string;
  diffMode?: "uncommitted" | "pr";
  diffBaseBranch?: string;
  // For file viewer tabs
  filePath?: string;
}

export type RunnerStatus = "running" | "stopped" | "idle";

export interface RunnerInfo {
  id: string;
  open: boolean;
  status: RunnerStatus;
  command: string;
  cwd: string;
}

export interface SubagentTranscriptEntry {
  tool: string;
  summary: string;
  status: "ok" | "error" | "running";
}

export interface SubagentChild {
  id: string;
  role: string;
  task: string;
  lastTool: string;
  lastToolSummary: string;
  toolCount: number;
  elapsed: number;
  filesExplored: string[];
  filesModified: string[];
  transcript: SubagentTranscriptEntry[];
  status: "running" | "done" | "error";
  error?: string;
}

interface AppState {
  // Data
  projects: Project[];
  worktreesByProject: Record<string, Worktree[]>;
  appSettings: AppSettings | null;
  claudeAuthInfo: { loggedIn: boolean; email?: string; orgName?: string } | null;
  /** Dynamic model list populated by the Pi bridge's init event. */
  piAvailableModels: import("../lib/supportedModels").SupportedModel[];
  scratchpadProject: Project | null;
  scratchpadWorktree: Worktree | null;

  // UI state
  selectedProjectId: string | null;
  selectedWorktreeId: string | null;
  editingProject: "new" | string | null;
  sidebarWidth: number;
  collapsedProjectIds: Set<string>;
  pendingClaudeCommand: string | null;
  pendingAgentPrompt: { prompt: string; model?: string; backend?: AgentBackend } | null;
  pendingRunner: { key: string } | null;
  deletingWorktreeIds: Set<string>;

  // Per-worktree sessions (keyed by worktree ID)
  tabsByWorktree: Record<string, TabInfo[]>;
  activeTabByWorktree: Record<string, string | null>;
  runnersByWorktree: Record<string, Record<string, RunnerInfo>>;

  // O(1) lookup: tab ID → owning worktree ID. Kept in sync with `tabsByWorktree`
  // by every action that adds or removes a tab. Used by hot-path callers
  // (setClaudeStatus, setAgentStatus) so per-token status updates don't pay
  // the O(W·T) scan over `tabsByWorktree`.
  tabWorktreeIndex: Record<string, string>;

  // Claude tab activity status (keyed by tab ID — covers both claude and agent tabs)
  claudeStatusByTab: Record<string, ClaudeStatus>;

  // Terminal progress by tab (0-100, keyed by terminal/Claude tab ID)
  terminalProgressByTab: Record<string, number>;

  // Agent session state (keyed by tab ID)
  agentSessionByTab: Record<string, AgentSessionState>;

  // Cached tab counts from DB (for worktrees not yet loaded into memory)
  cachedTabCountByWorktree: Record<string, number>;

  // Tile view
  showTileView: boolean;

  // Pending dropped images for agent tabs (keyed by tab ID)
  pendingDroppedImages: Record<string, ImageAttachment[]>;

  // PR comments (keyed by project ID)
  prCommentsByProject: Record<string, import("../lib/commands").PrComment[]>;

  // Actions — settings
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  refreshClaudeAuth: () => void;
  ensurePiModelsLoaded: () => Promise<void>;
  setDefaultAgentBackend: (backend: AgentBackend) => Promise<void>;
  setDefaultSessionMode: (mode: DefaultSessionMode) => Promise<void>;

  // Actions — general
  loadProjects: () => Promise<void>;
  loadWorktrees: (projectId: string) => Promise<void>;
  selectProject: (id: string | null) => void;
  selectWorktree: (id: string | null) => void;
  selectScratchpad: () => void;
  openProjectSettings: (mode: "new" | string) => void;
  closeProjectSettings: () => void;
  setSidebarWidth: (width: number) => void;
  toggleProjectCollapsed: (projectId: string) => void;
  requestClaudeTab: (command: string) => void;
  consumeClaudeCommand: () => string | null;
  requestAgentTab: (prompt: string, model?: string, backend?: AgentBackend) => void;
  consumeAgentPrompt: () => { prompt: string; model?: string; backend?: AgentBackend } | null;
  requestRunner: (key: string) => void;
  consumeRunner: () => { key: string } | null;

  // Actions — CRUD
  createProject: (data: Parameters<typeof commands.createProject>[0]) => Promise<void>;
  updateProject: (id: string, data: Parameters<typeof commands.updateProject>[1]) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;
  createWorktree: (projectId: string, branch: string, name: string) => Promise<void>;
  renameWorktree: (id: string, projectId: string, name: string) => Promise<void>;
  setWorktreeTargetBranch: (id: string, projectId: string, targetBranch: string | null) => Promise<void>;
  deleteWorktree: (id: string, projectId: string, keepBranch?: boolean) => Promise<void>;
  updateWorktreeBranch: (worktreeId: string, branch: string) => void;

  // Actions — app settings modal
  editingAppSettings: boolean;
  openAppSettings: () => void;
  closeAppSettings: () => void;

  // Actions — PR comments
  setPrComments: (projectId: string, comments: import("../lib/commands").PrComment[]) => void;

  // Actions — Claude status
  setClaudeStatus: (tabId: string, status: ClaudeStatus) => void;
  clearClaudeIdleStatus: (tabId: string) => void;
  removeClaudeStatus: (tabId: string) => void;
  setTerminalProgress: (tabId: string, progress: number | null) => void;

  // Actions — tile view
  toggleTileView: () => void;

  // Actions — tabs
  restoreAgentTabs: (worktreeId: string) => Promise<void>;
  restoreCliTabs: () => void;
  addTab: (worktreeId: string, type: "terminal" | "claude", cwd: string, command?: string) => void;
  openDiffTab: (worktreeId: string, file: string, cwd: string, mode: "uncommitted" | "pr", baseBranch?: string) => void;
  openFileTab: (worktreeId: string, file: string, cwd: string) => void;
  closeTab: (worktreeId: string, tabId: string) => void;
  setActiveTab: (worktreeId: string, tabId: string) => void;
  cycleTab: (worktreeId: string, direction: 1 | -1) => void;
  closeActiveTab: (worktreeId: string) => void;
  newTerminalTab: (worktreeId: string) => void;
  newClaudeTab: (worktreeId: string) => void;
  setClaudeCliSessionId: (tabId: string, claudeSessionId: string) => void;
  autoRenameClaudeTabFromPrompt: (tabId: string, prompt: string) => string | null;
  applyClaudeTabGeneratedTitle: (tabId: string, title: string, expectedCurrentLabel: string) => void;
  addAgentTab: (worktreeId: string, cwd: string, prompt?: string, model?: string, backend?: AgentBackend) => void;
  newAgentTab: (worktreeId: string, backend?: AgentBackend) => void;
  newDefaultSessionTab: (worktreeId: string, cwd?: string) => void;
  renameTab: (worktreeId: string, tabId: string, newLabel: string) => void;

  // Actions — agent session state
  appendAgentMessage: (tabId: string, message: AgentMessage) => void;
  updateAgentStreamingText: (tabId: string, text: string) => void;
  clearAgentStreamingText: (tabId: string) => void;
  updateAgentStreamingThinking: (tabId: string, text: string) => void;
  clearAgentStreamingThinking: (tabId: string) => void;
  setAgentStatus: (tabId: string, status: AgentStatus) => void;
  setAgentBackend: (tabId: string, backend: AgentBackend, model?: string) => void;
  setAgentModel: (tabId: string, model: string) => void;
  setAgentEffort: (tabId: string, effort: EffortLevel) => void;
  setAgentExtendedContext: (tabId: string, enabled: boolean) => void;
  setAgentConciseMode: (tabId: string, enabled: boolean) => void;
  setAgentChatMode: (tabId: string, enabled: boolean) => void;
  setAgentPermissionMode: (tabId: string, mode: AgentPermissionMode) => void;
  replaceAgentCost: (tabId: string, cost: AgentCost) => void;
  setAgentLastTurnCost: (tabId: string, cost: TokenUsage | null) => void;
  accumulateQueryOutput: (tabId: string, outputTokens: number) => void;
  resetQueryOutput: (tabId: string) => void;
  setAgentSdkContextWindow: (tabId: string, contextWindow: number) => void;
  setAgentSdkSessionId: (tabId: string, id: string | null) => void;
  setAgentMcpServers: (tabId: string, servers: McpServerStatus[]) => void;
  setAgentPendingPermission: (tabId: string, pending: AgentPendingPermission | null) => void;
  setAgentPendingQuestion: (tabId: string, pending: AgentPendingQuestion | null) => void;
  setAgentSlashCommands: (tabId: string, commands: SlashCommand[]) => void;
  removeAgentSession: (tabId: string) => void;
  pushAgentQueuedMessage: (tabId: string, text: string, images?: ImageAttachment[]) => void;
  removeQueuedAgentMessages: (tabId: string) => void;
  cancelQueuedAgentMessage: (tabId: string, messageId: string) => void;
  shiftQueuedMessage: (tabId: string) => void;
  promoteAllQueuedMessages: (tabId: string) => void;

  // Actions — subagent progress (global — only one subagent tool runs at a time)
  subagentChildren: SubagentChild[];
  updateSubagentChild: (child: SubagentChild) => void;
  clearSubagentChildren: () => void;

  // Actions — dropped images for agent input
  pushDroppedImages: (tabId: string, images: ImageAttachment[]) => void;
  consumeDroppedImages: (tabId: string) => ImageAttachment[];

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
  claudeAuthInfo: null,
  piAvailableModels: [],
  scratchpadProject: null,
  scratchpadWorktree: null,
  selectedProjectId: null,
  selectedWorktreeId: null,
  editingProject: null,
  sidebarWidth: 450,
  collapsedProjectIds: new Set(JSON.parse(localStorage.getItem("coppice:collapsedProjects") || "[]") as string[]),
  pendingClaudeCommand: null,
  pendingAgentPrompt: null,
  pendingRunner: null,
  deletingWorktreeIds: new Set(),
  tabsByWorktree: {},
  activeTabByWorktree: {},
  tabWorktreeIndex: {},
  runnersByWorktree: {},
  claudeStatusByTab: {},
  terminalProgressByTab: {},
  agentSessionByTab: {},
  cachedTabCountByWorktree: {},
  showTileView: false,
  pendingDroppedImages: {},
  prCommentsByProject: {},
  subagentChildren: [],
  editingAppSettings: false,

  // ── Settings ──

  loadSettings: async () => {
    const settings = await commands.getSettings();
    set({ appSettings: settings });
    if (settings.agent_backend === "pi") {
      get().ensurePiModelsLoaded().catch(() => {});
    }
    get().refreshClaudeAuth();
  },

  saveSettings: async (settings) => {
    await commands.updateSettings(settings);
    set({ appSettings: settings });
    if (settings.agent_backend === "pi") {
      await get().ensurePiModelsLoaded();
    }
  },

  refreshClaudeAuth: () => {
    commands.claudeAuthStatus()
      .then((info) => {
        if (info.loggedIn) {
          set({ claudeAuthInfo: { loggedIn: true, email: info.email, orgName: info.orgName } });
        } else {
          set({ claudeAuthInfo: { loggedIn: false } });
        }
      })
      .catch(() => {
        set({ claudeAuthInfo: { loggedIn: false } });
      });
  },

  ensurePiModelsLoaded: async () => {
    if (get().piAvailableModels.length > 0) return;
    if (_piModelsLoadPromise) return _piModelsLoadPromise;
    _piModelsLoadPromise = commands.piGetModels()
      .then((models) => {
        if (models && models.length > 0) set({ piAvailableModels: models });
      })
      .catch((err) => console.warn("Failed to load Pi models:", err))
      .finally(() => {
        _piModelsLoadPromise = null;
      });
    return _piModelsLoadPromise;
  },

  setDefaultAgentBackend: async (backend) => {
    const settings = get().appSettings;
    if (!settings || settings.agent_backend === backend) return;
    await get().saveSettings({ ...settings, agent_backend: backend });
  },

  setDefaultSessionMode: async (mode) => {
    const settings = get().appSettings;
    if (!settings) return;
    const nextSettings: AppSettings = {
      ...settings,
      default_claude_mode: mode,
      ...(mode === "terminal" ? {} : { agent_backend: mode }),
    };
    if (
      settings.default_claude_mode === nextSettings.default_claude_mode
      && settings.agent_backend === nextSettings.agent_backend
    ) return;
    await get().saveSettings(nextSettings);
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
  requestAgentTab: (prompt, model, backend) => set({ pendingAgentPrompt: { prompt, model, backend } }),
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
    const allProjects = await commands.listProjects();
    const scratchpadProject = allProjects.find((p) => p.id === SCRATCHPAD_PROJECT_ID) ?? null;
    const projects = allProjects.filter((p) => p.id !== SCRATCHPAD_PROJECT_ID);
    set({ projects, scratchpadProject });
    for (const project of projects) {
      get().loadWorktrees(project.id);
    }
    if (scratchpadProject) {
      const worktrees = await commands.listWorktrees(scratchpadProject.id);
      const scratchpadWorktree = worktrees.find((w) => w.id === SCRATCHPAD_WORKTREE_ID) ?? null;
      set((s) => ({
        scratchpadWorktree,
        worktreesByProject: { ...s.worktreesByProject, [SCRATCHPAD_PROJECT_ID]: worktrees },
      }));
      get().restoreCliTabs();
    }
    // Eagerly load cached tab counts so the sidebar shows them before
    // the user clicks into each worktree.
    commands.countAgentTabCaches()
      .then((counts) => {
        set({ cachedTabCountByWorktree: counts });
        // Eagerly restore cached agent tabs so tile view can show all
        // agent sessions without requiring each worktree to be opened first.
        for (const id of Object.keys(counts)) get().restoreAgentTabs(id);
      })
      .catch(() => {});
  },

  loadWorktrees: async (projectId) => {
    const worktrees = await commands.listWorktrees(projectId);
    set((s) => ({
      worktreesByProject: { ...s.worktreesByProject, [projectId]: worktrees },
    }));
    get().restoreCliTabs();
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
      const nextClaudeStatus = activeId
        ? clearIdleClaudeStatus(s.claudeStatusByTab, activeId)
        : null;
      if (nextClaudeStatus) {
        set({ claudeStatusByTab: nextClaudeStatus });
      }
      // Restore cached agent tabs (but don't auto-create new ones).
      const tabs = s.tabsByWorktree[id];
      if (!tabs || tabs.length === 0) {
        get().restoreAgentTabs(id);
      }
    }
  },
  selectScratchpad: () => {
    const s = get();
    if (s.scratchpadWorktree) {
      set({
        selectedProjectId: SCRATCHPAD_PROJECT_ID,
        selectedWorktreeId: SCRATCHPAD_WORKTREE_ID,
      });
      const tabs = s.tabsByWorktree[SCRATCHPAD_WORKTREE_ID];
      if (!tabs || tabs.length === 0) {
        get().restoreAgentTabs(SCRATCHPAD_WORKTREE_ID);
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

  deleteWorktree: async (id, projectId, keepBranch) => {
    // Mark as deleting immediately for UI feedback
    set((s) => ({
      deletingWorktreeIds: new Set([...s.deletingWorktreeIds, id]),
    }));
    if (get().selectedWorktreeId === id) {
      set({ selectedWorktreeId: null });
    }
    // Async cleanup
    await commands.deleteWorktree(id, keepBranch ?? false);
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

  // ── Tile view ──

  toggleTileView: () => set((s) => ({ showTileView: !s.showTileView })),

  // ── Claude status ──

  setClaudeStatus: (tabId, status) => {
    const s = get();
    const prev = s.claudeStatusByTab[tabId];
    if (prev === status) return;

    // Determine whether the user is already watching this specific tab.
    // "Visible" means the tab is the active tab of the selected worktree;
    // "focused" means the whole window is in the foreground. Both must be
    // true for us to consider the user present.
    const owningWt = s.tabWorktreeIndex[tabId] ?? null;
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

    // Notify when the agent finishes responding and the user can't see the tab.
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
        const isCliTab = tabLocation?.tab.type === "claude";

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
                title: isCliTab ? "Claude needs attention" : "Agent finished",
                body: worktreeName
                  ? `${tabLabel} in ${worktreeName}`
                  : tabLabel || (isCliTab ? "A Claude CLI tab needs attention" : "An agent tab has finished responding"),
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

  setTerminalProgress: (tabId, progress) => {
    const s = get();
    if (progress === null || progress <= 0 || progress >= 100) {
      if (!(tabId in s.terminalProgressByTab)) return;
      const { [tabId]: _, ...rest } = s.terminalProgressByTab;
      set({ terminalProgressByTab: rest });
      return;
    }
    const bounded = Math.max(0, Math.min(100, Math.round(progress)));
    if (s.terminalProgressByTab[tabId] === bounded) return;
    set({ terminalProgressByTab: { ...s.terminalProgressByTab, [tabId]: bounded } });
  },

  clearClaudeIdleStatus: (tabId) => {
    const s = get();
    const nextClaudeStatus = clearIdleClaudeStatus(s.claudeStatusByTab, tabId);
    if (!nextClaudeStatus) return;
    set({ claudeStatusByTab: nextClaudeStatus });
  },

  // ── Tabs ──

  restoreCliTabs: () => {
    const persisted = readPersistedCliTabs();
    if (!persisted) return;
    const s = get();
    const knownWorktreeIds = new Set(
      Object.values(s.worktreesByProject).flat().map((worktree) => worktree.id)
    );
    if (s.scratchpadWorktree) knownWorktreeIds.add(s.scratchpadWorktree.id);

    set((state) => {
      const nextTabsByWorktree = { ...state.tabsByWorktree };
      const nextActive = { ...state.activeTabByWorktree };
      const nextIndex = { ...state.tabWorktreeIndex };
      let changed = false;

      for (const [worktreeId, tabs] of Object.entries(persisted.tabsByWorktree)) {
        if (!knownWorktreeIds.has(worktreeId)) continue;
        const existing = nextTabsByWorktree[worktreeId] ?? [];
        const existingIds = new Set(existing.map((tab) => tab.id));
        const restored = tabs
          .filter((tab) =>
            (tab.type === "terminal" || tab.type === "claude") &&
            tab.cwd &&
            !existingIds.has(tab.id)
          )
          .map((tab) => tab.type === "claude"
            ? {
              ...tab,
              // Existing Claude sessions should not be retitled from a later
              // prompt after app restart. Preserve an explicit flag when
              // present, otherwise treat resumable/non-default tabs as done.
              claudeFirstPromptTitleSet: tab.claudeFirstPromptTitleSet ?? (!!tab.claudeSessionId || !isDefaultClaudeLabel(tab.label)),
              resumeOnLaunch: true,
            }
            : tab);
        if (restored.length === 0) continue;
        nextTabsByWorktree[worktreeId] = [...existing, ...restored];
        for (const tab of restored) nextIndex[tab.id] = worktreeId;
        const active = persisted.activeTabByWorktree[worktreeId];
        if (active && restored.some((tab) => tab.id === active)) nextActive[worktreeId] = active;
        else if (!nextActive[worktreeId]) nextActive[worktreeId] = restored[0]?.id ?? null;
        changed = true;
      }

      if (!changed) return {};
      return { tabsByWorktree: nextTabsByWorktree, activeTabByWorktree: nextActive, tabWorktreeIndex: nextIndex };
    });
  },

  restoreAgentTabs: async (worktreeId) => {
    try {
      const cachedTabs = await commands.listAgentTabCache(worktreeId);
      if (cachedTabs.length === 0) {
        return;
      }

      // Race guard: skip if tabs were already created while we were loading
      if (get().tabsByWorktree[worktreeId]?.length) {
        return;
      }

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

        const backend = (cached.backend || get().appSettings?.agent_backend || "claude") as AgentBackend;
        restoredSessions[cached.tab_id] = {
          messages,
          status,
          backend,
          model: cached.model || (
            backend === "pi"
              ? get().appSettings?.pi_default_model || ""
              : get().appSettings?.agent_default_model || ""
          ),
          effort: cached.effort as EffortLevel,
          extendedContext: cached.extended_context,
          conciseMode: cached.concise_mode ?? false,
          chatMode: cached.chat_mode ?? false,
          permissionMode: cached.permission_mode as AgentPermissionMode,
          cost,
          lastTurnCost: cached.last_turn_cost_json ? JSON.parse(cached.last_turn_cost_json) : null,
          queryOutputTokens: 0,
          sdkContextWindow: cached.sdk_context_window ?? null,
          sdkSessionId: cached.sdk_session_id,
          mcpServers: [],
          pendingPermission: null,
          pendingQuestion: null,
          streamingText: "",
          streamingThinkingText: "",
          slashCommands: getDefaultSlashCommands(backend),
          queuedMessages: [],
        };
      }

      // Only set if the worktree still has no tabs (race guard)
      if (get().tabsByWorktree[worktreeId]?.length) {
        return;
      }

      set((s) => {
        const nextIndex = { ...s.tabWorktreeIndex };
        for (const tab of restoredTabs) nextIndex[tab.id] = worktreeId;
        return {
          tabsByWorktree: {
            ...s.tabsByWorktree,
            [worktreeId]: restoredTabs,
          },
          activeTabByWorktree: {
            ...s.activeTabByWorktree,
            [worktreeId]: restoredTabs[restoredTabs.length - 1]?.id ?? null,
          },
          tabWorktreeIndex: nextIndex,
          agentSessionByTab: {
            ...s.agentSessionByTab,
            ...restoredSessions,
          },
        };
      });
    } catch (err) {
      console.error("Failed to restore agent tabs:", err);
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
      tabWorktreeIndex: { ...s.tabWorktreeIndex, [tab.id]: worktreeId },
    }));
    persistCliTabsSnapshot(get());
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
      tabWorktreeIndex: { ...s.tabWorktreeIndex, [tab.id]: worktreeId },
    }));
  },

  openFileTab: (worktreeId, file, cwd) => {
    const tabs = get().tabsByWorktree[worktreeId] ?? [];
    const existing = tabs.find((t) => t.type === "file" && t.filePath === file);
    if (existing) {
      set((s) => ({
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: existing.id },
      }));
      return;
    }
    const shortName = file.split(/[/\\]/).pop() ?? file;
    const tab: TabInfo = {
      id: `file-${worktreeId}-${Date.now()}`,
      type: "file",
      label: shortName,
      cwd,
      filePath: file,
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
      tabWorktreeIndex: { ...s.tabWorktreeIndex, [tab.id]: worktreeId },
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
    const tabIndex = tabId in s.tabWorktreeIndex
      ? (() => { const { [tabId]: _, ...rest } = s.tabWorktreeIndex; return rest; })()
      : s.tabWorktreeIndex;
    const terminalProgress = tabId in s.terminalProgressByTab
      ? (() => { const { [tabId]: _, ...rest } = s.terminalProgressByTab; return rest; })()
      : s.terminalProgressByTab;
    set({
      tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: next },
      activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: newActive },
      tabWorktreeIndex: tabIndex,
      claudeStatusByTab: claudeStatus,
      terminalProgressByTab: terminalProgress,
      agentSessionByTab: agentSession,
    });
    persistCliTabsSnapshot(get());
    // Tear down backend resources for closed tabs. Terminal panels are kept
    // alive while switching tabs, so their React unmount cleanup intentionally
    // does not kill the PTY; tab closure must do it explicitly here.
    if (closedTab?.type === "agent") {
      commands.agentClose(tabId).catch(() => {});
      commands.deleteAgentTabCache(tabId).catch(() => {});
    } else if (closedTab?.type === "terminal" || closedTab?.type === "claude") {
      commands.terminalKill(tabId).catch(() => {});
    }
  },

  setActiveTab: (worktreeId, tabId) => {
    set((s) => {
      const nextClaudeStatus = clearIdleClaudeStatus(s.claudeStatusByTab, tabId);
      const update: Partial<AppState> = {
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: tabId },
      };
      // Clear "idle" indicator when the user switches to that tab
      if (nextClaudeStatus) {
        update.claudeStatusByTab = nextClaudeStatus;
      }
      return update;
    });
    persistCliTabsSnapshot(get());
  },

  cycleTab: (worktreeId, direction) => {
    const s = get();
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    if (tabs.length < 2) return;
    const activeId = s.activeTabByWorktree[worktreeId];
    const idx = tabs.findIndex((t) => t.id === activeId);
    const next = ((idx === -1 ? 0 : idx) + direction + tabs.length) % tabs.length;
    const nextId = tabs[next].id;
    const nextClaudeStatus = clearIdleClaudeStatus(s.claudeStatusByTab, nextId);
    // Clear "idle" indicator when cycling to an idle claude tab
    if (nextClaudeStatus) {
      set({
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: nextId },
        claudeStatusByTab: nextClaudeStatus,
      });
    } else {
      set({
        activeTabByWorktree: { ...s.activeTabByWorktree, [worktreeId]: nextId },
      });
    }
    persistCliTabsSnapshot(get());
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

  setClaudeCliSessionId: (tabId, claudeSessionId) => {
    const s = get();
    const worktreeId = s.tabWorktreeIndex[tabId];
    if (!worktreeId || !claudeSessionId) return;
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== "claude" || tab.claudeSessionId === claudeSessionId) return;
    set((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktreeId]: (state.tabsByWorktree[worktreeId] ?? []).map((t) =>
          t.id === tabId ? { ...t, claudeSessionId } : t
        ),
      },
    }));
    persistCliTabsSnapshot(get());
  },

  autoRenameClaudeTabFromPrompt: (tabId, prompt) => {
    const s = get();
    const worktreeId = s.tabWorktreeIndex[tabId];
    if (!worktreeId || !prompt.trim()) return null;
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== "claude" || tab.claudeFirstPromptTitleSet) return null;

    const nextLabel = isDefaultClaudeLabel(tab.label) ? titleFromPrompt(prompt) : "";
    set((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktreeId]: (state.tabsByWorktree[worktreeId] ?? []).map((t) => {
          if (t.id !== tabId) return t;
          return {
            ...t,
            ...(nextLabel ? { label: nextLabel } : {}),
            claudeFirstPromptTitleSet: true,
          };
        }),
      },
    }));
    persistCliTabsSnapshot(get());
    return nextLabel || null;
  },

  applyClaudeTabGeneratedTitle: (tabId, title, expectedCurrentLabel) => {
    const nextLabel = title.trim();
    if (!nextLabel || !expectedCurrentLabel) return;
    const s = get();
    const worktreeId = s.tabWorktreeIndex[tabId];
    if (!worktreeId) return;
    const tabs = s.tabsByWorktree[worktreeId] ?? [];
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab || tab.type !== "claude") return;
    // Do not overwrite a user/manual rename that happened while the SDK title
    // request was in flight.
    if (tab.label !== expectedCurrentLabel) return;

    set((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktreeId]: (state.tabsByWorktree[worktreeId] ?? []).map((t) =>
          t.id === tabId ? { ...t, label: nextLabel } : t
        ),
      },
    }));
    persistCliTabsSnapshot(get());
  },

  addAgentTab: (worktreeId, cwd, prompt, model, requestedBackend) => {
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
    const backend = requestedBackend || s.appSettings?.agent_backend || "claude";
    let effort = s.appSettings?.agent_default_effort || "high";
    if (backend === "pi" && effort === "max") effort = "xhigh";
    if (backend === "claude" && (effort === "off" || effort === "minimal")) effort = "low";
    const sessionState: AgentSessionState = {
      messages: [],
      status: "idle",
      backend,
      model: model || (
        backend === "pi"
          ? s.appSettings?.pi_default_model || ""
          : s.appSettings?.agent_default_model || ""
      ),
      effort,
      extendedContext: s.appSettings?.agent_default_extended_context ?? false,
      permissionMode: "bypassPermissions",
      conciseMode: true,
      chatMode: false,
      cost: null,
      lastTurnCost: null,
      queryOutputTokens: 0,
      sdkContextWindow: null,
      sdkSessionId: null,
      mcpServers: [],
      pendingPermission: null,
      pendingQuestion: null,
      streamingText: "",
      streamingThinkingText: "",
      slashCommands: getDefaultSlashCommands(backend),
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
      tabWorktreeIndex: { ...state.tabWorktreeIndex, [tab.id]: worktreeId },
      agentSessionByTab: {
        ...state.agentSessionByTab,
        [tab.id]: sessionState,
      },
    }));
  },

  newAgentTab: (worktreeId, backend) => {
    const path = get().getWorktreePath(worktreeId);
    if (!path) return;
    get().addAgentTab(worktreeId, path, undefined, undefined, backend);
  },

  newDefaultSessionTab: (worktreeId, cwd) => {
    const s = get();
    const path = cwd || s.getWorktreePath(worktreeId);
    if (!path) return;

    const defaultMode = resolveDefaultSessionMode(s.appSettings);
    if (defaultMode !== "terminal") {
      s.addAgentTab(worktreeId, path, undefined, undefined, defaultMode);
      return;
    }

    // Resolve the project-specific Claude command when this is a real project
    // worktree; scratchpad/default paths fall back to the global command.
    let projectId: string | null = null;
    for (const [pid, wts] of Object.entries(s.worktreesByProject)) {
      if (wts.some((w) => w.id === worktreeId)) { projectId = pid; break; }
    }
    const project = projectId ? s.projects.find((p) => p.id === projectId) : undefined;
    const claudeCmd = project?.claude_command || s.appSettings?.claude_command || "claude";
    s.addTab(worktreeId, "claude", path, claudeCmd);
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
    // Persist label change for agent tabs and restored CLI/terminal tabs.
    const tab = get().tabsByWorktree[worktreeId]?.find((t) => t.id === tabId);
    if (tab?.type === "agent") persistAgentTabDebounced(tabId);
    persistCliTabsSnapshot(get());
  },

  // ── Agent session state ──

  appendAgentMessage: (tabId, message) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: {
            ...session,
            messages: [...session.messages, message],
            mcpServers: message.mcpServers?.length ? message.mcpServers : session.mcpServers,
          },
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
    persistAgentStreamingSnapshot(tabId);
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

  updateAgentStreamingThinking: (tabId, text) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, streamingThinkingText: session.streamingThinkingText + text },
        },
      };
    });
    persistAgentStreamingSnapshot(tabId);
  },

  clearAgentStreamingThinking: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, streamingThinkingText: "" },
        },
      };
    });
  },

  setAgentStatus: (tabId, status) => {
    const current = get().agentSessionByTab[tabId];
    if (!current || current.status === status) return;

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
    // Permission/input waiting are NOT mapped to idle — they shouldn't burn the
    // cooldown that protects the "done" notification.
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

    // Fire a separate notification when an agent needs permission approval,
    // so the user notices even if the window is in the background.
    if (status === "waiting_permission") {
      const s = store;
      const owningWt = s.tabWorktreeIndex[tabId] ?? null;
      const isVisible = owningWt !== null
        && s.selectedWorktreeId === owningWt
        && s.activeTabByWorktree[owningWt] === tabId;
      const userIsWatching = isVisible && isWindowFocused();

      if (!userIsWatching) {
        if (s.appSettings?.notification_sound) {
          playNotificationSound();
        }
        if (s.appSettings?.notification_popup) {
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
                  title: "Approval needed",
                  body: worktreeName
                    ? `${tabLabel} in ${worktreeName}`
                    : tabLabel || "An agent tab needs permission",
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
    }
  },

  setAgentBackend: (tabId, backend, model) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      let effort = session.effort;
      if (backend === "pi" && effort === "max") effort = "xhigh";
      if (backend === "claude" && (effort === "off" || effort === "minimal")) effort = "low";
      // Reset slash commands to the new backend's defaults when session hasn't started yet
      const slashCommands = session.status === "idle"
        ? getDefaultSlashCommands(backend)
        : session.slashCommands;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, backend, model: model ?? session.model, effort, slashCommands },
        },
      };
    });
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

  setAgentChatMode: (tabId, enabled) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, chatMode: enabled },
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

  setAgentLastTurnCost: (tabId, cost) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, lastTurnCost: cost },
        },
      };
    });
  },

  accumulateQueryOutput: (tabId, outputTokens) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, queryOutputTokens: session.queryOutputTokens + outputTokens },
        },
      };
    });
  },

  resetQueryOutput: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, queryOutputTokens: 0 },
        },
      };
    });
  },

  setAgentSdkContextWindow: (tabId, contextWindow) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, sdkContextWindow: contextWindow },
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
    // Flush immediately — the SDK session ID is critical for resume.
    persistAgentTabDebounced(tabId, true);
  },

  setAgentMcpServers: (tabId, servers) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, mcpServers: servers },
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
      const { [tabId]: _, ...restSessions } = s.agentSessionByTab;
      return { agentSessionByTab: restSessions };
    });
  },


  pushAgentQueuedMessage: (tabId, text, images) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      const entry: QueuedMessage = { text, ...(images?.length ? { images } : {}) };
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: { ...session, queuedMessages: [...session.queuedMessages, entry] },
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

  cancelQueuedAgentMessage: (tabId, messageId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session) return s;
      // Find the message to cancel
      const msgIndex = session.messages.findIndex((m) => m.id === messageId && m.isQueued);
      if (msgIndex === -1) return s;
      // Count how many queued messages appear before this one to determine queue index
      let queueIndex = 0;
      for (let i = 0; i < msgIndex; i++) {
        if (session.messages[i].isQueued) queueIndex++;
      }
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: {
            ...session,
            queuedMessages: session.queuedMessages.filter((_, i) => i !== queueIndex),
            messages: session.messages.filter((m) => m.id !== messageId),
          },
        },
      };
    });
  },

  shiftQueuedMessage: (tabId) => {
    set((s) => {
      const session = s.agentSessionByTab[tabId];
      if (!session || session.queuedMessages.length === 0) return s;
      const [, ...rest] = session.queuedMessages;
      let promotedMsg: AgentMessage | null = null;
      const remaining = session.messages.filter((m) => {
        if (!promotedMsg && m.isQueued) {
          promotedMsg = m;
          return false;
        }
        return true;
      });
      let updatedMessages = remaining;
      if (promotedMsg) {
        updatedMessages = [...remaining, { ...(promotedMsg as AgentMessage), isQueued: false, timestamp: Date.now() }];
      }
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
      const nonQueued: typeof session.messages = [];
      const queued: typeof session.messages = [];
      for (const m of session.messages) {
        (m.isQueued ? queued : nonQueued).push(m);
      }
      const now = Date.now();
      return {
        agentSessionByTab: {
          ...s.agentSessionByTab,
          [tabId]: {
            ...session,
            queuedMessages: [],
            messages: [
              ...nonQueued,
              ...queued.map((m) => ({ ...m, isQueued: false, timestamp: now })),
            ],
          },
        },
      };
    });
  },
  // ── Subagent progress ──

  updateSubagentChild: (child) => {
    set((s) => {
      const idx = s.subagentChildren.findIndex((c) => c.id === child.id);
      if (idx >= 0) {
        const next = [...s.subagentChildren];
        next[idx] = child;
        return { subagentChildren: next };
      }
      return { subagentChildren: [...s.subagentChildren, child] };
    });
  },

  clearSubagentChildren: () => {
    set({ subagentChildren: [] });
  },

  // ── Dropped images for agent input ──

  pushDroppedImages: (tabId, images) => {
    set((s) => ({
      pendingDroppedImages: {
        ...s.pendingDroppedImages,
        [tabId]: [...(s.pendingDroppedImages[tabId] ?? []), ...images],
      },
    }));
  },

  consumeDroppedImages: (tabId) => {
    const images = get().pendingDroppedImages[tabId] ?? [];
    if (images.length > 0) {
      set((s) => {
        const { [tabId]: _, ...rest } = s.pendingDroppedImages;
        return { pendingDroppedImages: rest };
      });
    }
    return images;
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
      id: `runner-${key}-${worktreeId}`,
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
      const id = old?.id ?? `runner-${key}-${worktreeId}`;

      // Kill idle placeholder if it exists
      if (old) {
        await commands.terminalKill(old.id).catch(() => {});
      }

      const runner: RunnerInfo = {
        id,
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
