import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectFormData, Worktree, AppSettings, ImageAttachment } from "./types";

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

export async function deleteWorktree(id: string, keepBranch: boolean = false): Promise<void> {
  return invoke("delete_worktree", { id, keepBranch });
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

export async function openWorktreeFileInEditor(
  worktreePath: string,
  file: string
): Promise<void> {
  return invoke("open_worktree_file_in_editor", { worktreePath, file });
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
  body: string,
  baseBranch?: string
): Promise<PrInfo> {
  return invoke("create_pr", { projectId, worktreePath, title, body, baseBranch });
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

export interface GithubAuthStatus {
  logged_in: boolean;
  user: string | null;
  host: string;
}

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  return invoke("github_auth_status");
}

export async function githubAuthLogin(
  sessionId: string,
  rows?: number,
  cols?: number
): Promise<void> {
  return invoke("github_auth_login", { sessionId, rows, cols });
}

export async function githubAuthLogout(): Promise<void> {
  return invoke("github_auth_logout");
}

// Agent commands
export interface AgentStartOptions {
  backend?: import("./types").AgentBackend;
  model?: string;
  effort?: string;
  permissionMode?: string;
  conciseMode?: boolean;
  chatMode?: boolean;
  extendedContext?: boolean;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  resume?: string;
  apiKey?: string;
  /** Cumulative session cost from a previous app run — seeds the bridge's
   *  in-process session totals so resumed tabs keep their running totals. */
  priorCost?: import("./types").AgentCost;
}

export async function agentStart(
  sessionId: string,
  cwd: string,
  prompt: string,
  options?: AgentStartOptions,
  images?: ImageAttachment[]
): Promise<void> {
  return invoke("agent_start", {
    sessionId,
    cwd,
    prompt,
    backend: options?.backend,
    model: options?.model,
    effort: options?.effort,
    permissionMode: options?.permissionMode,
    conciseMode: options?.conciseMode,
    chatMode: options?.chatMode,
    extendedContext: options?.extendedContext,
    allowedTools: options?.allowedTools,
    maxTurns: options?.maxTurns,
    maxBudgetUsd: options?.maxBudgetUsd,
    resume: options?.resume,
    apiKey: options?.apiKey,
    priorCost: options?.priorCost,
    images: images?.length ? images : undefined,
  });
}

export async function agentSendInput(
  sessionId: string,
  text: string,
  images?: ImageAttachment[]
): Promise<void> {
  return invoke("agent_send_input", {
    sessionId,
    text,
    images: images?.length ? images : undefined,
  });
}

export async function agentInterrupt(sessionId: string): Promise<void> {
  return invoke("agent_interrupt", { sessionId });
}

export async function agentToolResponse(
  sessionId: string,
  callId: string,
  behavior: "allow" | "deny",
  message?: string,
  updatedInput?: unknown,
): Promise<void> {
  return invoke("agent_tool_response", {
    sessionId,
    callId,
    behavior,
    message,
    updatedInput,
  });
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

/** Start Pi OAuth login flow for a provider. Opens browser for auth. */
export async function piOAuthLogin(provider: string): Promise<void> {
  return invoke("pi_oauth_login", { provider });
}

/** Check which providers have OAuth credentials in ~/.pi/agent/auth.json. */
export async function piOAuthCheck(): Promise<Record<string, boolean>> {
  return invoke("pi_oauth_check");
}

/** Query the Pi SDK's built-in model registry. No running session required. */
export async function piGetModels(): Promise<
  Array<{
    value: string;
    label: string;
    provider: string;
    contextWindow: number;
    reasoning: boolean;
  }>
> {
  return invoke("pi_get_models");
}

export interface ImageFileData {
  data: string;
  media_type: string;
  file_name: string;
}

export async function readImageBase64(path: string): Promise<ImageFileData> {
  return invoke("read_image_base64", { path });
}

export interface ProjectSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export async function getProjectCommands(cwd: string): Promise<ProjectSlashCommand[]> {
  return invoke("get_project_commands", { cwd });
}

// MCP catalog + OAuth

export interface McpCatalogEntry {
  id: string;
  display_name: string;
  description: string;
  server_type: "stdio" | "sse" | "http";
  url: string;
  default_name: string;
  /** "oauth": full discovery + PKCE flow.
   *  "static-bearer": user supplies a bearer token, written into headers.
   *  "none": no automatic auth handled by Coppice. */
  auth: "oauth" | "static-bearer" | "none";
  scopes: string[];
  homepage: string;
  /** For "static-bearer": deep link to the page where the user generates the token. */
  token_url?: string;
  /** For "static-bearer": short hint shown next to the token input. */
  token_help?: string;
}

export interface McpAuthStatus {
  name: string;
  /** "connected" | "disconnected" | "expired" | "error" | "not_configured" */
  status: string;
  expires_at?: number;
  message?: string;
}

export interface McpTestResult {
  ok: boolean;
  message: string;
  status_code?: number;
  needs_oauth: boolean;
}

/** List the curated MCP servers Coppice knows how to one-click install. */
export async function mcpGetCatalog(): Promise<McpCatalogEntry[]> {
  return invoke("mcp_get_catalog");
}

export interface InstalledMcpServer {
  name: string;
  entry: import("./types").McpServerEntry;
}

/** Insert a catalog entry into settings. For static-bearer entries, pass the
 *  user-supplied token; it's written verbatim to the server's
 *  `Authorization: Bearer …` header. */
export async function mcpInstallCatalogEntry(
  catalogId: string,
  token?: string,
): Promise<InstalledMcpServer> {
  return invoke("mcp_install_catalog_entry", { catalogId, token });
}

/** Kick off the OAuth flow. Subscribe to `mcp-oauth-event` for progress. */
export async function mcpOauthStart(name: string): Promise<void> {
  return invoke("mcp_oauth_start", { name });
}

/** Drop tokens for a server (keeps server config). */
export async function mcpOauthRevoke(name: string): Promise<void> {
  return invoke("mcp_oauth_revoke", { name });
}

/** Live token-status snapshot for every configured server. */
export async function mcpGetAuthStatus(): Promise<McpAuthStatus[]> {
  return invoke("mcp_get_auth_status");
}

/** Probe a server's URL (or stdio command resolution). */
export async function mcpTestConnection(name: string): Promise<McpTestResult> {
  return invoke("mcp_test_connection", { name });
}

// Agent tab cache types
export interface AgentTabCache {
  tab_id: string;
  worktree_id: string;
  label: string;
  cwd: string;
  sdk_session_id: string | null;
  backend: string | null;
  model: string;
  effort: string;
  permission_mode: string;
  status: string;
  cost_json: string | null;
  messages_json: string;
  tab_order: number;
  extended_context: boolean;
  concise_mode: boolean;
  chat_mode: boolean;
  created_at: string;
  last_turn_cost_json: string | null;
  sdk_context_window: number | null;
  pinned: boolean;
  pinned_at: number | null;
}

// Agent tab cache commands
export async function saveAgentTabCache(tab: AgentTabCache): Promise<void> {
  return invoke("save_agent_tab_cache", { tab });
}

export async function listAgentTabCache(worktreeId: string): Promise<AgentTabCache[]> {
  return invoke("list_agent_tab_cache", { worktreeId });
}

export async function listPinnedWorktreeIds(): Promise<string[]> {
  return invoke("list_pinned_worktree_ids");
}

export async function countAgentTabCaches(): Promise<Record<string, number>> {
  return invoke("count_agent_tab_caches");
}

export async function deleteAgentTabCache(tabId: string): Promise<void> {
  return invoke("delete_agent_tab_cache", { tabId });
}

export async function deleteAgentTabCacheForWorktree(worktreeId: string): Promise<void> {
  return invoke("delete_agent_tab_cache_for_worktree", { worktreeId });
}

