import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectFormData, Worktree } from "./types";

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

export async function renameWorktree(id: string, name: string): Promise<void> {
  return invoke("rename_worktree", { id, name });
}

export async function deleteWorktree(id: string): Promise<void> {
  return invoke("delete_worktree", { id });
}

// Git commands
export async function listBranches(projectId: string): Promise<string[]> {
  return invoke("list_branches", { projectId });
}

// External tool commands
export async function openInVscode(path: string): Promise<void> {
  return invoke("open_in_vscode", { path });
}

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
