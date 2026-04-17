import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectFormData, Worktree, AppSettings } from "./types";

// Project commands
export async function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

export async function createProject(data: ProjectFormData): Promise<Project> {
  return invoke("create_project", { data });
}

export async function updateProject(
  id: string,
  data: ProjectFormData
): Promise<Project> {
  return invoke("update_project", { id, data });
}

export async function deleteProject(id: string): Promise<void> {
  return invoke("delete_project", { id });
}

// Worktree commands
export async function listWorktrees(projectId: string): Promise<Worktree[]> {
  return invoke("list_worktrees", { projectId });
}

export async function createWorktree(
  projectId: string,
  branch: string,
  name: string
): Promise<Worktree> {
  return invoke("create_worktree", { projectId, branch, name });
}

export async function createWorktreeNewBranch(
  projectId: string,
  baseBranch: string,
  newBranch: string,
  name: string
): Promise<Worktree> {
  return invoke("create_worktree_new_branch", {
    projectId,
    baseBranch,
    newBranch,
    name,
  });
}

export async function getCurrentBranch(path: string): Promise<string> {
  return invoke("get_current_branch", { path });
}

export interface GitFileStatus {
  status: string;
  file: string;
}

export async function getGitStatus(path: string): Promise<GitFileStatus[]> {
  return invoke("get_git_status", { path });
}

export async function getFileContent(
  path: string,
  file: string,
  gitRef?: string
): Promise<string> {
  return invoke("get_file_content", { path, file, gitRef });
}

export async function getMergeBase(path: string, baseBranch?: string): Promise<string> {
  return invoke("get_merge_base", { path, baseBranch });
}

export async function getFileDiff(path: string, file: string): Promise<string> {
  return invoke("get_file_diff", { path, file });
}

export async function getPrDiffFiles(path: string, baseBranch?: string): Promise<GitFileStatus[]> {
  return invoke("get_pr_diff_files", { path, baseBranch });
}

export async function getPrFileDiff(path: string, file: string, baseBranch?: string): Promise<string> {
  return invoke("get_pr_file_diff", { path, file, baseBranch });
}

export async function setWorktreeTargetBranch(id: string, targetBranch: string | null): Promise<void> {
  return invoke("set_worktree_target_branch", { id, targetBranch });
}

export async function renameWorktree(id: string, name: string): Promise<void> {
  return invoke("rename_worktree", { id, name });
}

export async function deleteWorktree(id: string): Promise<void> {
  return invoke("delete_worktree", { id });
}

export async function getUnpushedCount(path: string): Promise<number> {
  return invoke("get_unpushed_count", { path });
}

export async function revertFile(path: string, file: string, status: string): Promise<void> {
  return invoke("revert_file", { path, file, status });
}

// Git commands
export async function listBranches(projectId: string): Promise<string[]> {
  return invoke("list_branches", { projectId });
}

export async function updateBaseBranch(projectId: string, branch: string): Promise<void> {
  return invoke("update_base_branch", { projectId, branch });
}

// Settings commands
export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function updateSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke("update_settings", { settings });
}

// External tool commands
export async function openInEditor(path: string): Promise<void> {
  return invoke("open_in_editor", { path });
}

/** @deprecated Use openInEditor */
export const openInVscode = openInEditor;

export async function openInTerminal(path: string): Promise<void> {
  return invoke("open_in_terminal", { path });
}

export async function openInFinder(path: string): Promise<void> {
  return invoke("open_in_finder", { path });
}

// Terminal commands
export async function terminalExists(sessionId: string): Promise<boolean> {
  return invoke("terminal_exists", { sessionId });
}

export async function terminalSpawn(
  sessionId: string,
  cwd: string,
  command?: string,
  rows?: number,
  cols?: number
): Promise<void> {
  return invoke("terminal_spawn", { sessionId, cwd, command, rows, cols });
}

export async function terminalWrite(
  sessionId: string,
  data: string
): Promise<void> {
  return invoke("terminal_write", { sessionId, data });
}

export async function terminalResize(
  sessionId: string,
  rows: number,
  cols: number
): Promise<void> {
  return invoke("terminal_resize", { sessionId, rows, cols });
}

export async function terminalKill(sessionId: string): Promise<void> {
  return invoke("terminal_kill", { sessionId });
}

// Claude hooks commands
export async function checkClaudeHooksInstalled(): Promise<boolean> {
  return invoke("check_claude_hooks_installed");
}

export async function installClaudeHooks(): Promise<void> {
  return invoke("install_claude_hooks");
}

export async function uninstallClaudeHooks(): Promise<void> {
  return invoke("uninstall_claude_hooks");
}

