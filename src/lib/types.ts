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

export type ThemeMode = "dark" | "light" | "system";

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
  agent_small_fast_model: string;
  agent_subagent_model: string;
  agent_bash_max_output: number;
  agent_task_max_output: number;
  mcp_servers: Record<string, McpServerEntry>;
}

export interface McpServerEntry {
  server_type: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
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
  /** MCP server status for system "session started" messages */
  mcpServers?: Array<{ name: string; status: string }>;
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

// ── Trace / Observability types ──

export type TraceEventType =
  | "query_start"      // user sent a prompt
  | "turn_start"       // assistant message received (= API call returned)
  | "turn_cost"        // per-turn token usage
  | "tool_call"        // tool invocation started
  | "tool_result"      // tool completed
  | "compact"          // context compaction
  | "query_end"        // result event (query complete)
  | "status_change"    // status transition
  | "error";           // error

/** A single trace event — the atomic unit of the trace timeline. */
export interface TraceEvent {
  id: string;
  timestamp: number;
  type: TraceEventType;
  // Tool-related
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolUseId?: string;
  isError?: boolean;
  // Cost / token-related
  cost?: TokenUsage;
  cumulativeCost?: AgentCost;
  durationMs?: number;
  numTurns?: number;
  contextWindow?: number;
  // Content
  content?: string;
  thinkingText?: string;
  status?: string;
  /** Tool names from this turn's assistant message (set on turn_start). */
  turnToolNames?: string[];
  // Compact-specific
  preTokens?: number;
  trigger?: string;
}

/** Trace panel display mode. */
export type TraceMode = "closed" | "split" | "maximized";

export interface AgentSessionState {
  messages: AgentMessage[];
  status: AgentStatus;
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
