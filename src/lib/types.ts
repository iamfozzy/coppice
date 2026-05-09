export const SCRATCHPAD_PROJECT_ID = "__scratchpad_project__";
export const SCRATCHPAD_WORKTREE_ID = "__scratchpad__";

export interface Project {
  id: string;
  name: string;
  local_path: string;
  github_remote: string;
  base_branch: string;
  target_branch: string;
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

export type ThemeMode = "dark" | "dim" | "atom" | "light" | "system";
export type AgentBackend = "claude" | "pi";

export interface AppSettings {
  editor_command: string;
  claude_command: string;
  terminal_font_family: string;
  terminal_font_size: number;
  terminal_emulator: string;
  shell: string;
  theme: ThemeMode;
  window_decorations: boolean;
  notification_sound: boolean;
  notification_popup: boolean;
  default_claude_mode: "agent" | "terminal";
  agent_default_model: string;
  agent_default_effort: EffortLevel;
  agent_default_extended_context: boolean;
  agent_api_key: string;
  agent_base_url: string;
  agent_base_url_custom_only: boolean;
  agent_api_key_custom_only: boolean;
  agent_small_fast_model: string;
  agent_subagent_model: string;
  agent_bash_max_output: number;
  agent_task_max_output: number;
  mcp_servers: Record<string, McpServerEntry>;

  // Pi Agent backend
  agent_backend: AgentBackend;
  pi_default_provider: string;
  pi_default_model: string;
  pi_enable_web_access: boolean;
  pi_enable_subagent: boolean;
  pi_api_keys: Record<string, string>;
  pi_configured_providers: string[];
}

export interface McpOAuthState {
  authorization_endpoint?: string;
  token_endpoint?: string;
  registration_endpoint?: string;
  client_id?: string;
  has_client_secret?: boolean;
  scopes?: string[];
  /** Whether a non-expired (or refreshable) token set is currently in the keychain. */
  connected?: boolean;
  /** Unix seconds — last successful auth/refresh. */
  last_auth_at?: number;
}

export interface McpServerEntry {
  server_type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  /** Static headers for http/sse — merged with OAuth bearer token at session start. */
  headers?: Record<string, string>;
  /** Present when this server authenticates via OAuth 2.1. */
  oauth?: McpOAuthState;
  /** Catalog ID this server was created from (e.g. "atlassian-rovo", "github"). */
  catalog_id?: string;
}

// ── Image attachment type ──

export interface ImageAttachment {
  /** base64-encoded image data */
  data: string;
  /** MIME type: image/jpeg, image/png, image/gif, image/webp */
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  /** Original filename (for display only) */
  fileName: string;
}

// ── Agent SDK types ──

export type AgentStatus = "idle" | "thinking" | "tool_use" | "waiting_permission" | "waiting_input" | "done" | "error";
export type EffortLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/** Pi thinking levels — same scale as EffortLevel, minus legacy Claude-only "max". */
export type PiThinkingLevel = Exclude<EffortLevel, "max">;
export type AgentPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";

export interface McpServerStatus {
  name: string;
  status: string;
}

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
  /** MCP server status for system "session started" messages */
  mcpServers?: McpServerStatus[];
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

/** Raw token counts for a single API call or accumulated session. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Token counts plus estimated USD cost — used for cumulative session totals. */
export interface AgentCost extends TokenUsage {
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
  backend: AgentBackend;
  model: string;
  effort: EffortLevel;
  extendedContext: boolean;
  permissionMode: AgentPermissionMode;
  cost: AgentCost | null;
  /** Token usage for the most recent completed turn only (not cumulative).
   *  Used to display current context size (input + cache + output tokens). */
  lastTurnCost: TokenUsage | null;
  /** Accumulated output tokens for the current in-flight query.
   *  Each turn_cost adds its outputTokens here so the toolbar can show
   *  progress while session totals remain frozen until the result event. */
  queryOutputTokens: number;
  /** Context window size reported by the SDK (e.g. 200000 or 1000000).
   *  More reliable than guessing from the model name string. */
  sdkContextWindow: number | null;
  sdkSessionId: string | null;
  /** MCP server status from the most recent bridge init for this session. */
  mcpServers: McpServerStatus[];
  pendingPermission: AgentPendingPermission | null;
  pendingQuestion: AgentPendingQuestion | null;
  streamingText: string;
  streamingThinkingText: string;
  conciseMode: boolean;
  chatMode: boolean;
  slashCommands: SlashCommand[];
  queuedMessages: QueuedMessage[];
}

export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
}