// GitHub commands
export interface PrInfo {
  number: number;
  title: string;
  state: string;
  url: string;
  draft: boolean;
  mergeable: string | null;
  head_ref: string;
}

export interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface PrStatusResult {
  pr: PrInfo | null;
  checks: CheckRun[];
}

export async function getPrForBranch(
  projectId: string,
  branch: string
): Promise<PrStatusResult> {
  return invoke("get_pr_for_branch", { projectId, branch });
}

export async function createPr(
  projectId: string,
  worktreePath: string,
  title: string,
  body: string
): Promise<PrInfo> {
  return invoke("create_pr", { projectId, worktreePath, title, body });
}

export async function getFailedActionLogs(
  projectId: string,
  prNumber: number
): Promise<string> {
  return invoke("get_failed_action_logs", { projectId, prNumber });
}

export interface PrComment {
  id: number;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  created_at: string;
  url: string;
  is_resolved: boolean;
  thread_id: string | null;
}

export async function getPrComments(
  projectId: string,
  prNumber: number
): Promise<PrComment[]> {
  return invoke("get_pr_comments", { projectId, prNumber });
}

export async function resolvePrComment(
  projectId: string,
  threadId: string,
  resolve: boolean
): Promise<void> {
  return invoke("resolve_pr_comment", { projectId, threadId, resolve });
}

// Agent commands
export interface AgentStartOptions {
  model?: string;
  effort?: string;
  permissionMode?: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  apiKey?: string;
}

export async function agentStart(
  sessionId: string,
  cwd: string,
  prompt: string,
  options?: AgentStartOptions
): Promise<void> {
  return invoke("agent_start", {
    sessionId,
    cwd,
    prompt,
    model: options?.model,
    effort: options?.effort,
    permissionMode: options?.permissionMode,
    allowedTools: options?.allowedTools,
    maxTurns: options?.maxTurns,
    maxBudgetUsd: options?.maxBudgetUsd,
    resume: options?.resume,
    apiKey: options?.apiKey,
  });
}

export async function agentSendInput(
  sessionId: string,
  text: string
): Promise<void> {
  return invoke("agent_send_input", { sessionId, text });
}

export async function agentInterrupt(sessionId: string): Promise<void> {
  return invoke("agent_interrupt", { sessionId });
}

export async function agentToolResponse(
  sessionId: string,
  callId: string,
  behavior: "allow" | "deny",
  message?: string
): Promise<void> {
  return invoke("agent_tool_response", { sessionId, callId, behavior, message });
}

export async function agentAskResponse(
  sessionId: string,
  callId: string,
  answers: Record<string, string>
): Promise<void> {
  return invoke("agent_ask_response", { sessionId, callId, answers });
}

export async function agentSetModel(
  sessionId: string,
  model: string
): Promise<void> {
  return invoke("agent_set_model", { sessionId, model });
}

export async function agentSetPermissionMode(
  sessionId: string,
  mode: string
): Promise<void> {
  return invoke("agent_set_permission_mode", { sessionId, mode });
}

export async function agentListCommands(sessionId: string): Promise<void> {
  return invoke("agent_list_commands", { sessionId });
}

export async function agentClose(sessionId: string): Promise<void> {
  return invoke("agent_close", { sessionId });
}

export async function agentExists(sessionId: string): Promise<boolean> {
  return invoke("agent_exists", { sessionId });
}

export interface AgentAvailability {
  available: boolean;
  reason?: string;
}

export async function agentCheckAvailable(): Promise<AgentAvailability> {
  return invoke("agent_check_available");
}

// Agent tab cache types
export interface AgentTabCache {
  tab_id: string;
  worktree_id: string;
  label: string;
  cwd: string;
  sdk_session_id: string | null;
  model: string;
  effort: string;
  permission_mode: string;
  status: string;
  cost_json: string | null;
  messages_json: string;
  tab_order: number;
  created_at: string;
}

// Agent tab cache commands
export async function saveAgentTabCache(tab: AgentTabCache): Promise<void> {
  return invoke("save_agent_tab_cache", { tab });
}

export async function listAgentTabCache(worktreeId: string): Promise<AgentTabCache[]> {
  return invoke("list_agent_tab_cache", { worktreeId });
}

export async function deleteAgentTabCache(tabId: string): Promise<void> {
  return invoke("delete_agent_tab_cache", { tabId });
}

export async function deleteAgentTabCacheForWorktree(worktreeId: string): Promise<void> {
  return invoke("delete_agent_tab_cache_for_worktree", { worktreeId });
}
