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
  notification_popup: boolean;
  default_claude_mode: "agent" | "terminal";
  agent_default_model: string;
  agent_default_effort: EffortLevel;
  agent_default_extended_context: boolean;
  agent_node_path: string;
  agent_api_key: string;
  mcp_servers: Record<string, McpServerEntry>;
}

export interface McpServerEntry {
  server_type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// ── Agent SDK types ──

export type AgentStatus = "idle" | "thinking" | "tool_use" | "waiting_permission" | "waiting_input" | "done" | "error";
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type AgentPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface AgentMessage {
  id: string;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "system" | "error" | "slash_output";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolUseId?: string;
  isError?: boolean;
  isQueued?: boolean;
  thinkingText?: string;
  timestamp: number;
}

export interface AgentPendingPermission {
  callId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface AgentPendingQuestion {
  callId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string; preview?: string }>;
    multiSelect: boolean;
  }>;
}

export interface AgentCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalCostUsd: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface AgentSessionState {
  messages: AgentMessage[];
  status: AgentStatus;
  model: string;
  effort: EffortLevel;
  extendedContext: boolean;
  permissionMode: AgentPermissionMode;
  cost: AgentCost | null;
  sdkSessionId: string | null;
  pendingPermission: AgentPendingPermission | null;
  pendingQuestion: AgentPendingQuestion | null;
  streamingText: string;
  slashCommands: SlashCommand[];
  queuedMessages: string[];
}
