export interface Project {
  id: string;
  name: string;
  local_path: string;
  github_remote: string;
  base_branch: string;
  setup_scripts: string[];
  build_command: string;
  run_command: string;
  env_files: string[];
  pr_create_skill: string;
  claude_command: string;
  created_at: string;
}

export interface Worktree {
  id: string;
  project_id: string;
  name: string;
  path: string;
  branch: string;
  target_branch: string | null;
  source_type: "branch" | "pr" | "tag";
  pr_number: number | null;
  pr_status: PrStatus | null;
  ci_status: CiStatus | null;
  pinned: boolean;
  archived: boolean;
  created_at: string;
}

export type PrStatus = "open" | "draft" | "merged" | "closed";
export type CiStatus = "pending" | "running" | "success" | "failure";

export interface ClaudeSession {
  id: string;
  worktree_id: string;
  name: string;
  pid: number | null;
  status: "running" | "stopped";
}

export interface TerminalSession {
  id: string;
  worktree_id: string;
  pid: number | null;
}

export type ProjectFormData = Omit<Project, "id" | "created_at">;

export interface AppSettings {
  editor_command: string;
  claude_command: string;
  terminal_font_family: string;
  terminal_font_size: number;
  terminal_emulator: string;
  shell: string;
  window_decorations: boolean;
  notification_sound: boolean;
}
