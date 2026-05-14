/**
 * Coppice Pi Agent Bridge
 *
 * Drives @earendil-works/pi-coding-agent AgentSession via the same
 * JSON-line stdin/stdout protocol as bridge.mjs. One process per
 * agent session.
 *
 * Stdin (Rust → Node): one JSON object per line
 * Stdout (Node → Rust): one JSON object per line
 * Stderr: debug/error logging (forwarded by Rust to app logs)
 *
 * Uses Pi's AgentSession (via createAgentSession) for full feature
 * support: compaction, slash commands, prompt templates, skills,
 * auto-retry, model management, and session statistics.
 */

import { getModel, getProviders, getModels, completeSimple } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createInterface } from "readline";
import { readFile, readdir, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { constants as fsConstants, mkdirSync } from "node:fs";

// ── Helpers ──

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(...args) {
  process.stderr.write("[pi-bridge] " + args.join(" ") + "\n");
}

/**
 * Translate an MCP transport / connect error into a short, user-facing
 * description. Returns just the description (no server name) — the caller
 * decides whether to prefix with the server name for context.
 *
 * The MCP SDK's transports throw errors whose `.message` is sometimes a
 * raw "non-200 status code: 401" string and sometimes a multi-line stack
 * trace. We normalise both shapes here. NEVER include `err.stack`: those
 * frames pollute the UI without telling the user anything actionable.
 */
function describeMcpError(err) {
  if (!err) return "connection failed";
  const raw = typeof err === "string" ? err : err.message || String(err);
  // Take only the first non-empty line so a stack-formatted message still
  // produces a clean badge.
  const firstLine = raw.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || raw;

  const httpMatch = firstLine.match(/non-200 status code:\s*(\d+)/i);
  const httpCode = httpMatch ? Number(httpMatch[1]) : (typeof err.code === "number" ? err.code : undefined);

  if (httpCode === 401) return "not authorized (HTTP 401) — open Settings → MCP Servers and click Connect";
  if (httpCode === 403) return "forbidden (HTTP 403) — your token may be missing the required scopes";
  if (httpCode === 404) return "endpoint not found (HTTP 404) — check the server URL";
  if (typeof httpCode === "number" && httpCode >= 500) return `server error (HTTP ${httpCode}) — try again shortly`;
  if (typeof httpCode === "number") return `server returned HTTP ${httpCode}`;

  const netMatch = firstLine.match(/\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENETUNREACH|EAI_AGAIN)\b/);
  const netCode = netMatch?.[1];
  if (netCode === "ENOTFOUND" || netCode === "EAI_AGAIN") return "DNS lookup failed — check the server URL or your connection";
  if (netCode === "ECONNREFUSED") return "connection refused — is the server running and reachable?";
  if (netCode === "ETIMEDOUT" || /timeout/i.test(firstLine)) return "connection timed out";
  if (netCode === "ECONNRESET") return "connection reset by the server";
  if (netCode === "ENETUNREACH") return "network unreachable";

  // Fall back to the trimmed first line — strip "Error: " prefix and limit
  // length to keep the badge tidy.
  return firstLine.replace(/^Error:\s*/i, "").slice(0, 200) || "connection failed";
}

/**
 * Trim large tool result text for frontend display/storage.
 * Strategy: keep the first and last N lines, insert a "[trimmed]" marker.
 */
const TOOL_RESULT_MAX_LINES = 200;
const TOOL_RESULT_KEEP_LINES = 80;

function trimToolResult(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.split("\n");
  if (lines.length <= TOOL_RESULT_MAX_LINES) return text;
  const omitted = lines.length - TOOL_RESULT_KEEP_LINES * 2;
  return [
    ...lines.slice(0, TOOL_RESULT_KEEP_LINES),
    `\n... [${omitted} lines trimmed] ...\n`,
    ...lines.slice(-TOOL_RESULT_KEEP_LINES),
  ].join("\n");
}

/** Extract readable text from Pi's tool result content blocks. */
function extractResultText(result) {
  if (!result || !result.content) return "";
  return result.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Pi thinking levels (superset of Coppice effort levels). */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Resolve thinking level from options. Accepts either:
 * - Pi native level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
 * - Coppice effort level: "low" | "medium" | "high" | "xhigh" | "max"
 * Returns a valid Pi ThinkingLevel.
 */
function resolveThinkingLevel(opts) {
  if (opts.thinkingLevel && PI_THINKING_LEVELS.includes(opts.thinkingLevel)) {
    return opts.thinkingLevel;
  }
  switch (opts.effort) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "xhigh";
    default:
      return "medium";
  }
}

// ── Coppice system prompt appendages ──
// These are injected into the system prompt AgentSession builds, via
// promptGuidelines on Coppice tool definitions and a post-creation append.

const CONCISE_MODE_INSTRUCTION = `CONCISE MODE: no preamble, no filler, no restating plans or summaries. Execute multi-step tasks silently; report only final outcome. Sentence fragments ok. Errors: state failure + fix only. No apologies, hedges, unrequested alternatives, or explanatory code comments.`;

const TOOL_FRUGALITY_INSTRUCTION = `Keep tool outputs small: they persist in context for every later turn. Prefer grep with path filters over wide searches; read files with offset/limit when you know the region; pipe noisy commands through head/tail. Don't cat whole large files or directories to browse — target what you need.`;

const COPPICE_TOOLS_INSTRUCTION = `You are running inside the Coppice desktop IDE. Prefer coppice_ prefixed tools over shell equivalents when IDE integration helps. Only use IDE tools when it genuinely helps, not for routine intermediate steps.`;

const SUBAGENT_INSTRUCTION = `Subagent context-isolation policy:
- If you expect to use 3+ exploratory tools (grep/read/bash/code_search/web_search/fetch_content) before you can act, delegate that exploration to a scout/researcher first. The child's context is discarded; only its concise report returns.
- If you have multiple independent investigations or implementation chunks, use one subagent call with a tasks array so they run in parallel instead of doing sequential tool calls yourself.
- For unfamiliar code, default to a scout before planning. For broad research, use researcher. For implementation sequencing, use planner. After non-trivial edits, use reviewer.
- Ask children to return concise findings with file paths/line numbers and no long pasted outputs.

Examples of when to delegate:
- "Find all usages of handleEvent across the codebase" → scout
- "Understand how the auth module connects to the session manager" → researcher
- "Plan the implementation for adding dark mode support" → planner
- "Implement the new API endpoint in routes/ while I work on the frontend" → worker
- "Review the changes I just made to the database layer" → reviewer
- "Run the test suite and report failures" → tester
- Multiple independent tasks (e.g. "find X" + "find Y" + "implement Z") → single subagent call with tasks array

Do NOT use subagent for:
- Simple single-file reads, quick edits, or one-off commands — the overhead isn't worth it.
- Tasks where you already have the context you need.
- Anything that requires back-and-forth with the user — subagents run to completion without user interaction.`;

// ── Coppice IDE tools (ToolDefinition format for AgentSession) ──

/** Monotonically increasing call ID for coppice tool round-trips. */
let callIdCounter = 0;
function nextCallId() {
  return `pi-${++callIdCounter}`;
}

/** Pending coppice tool calls awaiting Rust responses. */
const pendingCoppiceToolCalls = new Map();

/**
 * Call a Coppice IDE tool. Emits a coppice_tool_call on stdout, then
 * waits for coppice_tool_result on stdin (routed by Rust agent_manager).
 */
function callCoppice(toolName, args) {
  const callId = nextCallId();
  emit({ type: "coppice_tool_call", callId, toolName, args });
  return new Promise((resolve) => {
    pendingCoppiceToolCalls.set(callId, { resolve });
    setTimeout(() => {
      if (pendingCoppiceToolCalls.has(callId)) {
        pendingCoppiceToolCalls.delete(callId);
        resolve({
          content: [{ type: "text", text: "Coppice tool call timed out" }],
          details: {},
        });
      }
    }, 60_000);
  });
}

/** Helper: build a Coppice tool execute function. */
function coppiceExecute(toolName) {
  return async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
    const result = await callCoppice(toolName, params);
    return {
      content: [
        { type: "text", text: result.result || JSON.stringify(result) },
      ],
      details: {},
    };
  };
}

/**
 * Build the 7 Coppice IDE tools as ToolDefinition[] for AgentSession.
 * These are passed via the `customTools` option to createAgentSession().
 */
function buildCoppiceToolDefinitions() {
  return [
    defineTool({
      name: "coppice_create_worktree",
      label: "Create Worktree",
      description:
        "Create a new git worktree in the Coppice IDE. Registers it in the project model and copies env files. Provide an existing branch name to check out, OR set new_branch + base_branch to create a new branch. When you have a task to perform in the new worktree, pass it as 'prompt' — Coppice will switch to the new worktree and spawn a new agent tab with that task. Do NOT cd into the worktree yourself after creating it.",
      promptSnippet: "Create a git worktree registered in the Coppice IDE",
      promptGuidelines: [
        "Use coppice_create_worktree instead of raw git worktree commands — it registers the worktree in the IDE and copies env files. Pass work as the 'prompt' parameter; NEVER cd into the new worktree yourself.",
      ],
      parameters: Type.Object({
        branch: Type.Optional(
          Type.String({ description: "Existing branch to check out" }),
        ),
        new_branch: Type.Optional(
          Type.String({ description: "Name for a new branch to create" }),
        ),
        base_branch: Type.Optional(
          Type.String({
            description: "Base branch for new_branch (defaults to main)",
          }),
        ),
        name: Type.Optional(
          Type.String({
            description: "Worktree folder name (defaults to branch name)",
          }),
        ),
        prompt: Type.Optional(
          Type.String({
            description:
              "Task for a new agent tab to execute in the created worktree.",
          }),
        ),
      }),
      executionMode: "sequential",
      execute: coppiceExecute("create_worktree"),
    }),
    defineTool({
      name: "coppice_list_worktrees",
      label: "List Worktrees",
      description:
        "List all worktrees registered in the current Coppice project.",
      promptSnippet: "List IDE-registered worktrees",
      parameters: Type.Object({}),
      execute: coppiceExecute("list_worktrees"),
    }),
    defineTool({
      name: "coppice_spawn_terminal",
      label: "Spawn Terminal",
      description:
        "Open a new terminal tab in the Coppice IDE, optionally running a command in it.",
      promptSnippet: "Open a terminal tab in the Coppice IDE",
      promptGuidelines: [
        "Use coppice_spawn_terminal to open new terminal tabs in the IDE, optionally running a command.",
      ],
      parameters: Type.Object({
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory for the terminal (defaults to current worktree)",
          }),
        ),
        command: Type.Optional(
          Type.String({
            description: "Command to run in the terminal after opening",
          }),
        ),
      }),
      execute: coppiceExecute("spawn_terminal"),
    }),
    defineTool({
      name: "coppice_open_file",
      label: "Open File",
      description:
        "Open a file in the Coppice IDE's editor/diff tab so the user can see it.",
      promptSnippet: "Open a file in the Coppice IDE editor",
      promptGuidelines: [
        "Use coppice_open_file to surface files in the IDE's editor tabs so the user can see them.",
      ],
      parameters: Type.Object({
        path: Type.String({
          description:
            "Absolute path or path relative to the worktree root",
        }),
      }),
      execute: coppiceExecute("open_file"),
    }),
    defineTool({
      name: "coppice_open_scratchpad",
      label: "Open Scratchpad",
      description:
        "Create a new agent tab in the Coppice scratchpad with pre-filled content. Useful for plans, notes, or generated content.",
      promptSnippet: "Create a scratchpad with notes or generated content",
      parameters: Type.Object({
        content: Type.String({
          description: "Content to pre-fill as the initial prompt",
        }),
        title: Type.Optional(
          Type.String({ description: "Label for the scratchpad tab" }),
        ),
      }),
      execute: coppiceExecute("open_scratchpad"),
    }),
    defineTool({
      name: "coppice_open_url",
      label: "Open URL",
      description:
        "Open a URL in the user's system browser. Use for PR links, documentation, or other web pages the user should see.",
      promptSnippet: "Open a URL in the user's browser",
      promptGuidelines: [
        "Use coppice_open_url for links the user should visit (PR URLs, documentation).",
      ],
      parameters: Type.Object({
        url: Type.String({ description: "The URL to open" }),
      }),
      execute: coppiceExecute("open_url"),
    }),
  ];
}

// ── Todo / Plan tools ──

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
let currentTodos = [];

function cloneTodos(todos) {
  return todos.map((todo) => ({ ...todo }));
}

function normalizeTodoItems(value, { enforceSingleInProgress = true } = {}) {
  if (!Array.isArray(value)) {
    throw new Error("todos must be an array");
  }

  const todos = value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`todos[${index}] must be an object`);
    }

    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (!content) {
      throw new Error(`todos[${index}].content must be a non-empty string`);
    }

    const status = item.status;
    if (!TODO_STATUSES.has(status)) {
      throw new Error(
        `todos[${index}].status must be one of: pending, in_progress, completed`,
      );
    }

    const todo = { content, status };
    if (typeof item.activeForm === "string" && item.activeForm.trim()) {
      todo.activeForm = item.activeForm.trim();
    }
    return todo;
  });

  if (
    enforceSingleInProgress &&
    todos.filter((todo) => todo.status === "in_progress").length > 1
  ) {
    throw new Error("only one todo may be in_progress at a time");
  }

  return todos;
}

function tryNormalizePersistedTodos(value) {
  try {
    return normalizeTodoItems(value, { enforceSingleInProgress: false });
  } catch {
    return null;
  }
}

function extractTodosFromStoredMessage(msg) {
  if (!msg || typeof msg !== "object") return null;

  if (msg.role === "toolResult" && msg.toolName === "TodoWrite") {
    const todos = tryNormalizePersistedTodos(msg.details?.todos);
    if (todos) return todos;
  }

  if (msg.role === "assistant" && Array.isArray(msg.content)) {
    let latest = null;
    for (const block of msg.content) {
      if (block?.type === "toolCall" && block.name === "TodoWrite") {
        const todos = tryNormalizePersistedTodos(block.arguments?.todos);
        if (todos) latest = todos;
      }
    }
    return latest;
  }

  return null;
}

function reconstructTodoState(sessionManager) {
  currentTodos = [];

  try {
    const entries = typeof sessionManager.getBranch === "function"
      ? sessionManager.getBranch()
      : (sessionManager.buildSessionContext?.().messages || []).map((message) => ({
          type: "message",
          message,
        }));

    for (const entry of entries || []) {
      if (entry?.type !== "message") continue;
      const todos = extractTodosFromStoredMessage(entry.message);
      if (todos) currentTodos = todos;
    }

    log(`todos: reconstructed ${currentTodos.length} item(s)`);
  } catch (err) {
    currentTodos = [];
    log(`todos: failed to reconstruct (${err.message})`);
  }
}

function formatTodosForTool(todos) {
  if (!todos.length) return "No todos";
  return todos
    .map((todo) => {
      const marker = todo.status === "completed"
        ? "x"
        : todo.status === "in_progress"
          ? "~"
          : " ";
      const active = todo.status === "in_progress" && todo.activeForm
        ? ` — ${todo.activeForm}`
        : "";
      return `[${marker}] ${todo.content}${active}`;
    })
    .join("\n");
}

function buildTodoToolDefinitions() {
  const TodoItem = Type.Object({
    content: Type.String({
      description: "Task description",
    }),
    status: Type.String({
      description: "Task status: pending, in_progress, or completed",
    }),
    activeForm: Type.Optional(
      Type.String({
        description:
          "Optional present-tense wording for the current in-progress task",
      }),
    ),
  });

  return [
    defineTool({
      name: "TodoRead",
      label: "Todo Read",
      description:
        "Read the current session todo list used to track plan progress.",
      promptSnippet: "Read the current task plan/todo list",
      promptGuidelines: [
        "Use TodoRead to inspect the current task plan before resuming multi-step work.",
      ],
      parameters: Type.Object({}),
      execute: async () => ({
        content: [{ type: "text", text: formatTodosForTool(currentTodos) }],
        details: { todos: cloneTodos(currentTodos) },
      }),
    }),
    defineTool({
      name: "TodoWrite",
      label: "Todo Write",
      description:
        "Create or update the current session todo list. Use this for multi-step tasks and keep statuses current as work progresses.",
      promptSnippet: "Create or update a visible task plan/todo list",
      promptGuidelines: [
        "Use TodoWrite for multi-step tasks so the user can see the plan and progress.",
        "Keep TodoWrite current: mark a task in_progress before working on it and completed as soon as it is done.",
        "Use exactly one in_progress todo while actively working; leave all others pending or completed.",
        "Do not use TodoWrite for trivial single-step requests.",
      ],
      parameters: Type.Object({
        todos: Type.Array(TodoItem, {
          description:
            "Full replacement todo list. Each item must include content and status.",
        }),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        currentTodos = normalizeTodoItems(params.todos);
        const completed = currentTodos.filter(
          (todo) => todo.status === "completed",
        ).length;
        return {
          content: [
            {
              type: "text",
              text:
                `Todo list updated (${completed}/${currentTodos.length} completed)` +
                (currentTodos.length ? `\n\n${formatTodosForTool(currentTodos)}` : ""),
            },
          ],
          details: {
            todos: cloneTodos(currentTodos),
            completed,
            total: currentTodos.length,
          },
        };
      },
    }),
  ];
}

// ── Subagent system ──

/**
 * Built-in agent roles. Each defines a system prompt append and default
 * thinking level. Read-only roles have write tools blocked via beforeToolCall.
 */
const SUBAGENT_ROLES = {
  scout: {
    label: "Scout",
    systemPromptAppend:
      "You are a fast reconnaissance agent. Read files, search code, and gather context. Do NOT modify any files.\n\n" +
      "Response format — keep under 300 words:\n" +
      "## Files examined\n- path/to/file.ts (lines X-Y) — brief note\n" +
      "## Findings\n- Bullet points with file:line references\n" +
      "## Recommendation\n- One-liner if applicable",
    thinkingLevel: "low",
    readOnly: true,
  },
  researcher: {
    label: "Researcher",
    systemPromptAppend:
      "You are a thorough research agent. Explore the codebase, read documentation, trace code paths, and produce a comprehensive analysis. Do NOT modify files.\n\n" +
      "Response format — keep under 500 words:\n" +
      "## Files examined\n- path/to/file.ts (lines X-Y) — brief note\n" +
      "## Analysis\n- Detailed findings with file:line references\n" +
      "## Connections\n- How components relate to each other\n" +
      "## Recommendation\n- Actionable next steps",
    thinkingLevel: "medium",
    readOnly: true,
  },
  planner: {
    label: "Planner",
    systemPromptAppend:
      "You are a planning agent. Analyze the codebase and produce a detailed, step-by-step implementation plan. Do NOT modify files. Focus on file paths, function signatures, and sequencing.\n\n" +
      "Response format:\n" +
      "## Files to modify\n- path/to/file.ts — what changes and why\n" +
      "## Implementation steps\n1. Step with file:line references\n" +
      "## Risks / edge cases\n- Bullet points\n" +
      "## Testing strategy\n- How to verify the changes",
    thinkingLevel: "high",
    readOnly: true,
  },
  worker: {
    label: "Worker",
    systemPromptAppend:
      "You are an implementation agent. Execute the task you have been given. You have full tool access. Be thorough and verify your work.\n\n" +
      "Response format — keep concise:\n" +
      "## Changes made\n- path/to/file.ts — what was changed\n" +
      "## Verification\n- How you verified the changes work\n" +
      "## Notes\n- Anything the parent agent should know",
    thinkingLevel: "medium",
    readOnly: false,
  },
  reviewer: {
    label: "Reviewer",
    systemPromptAppend:
      "You are a code review agent. Examine the specified code for bugs, style issues, security concerns, and correctness. Do NOT modify files.\n\n" +
      "Response format:\n" +
      "## Files reviewed\n- path/to/file.ts (lines X-Y)\n" +
      "## Issues found\n- [severity] file:line — description\n" +
      "## Suggestions\n- Improvement ideas\n" +
      "## Verdict\n- Overall assessment (approve / needs changes)",
    thinkingLevel: "medium",
    readOnly: true,
  },
  tester: {
    label: "Tester",
    systemPromptAppend:
      "You are a testing agent. Run tests, analyze failures, and report results. You have full tool access to execute test commands.\n\n" +
      "Response format:\n" +
      "## Tests run\n- Command executed and scope\n" +
      "## Results\n- X passed, Y failed, Z skipped\n" +
      "## Failures\n- test name — file:line — brief failure reason\n" +
      "## Recommendation\n- What to fix first",
    thinkingLevel: "low",
    readOnly: false,
  },
};

let childIdCounter = 0;

/**
 * Spawn a child AgentSession, run it to completion, and return the final text.
 * The child shares the parent's auth and cwd but gets a scoped tool set
 * with no subagent tool (prevents recursion).
 */
async function runChildSession({ task, agent: roleName, childId, signal, model: modelOverride }) {
  const role = SUBAGENT_ROLES[roleName] || SUBAGENT_ROLES.worker;
  const cid = childId || `child-${++childIdCounter}`;
  const startTime = Date.now();

  // Tracking accumulators (display-only, not sent to parent context)
  let toolCount = 0;
  const filesExplored = new Set();
  const filesModified = new Set();
  const transcript = []; // { tool, summary, status }

  log(`subagent[${cid}]: starting role=${roleName} task="${task.slice(0, 80)}"`);
  emit({
    type: "subagent_progress",
    childId: cid,
    role: roleName,
    event: "start",
    task: task.slice(0, 200),
  });

  // Build scoped tool set — Coppice IDE tools (read-only subset for read-only roles)
  // but NO subagent tool (prevents recursion)
  let childCustomTools = buildCoppiceToolDefinitions();
  if (role.readOnly) {
    const readOnlyNames = new Set([
      "coppice_list_worktrees",
      "coppice_open_file",
      "coppice_open_scratchpad",
      "coppice_open_url",
    ]);
    childCustomTools = childCustomTools.filter((t) =>
      readOnlyNames.has(t.name),
    );
  }

  // Add web access tools if available
  try {
    const webTools = await getCachedWebAccessTools();
    childCustomTools = [...childCustomTools, ...webTools];
  } catch {}

  // Add MCP tools from the parent session. Read-only child roles only receive
  // MCP tools that advertise readOnlyHint.
  if (currentMcpToolDefinitions.length > 0) {
    const mcpTools = role.readOnly
      ? currentMcpToolDefinitions.filter((t) => currentMcpReadOnlyToolNames.has(t.name))
      : currentMcpToolDefinitions;
    childCustomTools = [...childCustomTools, ...mcpTools];
  }

  // Use in-memory session manager — no persistence for ephemeral children
  const childSessionManager = SessionManager.inMemory();

  // Model resolution: explicit override > role default > parent model > fallback
  let childModel;
  if (modelOverride) {
    try {
      // Try to resolve as "provider/model" or just "model" (default anthropic)
      const parts = modelOverride.split("/");
      const provider = parts.length > 1 ? parts[0] : "anthropic";
      const modelId = parts.length > 1 ? parts.slice(1).join("/") : modelOverride;
      childModel = getModel(provider, modelId);
    } catch {
      log(`subagent[${cid}]: model override "${modelOverride}" failed, using parent model`);
      childModel = session ? session.model : getModel("anthropic", "claude-sonnet-4-20250514");
    }
  } else {
    childModel = session
      ? session.model
      : getModel("anthropic", "claude-sonnet-4-20250514");
  }

  const { session: childSession } = await createAgentSession({
    cwd: currentCwd,
    model: childModel,
    thinkingLevel: role.thinkingLevel || "medium",
    authStorage,
    sessionManager: childSessionManager,
    customTools: childCustomTools,
  });

  // Append role-specific system prompt
  childSession.agent.state.systemPrompt +=
    "\n\n---\n\n" +
    role.systemPromptAppend +
    "\n\n" +
    TOOL_FRUGALITY_INSTRUCTION;

  // For read-only roles, block write tools via beforeToolCall
  if (role.readOnly) {
    const origHook = childSession.agent.beforeToolCall;
    childSession.agent.beforeToolCall = async (context, sig) => {
      if (origHook) {
        const result = await origHook(context, sig);
        if (result?.block) return result;
      }
      const writeTools = ["edit", "write"];
      if (writeTools.includes(context.toolCall.name)) {
        return { block: true, reason: `${role.label} agent is read-only` };
      }
      if (context.toolCall.name === "bash") {
        const cmd = (context.args.command || "").trim();
        const writePat =
          /\b(rm|mv|cp|mkdir|touch|chmod|chown|git\s+(add|commit|push|reset|checkout))\b|[>|]/;
        if (writePat.test(cmd)) {
          return { block: true, reason: `${role.label} agent is read-only` };
        }
      }
      return undefined;
    };
  } else {
    // Worker/non-read-only: bypass permissions (parent already approved delegation)
    childSession.agent.beforeToolCall = async () => undefined;
  }

  /**
   * Extract a short summary from tool args for the transcript and progress events.
   * Returns a human-readable string like "src/foo.ts" or "grep 'pattern' in src/".
   */
  function summarizeToolArgs(toolName, args) {
    if (!args) return "";
    const a = typeof args === "object" ? args : {};
    switch (toolName) {
      case "read":
        return a.file_path ? shortPath(a.file_path) : "";
      case "edit":
      case "write":
        return a.file_path ? shortPath(a.file_path) : "";
      case "grep":
      case "code_search":
        return [a.pattern, a.path ? `in ${shortPath(a.path)}` : ""].filter(Boolean).join(" ");
      case "glob":
        return [a.pattern, a.path ? `in ${shortPath(a.path)}` : ""].filter(Boolean).join(" ");
      case "bash":
        return a.command ? a.command.slice(0, 60) : "";
      case "web_search":
        return a.query ? a.query.slice(0, 60) : "";
      case "fetch_content":
        return a.url ? a.url.slice(0, 60) : "";
      default:
        return "";
    }
  }

  /** Shorten an absolute path to the last 2-3 segments for display. */
  function shortPath(p) {
    if (!p) return "";
    const segments = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return segments.length <= 3 ? segments.join("/") : segments.slice(-3).join("/");
  }

  /** Track file paths from tool args. */
  function trackFiles(toolName, args) {
    if (!args) return;
    const a = typeof args === "object" ? args : {};
    const filePath = a.file_path || a.path;
    if (filePath) {
      if (toolName === "edit" || toolName === "write") {
        filesModified.add(shortPath(filePath));
      } else if (toolName === "read" || toolName === "grep" || toolName === "glob" || toolName === "code_search") {
        filesExplored.add(shortPath(filePath));
      }
    }
  }

  // Forward child progress events to frontend with richer data
  const unsub = childSession.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      toolCount++;
      const args = event.args || event.input;
      const summary = summarizeToolArgs(event.toolName, args);
      trackFiles(event.toolName, args);

      transcript.push({ tool: event.toolName, summary, status: "running" });

      emit({
        type: "subagent_progress",
        childId: cid,
        role: roleName,
        event: "tool_start",
        toolName: event.toolName,
        toolSummary: summary,
        toolCount,
      });
    } else if (event.type === "tool_execution_end") {
      // Update the last transcript entry status
      const last = transcript[transcript.length - 1];
      if (last && last.tool === event.toolName) {
        last.status = event.isError ? "error" : "ok";
      }

      emit({
        type: "subagent_progress",
        childId: cid,
        role: roleName,
        event: "tool_end",
        toolName: event.toolName,
        toolCount,
      });
    }
  });

  // Handle cancellation via AbortSignal
  const abortHandler = () => {
    childSession.abort().catch(() => {});
  };
  signal?.addEventListener("abort", abortHandler);

  try {
    await childSession.prompt(task);

    const elapsed = Date.now() - startTime;

    // Extract final assistant text
    const messages = childSession.agent.state.messages;
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    let resultText = "";
    if (lastAssistant?.content) {
      for (const block of lastAssistant.content) {
        if (block.type === "text") resultText += block.text;
      }
    }

    // For worker/tester roles, append a structured diff summary extracted from
    // actual tool calls (not relying on the agent's prose)
    if (!role.readOnly && filesModified.size > 0) {
      const diffSummary = `\n\n## Files modified (verified)\n${[...filesModified].map((f) => `- ${f}`).join("\n")}`;
      resultText += diffSummary;
    }

    log(`subagent[${cid}]: completed in ${elapsed}ms, ${toolCount} tools, ${resultText.length} chars`);

    // Emit transcript for frontend display (not in parent context)
    emit({
      type: "subagent_progress",
      childId: cid,
      role: roleName,
      event: "transcript",
      transcript: transcript.map((t) => ({
        tool: t.tool,
        summary: t.summary,
        status: t.status,
      })),
    });

    // Emit done with stats
    emit({
      type: "subagent_progress",
      childId: cid,
      role: roleName,
      event: "done",
      stats: {
        toolCount,
        elapsed,
        filesExplored: [...filesExplored],
        filesModified: [...filesModified],
      },
    });

    return resultText || "(No output from subagent)";
  } catch (err) {
    const elapsed = Date.now() - startTime;
    log(`subagent[${cid}]: error after ${elapsed}ms: ${err.message}`);
    emit({
      type: "subagent_progress",
      childId: cid,
      role: roleName,
      event: "error",
      error: err.message,
      stats: { toolCount, elapsed, filesExplored: [...filesExplored], filesModified: [...filesModified] },
    });
    return `Subagent error: ${err.message}`;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    unsub();
    childSession.dispose();
  }
}

/**
 * Build the subagent tool definition.
 * Kept separate so it can be conditionally included (not added to children).
 */
function buildSubagentToolDefinition() {
  return defineTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a task to a child agent that runs independently and returns its result. " +
      "Use to keep parent context small when a task would require multiple exploratory tool calls, " +
      "or for parallel work, focused research, code review, testing, and isolated implementation. " +
      "Single task: { agent, task }. Parallel: { tasks: [{ agent, task }, ...] }.",
    promptSnippet: "Spawn child agents for parallel or focused work",
    promptGuidelines: [
      "Context rule: if you expect 3+ exploratory tool calls before acting, delegate that exploration " +
        "to a scout/researcher and continue from its concise report.",
      "Use subagent for tasks that benefit from isolation: parallel implementation, " +
        "focused research, testing, or review. Each child runs with its own context window.",
      "Available roles: scout (fast read-only recon), researcher (thorough analysis), " +
        "planner (implementation planning), worker (full implementation), reviewer (code review), " +
        "tester (run tests and report results).",
      "Prefer a single subagent call with a tasks array over sequential calls for parallelizable work.",
      "Ask children to return concise findings with file paths/line numbers and no long pasted outputs.",
      "The child agent's final response text is returned as the tool result.",
      "Use the model parameter to override the child's model — e.g. use a cheaper/faster model for scouts.",
    ],
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description:
            "Agent role: scout, researcher, planner, worker, reviewer, tester. Default: worker",
        }),
      ),
      task: Type.Optional(
        Type.String({ description: "Task description for a single agent" }),
      ),
      tasks: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.Optional(
              Type.String({ description: "Agent role" }),
            ),
            task: Type.String({ description: "Task description" }),
            model: Type.Optional(
              Type.String({ description: "Model override for this task (e.g. 'claude-sonnet-4-20250514')" }),
            ),
          }),
          { description: "Array of tasks for parallel execution" },
        ),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model override for the child agent (e.g. 'claude-sonnet-4-20250514'). Defaults to parent model.",
        }),
      ),
    }),
    executionMode: "sequential",
    execute: async (_toolCallId, params, signal) => {
      // Normalize: single task or parallel tasks array
      let taskList;
      if (params.tasks && params.tasks.length > 0) {
        taskList = params.tasks;
      } else if (params.task) {
        taskList = [{ agent: params.agent || "worker", task: params.task, model: params.model }];
      } else {
        return {
          content: [
            { type: "text", text: "Error: provide either 'task' or 'tasks'" },
          ],
          details: {},
        };
      }

      log(`subagent: dispatching ${taskList.length} task(s)`);

      try {
        if (taskList.length === 1) {
          const t = taskList[0];
          const result = await runChildSession({
            task: t.task,
            agent: t.agent || "worker",
            model: t.model || params.model,
            signal,
          });
          return {
            content: [{ type: "text", text: trimToolResult(result) }],
            details: {},
          };
        }

        // Parallel execution
        const results = await Promise.allSettled(
          taskList.map((t, i) =>
            runChildSession({
              task: t.task,
              agent: t.agent || "worker",
              model: t.model || params.model,
              childId: `child-${++childIdCounter}`,
              signal,
            }),
          ),
        );

        const output = results
          .map((r, i) => {
            const role = taskList[i].agent || "worker";
            const header = `## ${role} (task ${i + 1}/${taskList.length})`;
            if (r.status === "fulfilled") {
              return `${header}\n${r.value}`;
            }
            return `${header}\nERROR: ${r.reason?.message || r.reason}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: trimToolResult(output) }],
          details: {},
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Subagent error: ${err.message}` },
          ],
          details: {},
        };
      }
    },
  });
}

// ── Web access tool loading ──

/**
 * Load pi-web-access tools by importing the package and intercepting
 * its registerTool() calls. Returns ToolDefinition[] on success, [] on failure.
 *
 * pi-web-access ships as raw .ts source (it's a Pi extension package,
 * not a compiled npm module), so we use jiti to transpile it on the fly —
 * the same approach Pi's own extension loader uses.
 */
async function loadWebAccessTools() {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);

    // Resolve the package directory
    let pkgDir;
    try {
      const pkgJson = require.resolve("pi-web-access/package.json");
      pkgDir = join(pkgJson, "..");
    } catch {
      log("pi-web-access: package not found, skipping");
      return [];
    }

    const entryFile = join(pkgDir, "index.ts");
    if (!(await fileExists(entryFile))) {
      log("pi-web-access: index.ts not found, skipping");
      return [];
    }

    // Use jiti to transpile the TypeScript extension.
    // Pi extensions import from the old @mariozechner/* package names —
    // alias them to the current @earendil-works/* packages (same as Pi's
    // own extension loader does via virtualModules/alias).
    const nmDir = join(pkgDir, "..");
    const resolvePkgDir = (pkg) => join(nmDir, pkg);
    const { createJiti } = await import("jiti/static");
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@mariozechner/pi-coding-agent": resolvePkgDir("@earendil-works/pi-coding-agent"),
        "@mariozechner/pi-agent-core": resolvePkgDir("@earendil-works/pi-agent-core"),
        "@mariozechner/pi-tui": resolvePkgDir("@earendil-works/pi-tui"),
        "@mariozechner/pi-ai": resolvePkgDir("@earendil-works/pi-ai"),
      },
    });
    const mod = await jiti.import(entryFile, { default: true });

    const factory = typeof mod === "function" ? mod : mod?.default;
    if (typeof factory !== "function") {
      log("pi-web-access: no factory function exported");
      return [];
    }

    // Collect tools from the extension's registerTool() calls
    const tools = [];
    const noOp = () => {};
    const mockApi = {
      registerTool(tool) {
        tools.push(tool);
      },
      on: noOp,
      registerCommand: noOp,
      registerShortcut: noOp,
      registerFlag: noOp,
      registerMessageRenderer: noOp,
      registerProvider: noOp,
      unregisterProvider: noOp,
      getFlag() {
        return undefined;
      },
      sendMessage: noOp,
      sendUserMessage: noOp,
      appendEntry: noOp,
      setSessionName: noOp,
      getSessionName() {
        return undefined;
      },
      setLabel: noOp,
      exec: noOp,
      getActiveTools() {
        return [];
      },
      getAllTools() {
        return [];
      },
      setActiveTools: noOp,
      getCommands() {
        return [];
      },
      setModel: noOp,
      getThinkingLevel() {
        return "medium";
      },
      setThinkingLevel: noOp,
      events: { emit: noOp, on: noOp, off: noOp },
    };

    await factory(mockApi);
    log(`pi-web-access: loaded ${tools.length} tools`);

    // Web access tools arrive as AgentTool-shaped objects from the extension.
    // Wrap them as ToolDefinitions so they work with createAgentSession's
    // customTools option. The shape is close enough that we just need to add
    // the signal/onUpdate/ctx params to the execute signature.
    return tools.map((t) =>
      defineTool({
        name: t.name,
        label: t.label || t.name,
        description: t.description || "",
        parameters: t.parameters || Type.Object({}),
        executionMode: t.executionMode || "parallel",
        execute: async (toolCallId, params, _signal, _onUpdate, _ctx) => {
          // The extension tool execute has the old (toolCallId, params) signature
          return t.execute(toolCallId, params);
        },
      }),
    );
  } catch (err) {
    log("pi-web-access not available:", err.message);
    return [];
  }
}

/** Check if a file exists. */
async function fileExists(path) {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the platform-specific app data directory, matching Rust's dirs::data_dir().
 */
function getAppDataDir() {
  switch (platform()) {
    case "darwin":
      return join(homedir(), "Library", "Application Support");
    case "win32":
      return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    default:
      return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  }
}

/**
 * Get the path to a Pi session JSONL file for a given session ID.
 * Creates the parent directory if it doesn't exist.
 */
function getSessionFilePath(sessionId) {
  const dir = join(getAppDataDir(), "coppice", "pi-sessions");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.jsonl`);
}

let cachedWebAccessToolsPromise = null;

async function getCachedWebAccessTools() {
  if (!cachedWebAccessToolsPromise) {
    cachedWebAccessToolsPromise = loadWebAccessTools().catch((err) => {
      cachedWebAccessToolsPromise = null;
      throw err;
    });
  }
  return cachedWebAccessToolsPromise;
}

// ── MCP server support ──

/** Active MCP client connections for the current Pi session. */
let mcpConnections = [];
let currentMcpToolDefinitions = [];
let currentMcpStatuses = [];
let currentMcpReadOnlyToolNames = new Set();
/** Map of server name → live McpClient, used for dynamic reconnect on token refresh. */
let mcpClientMap = new Map();
/** Map of server name → original server config entry (with headers etc.). */
let currentMcpServerEntries = {};

function sanitizeMcpName(name) {
  const sanitized = String(name || "mcp")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "mcp";
}

function makeMcpToolName(serverName, toolName, usedNames) {
  const base = `mcp__${sanitizeMcpName(serverName)}__${sanitizeMcpName(toolName)}`;
  let candidate = base;
  let i = 2;
  while (usedNames.has(candidate)) {
    candidate = `${base}_${i++}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function mcpResultToText(result) {
  if (!result) return "";
  if ("toolResult" in result) {
    return typeof result.toolResult === "string"
      ? result.toolResult
      : JSON.stringify(result.toolResult, null, 2);
  }

  const parts = [];
  for (const block of result.content || []) {
    if (block.type === "text") {
      parts.push(block.text || "");
    } else if (block.type === "resource") {
      const res = block.resource || {};
      if (typeof res.text === "string") {
        parts.push(`Resource ${res.uri || ""}:\n${res.text}`.trim());
      } else {
        parts.push(`Resource ${res.uri || ""}: ${JSON.stringify(res)}`.trim());
      }
    } else if (block.type === "resource_link") {
      parts.push(`Resource link: ${block.title || block.name || block.uri}${block.uri ? ` (${block.uri})` : ""}`);
    } else {
      parts.push(JSON.stringify(block));
    }
  }

  if (result.structuredContent) {
    parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
  }

  return parts.join("\n\n") || JSON.stringify(result, null, 2);
}

function buildMcpTransport(serverName, entry) {
  const type = entry.type || entry.server_type || (entry.command ? "stdio" : "http");
  if (type === "stdio") {
    if (!entry.command) throw new Error("stdio MCP server requires a command");
    return new StdioClientTransport({
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args : [],
      env: entry.env && typeof entry.env === "object" ? entry.env : undefined,
      cwd: currentCwd,
      stderr: "pipe",
    });
  }
  if (!entry.url) throw new Error(`${type} MCP server requires a URL`);
  const url = new URL(entry.url);

  // Headers are injected by Rust (settings.rs `headers` map + the Bearer
  // token from `mcp_oauth::access_token_for_session`). The MCP SDK's
  // `requestInit.headers` covers the POST channel; for SSE we additionally
  // need a fetch override on `eventSourceInit` because EventSource doesn't
  // natively accept custom headers — without this, the GET that opens the
  // SSE stream is unauthenticated and the server returns 401.
  const headers = entry.headers && typeof entry.headers === "object" ? { ...entry.headers } : {};
  const hasHeaders = Object.keys(headers).length > 0;
  const requestInit = hasHeaders ? { headers } : undefined;

  if (type === "sse") {
    const opts = {};
    if (requestInit) opts.requestInit = requestInit;
    if (hasHeaders) {
      opts.eventSourceInit = {
        fetch: (input, init) => {
          // The eventsource lib may hand us a Headers instance OR a plain
          // object; using `new Headers()` normalises both. Our headers go
          // last so they override anything (e.g. a stale Authorization).
          const merged = new Headers(init?.headers || {});
          for (const [k, v] of Object.entries(headers)) merged.set(k, v);
          return fetch(input, { ...(init || {}), headers: merged });
        },
      };
    }
    return new SSEClientTransport(url, opts);
  }
  if (type === "http" || type === "streamable_http" || type === "streamable-http") {
    return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  throw new Error(`Unsupported MCP server type: ${type}`);
}

async function closeMcpConnections() {
  const connections = mcpConnections;
  mcpConnections = [];
  currentMcpToolDefinitions = [];
  currentMcpStatuses = [];
  currentMcpReadOnlyToolNames = new Set();
  mcpClientMap.clear();
  currentMcpServerEntries = {};
  await Promise.allSettled(
    connections.map(async ({ client, name }) => {
      try {
        await client.close();
        log(`mcp: closed ${name}`);
      } catch (err) {
        log(`mcp: close failed for ${name}: ${err.message}`);
      }
    }),
  );
}

async function loadMcpToolDefinitions(mcpServers) {
  await closeMcpConnections();

  if (!mcpServers || typeof mcpServers !== "object" || Object.keys(mcpServers).length === 0) {
    return { tools: [], statuses: [] };
  }

  const tools = [];
  const statuses = [];
  const usedNames = new Set(tools.map((t) => t.name));

  for (const [serverName, entry] of Object.entries(mcpServers)) {
    const client = new McpClient({ name: "coppice-pi-agent", version: "0.1.0" }, { capabilities: {} });
    let transport;
    try {
      log(`mcp: connecting ${serverName}...`);
      transport = buildMcpTransport(serverName, entry || {});
      if (transport.stderr) {
        transport.stderr.on("data", (chunk) => {
          const text = String(chunk).trim();
          if (text) log(`mcp:${serverName}: ${text.slice(0, 500)}`);
        });
      }
      await client.connect(transport, { timeout: 30_000 });
      const listed = await client.listTools(undefined, { timeout: 30_000 });
      const serverTools = listed.tools || [];
      statuses.push({ name: serverName, status: "connected" });
      mcpConnections.push({ name: serverName, client });
      mcpClientMap.set(serverName, client);
      currentMcpServerEntries[serverName] = entry;
      log(`mcp: connected ${serverName} (${serverTools.length} tools)`);

      for (const tool of serverTools) {
        const piToolName = makeMcpToolName(serverName, tool.name, usedNames);
        const readOnly = tool.annotations?.readOnlyHint === true;
        if (readOnly) currentMcpReadOnlyToolNames.add(piToolName);
        tools.push(
          defineTool({
            name: piToolName,
            label: tool.annotations?.title || tool.name,
            description:
              `MCP tool from server '${serverName}' (original tool: '${tool.name}').\n` +
              (tool.description || ""),
            promptSnippet: `MCP ${serverName}: ${tool.name}`,
            promptGuidelines: [
              `Use ${piToolName} when the user asks for capabilities provided by the '${serverName}' MCP server.`,
            ],
            parameters: Type.Unsafe(tool.inputSchema || { type: "object", properties: {} }),
            executionMode: "parallel",
            execute: async (_toolCallId, params, signal) => {
              const currentClient = mcpClientMap.get(serverName);
              if (!currentClient) throw new Error(`MCP server '${serverName}' is not connected`);
              if (signal?.aborted) throw new Error("MCP tool call cancelled");
              const result = await currentClient.callTool(
                { name: tool.name, arguments: params || {} },
                CallToolResultSchema,
                { timeout: 120_000, resetTimeoutOnProgress: true, signal },
              );
              const text = trimToolResult(mcpResultToText(result));
              if (result.isError) {
                throw new Error(text || "MCP tool returned an error");
              }
              return {
                content: [{ type: "text", text }],
                details: { server: serverName, tool: tool.name },
              };
            },
          }),
        );
      }
    } catch (err) {
      const description = describeMcpError(err);
      // Status badge in the toolbar shows the short description.
      statuses.push({ name: serverName, status: `error: ${description}` });
      // Surface a structured event so the chat thread gets one clean line
      // per failed server (instead of a multi-line stack trace leaking out
      // of stderr).
      emit({
        type: "mcp_error",
        serverName,
        message: `${serverName}: ${description}`,
        code: typeof err?.code === "number" ? err.code : undefined,
      });
      // Local stderr log — kept for debugging in dev consoles, but only the
      // first line of the message (no stack). The structured event above is
      // what the user actually sees in the UI.
      const firstLine = (err?.message || String(err)).split(/\r?\n/)[0];
      log(`mcp: failed ${serverName}: ${firstLine}`);
      try {
        await client.close();
      } catch {
        /* ignore */
      }
    }
  }

  currentMcpToolDefinitions = tools;
  currentMcpStatuses = statuses;
  return { tools, statuses };
}

// ── Permission system ──

/**
 * Pending frontend permission responses. Map<callId, { resolve, toolInput }>.
 */
const pendingToolResponses = new Map();

/**
 * Pending AskUser question responses. Map<callId, { resolve }>.
 */
const pendingAskResponses = new Map();

/**
 * Handle tool permission based on the current permission mode.
 * Returns undefined to allow, or { block: true, reason } to deny.
 * For default mode, emits a tool_permission event and waits for
 * a response from the frontend.
 */
async function handlePermission(toolCall, args, permissionMode) {
  const toolName = toolCall.name;

  // Coppice IDE read-only tools — always allow
  const readOnlyTools = [
    "coppice_list_worktrees",
    "coppice_open_file",
    "coppice_open_scratchpad",
    "coppice_open_url",
  ];
  if (readOnlyTools.includes(toolName)) return undefined;

  // Pi's read-only/internal tools — always allow
  const piReadOnly = ["read", "grep", "find", "ls", "TodoRead"];
  if (piReadOnly.includes(toolName)) return undefined;
  if (toolName === "TodoWrite") return undefined;

  // MCP tools that advertise readOnlyHint are safe to auto-allow.
  if (currentMcpReadOnlyToolNames.has(toolName)) return undefined;

  // Bypass mode — auto-allow everything
  if (permissionMode === "bypassPermissions") return undefined;

  // AcceptEdits mode — auto-allow file ops and safe bash
  if (permissionMode === "acceptEdits") {
    const autoAllow = ["edit", "write"];
    if (autoAllow.includes(toolName)) return undefined;
    if (toolName === "bash") {
      const cmd = (args.command || "").trim();
      const safePrefixes =
        /^(ls|cat|head|tail|wc|find|echo|pwd|mkdir|touch|cp|mv)\b/;
      if (safePrefixes.test(cmd)) return undefined;
    }
    // Web access tools are read-only in nature
    if (
      toolName === "web_search" ||
      toolName === "fetch_content" ||
      toolName === "code_search" ||
      toolName === "get_search_content"
    )
      return undefined;
  }

  // Default — prompt frontend via tool_permission event
  const callId = nextCallId();
  emit({ type: "tool_permission", callId, toolName, toolInput: args });

  return new Promise((resolve) => {
    pendingToolResponses.set(callId, { resolve, toolInput: args });
    // Timeout after 2 minutes — auto-deny
    setTimeout(() => {
      if (pendingToolResponses.has(callId)) {
        pendingToolResponses.delete(callId);
        resolve({ block: true, reason: "Permission request timed out" });
      }
    }, 120_000);
  });
}

// ── Session state ──

/** @type {import("@earendil-works/pi-coding-agent").AgentSession | null} */
let session = null;
let sessionUnsubscribe = null;
let authStorage = null;
let currentCwd = process.cwd();
let currentPermissionMode = "default";
let heartbeatTimer = null;

/**
 * Env var names per provider — matches Pi's own getApiKeyEnvVars() mapping
 * from @earendil-works/pi-ai/dist/env-api-keys.js so credential resolution
 * is consistent.
 */
const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  minimax: "MINIMAX_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  huggingface: "HF_TOKEN",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

/** Check if an API key is set via environment variable for a provider. */
function getEnvApiKey(providerName) {
  const envVar = PROVIDER_ENV_VARS[providerName];
  if (envVar && process.env[envVar]) return process.env[envVar];
  return undefined;
}

/** Session-scoped env vars we override and must reset between queries. */
const SESSION_OVERRIDE_ENV_VARS = [
  ...new Set(Object.values(PROVIDER_ENV_VARS)),
  "BASH_MAX_OUTPUT_LENGTH",
  "TASK_MAX_OUTPUT_LENGTH",
];

/** Snapshot inherited env so a reused bridge can return to a clean baseline. */
const BASE_SESSION_ENV = Object.fromEntries(
  SESSION_OVERRIDE_ENV_VARS.map((name) => [name, process.env[name]]),
);

function resetSessionEnv() {
  for (const name of SESSION_OVERRIDE_ENV_VARS) {
    const value = BASE_SESSION_ENV[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function applySessionEnvOverrides(opts) {
  resetSessionEnv();

  if (opts.apiKey) {
    process.env.ANTHROPIC_API_KEY = opts.apiKey;
  }

  if (opts.piApiKeys && typeof opts.piApiKeys === "object") {
    for (const [prov, key] of Object.entries(opts.piApiKeys)) {
      if (key && typeof key === "string") {
        const envVar = PROVIDER_ENV_VARS[prov] || PROVIDER_ENV_VARS[prov.toLowerCase()];
        if (envVar) {
          process.env[envVar] = key;
        }
      }
    }
  }

  if (opts.bashMaxOutputLength) {
    process.env.BASH_MAX_OUTPUT_LENGTH = String(opts.bashMaxOutputLength);
  }
  if (opts.taskMaxOutputLength) {
    process.env.TASK_MAX_OUTPUT_LENGTH = String(opts.taskMaxOutputLength);
  }
}

/** Cumulative session cost totals. */
let sessionTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCostUsd: 0,
};
let sessionTotalsSeeded = false;

/** Last per-turn usage for context window display. */
let lastTurnUsage = null;

function usageToTokenUsage(usage) {
  return {
    inputTokens: usage.input || 0,
    outputTokens: usage.output || 0,
    cacheReadTokens: usage.cacheRead || 0,
    cacheWriteTokens: usage.cacheWrite || 0,
  };
}

function addUsageToSessionTotals(usage) {
  const tokens = usageToTokenUsage(usage);
  sessionTotals.inputTokens += tokens.inputTokens;
  sessionTotals.outputTokens += tokens.outputTokens;
  sessionTotals.cacheReadTokens += tokens.cacheReadTokens;
  sessionTotals.cacheWriteTokens += tokens.cacheWriteTokens;
  sessionTotals.totalCostUsd += usage.cost?.total || 0;
}

/** Whether we've already kicked off title generation for this bridge. */
let titleGenerated = false;

/**
 * Generate a short tab title using the user's current Pi model.
 * Fire-and-forget — failures are silently logged.
 */
async function generateTitle(prompt, provider, modelId) {
  log("Generating title for prompt:", prompt.slice(0, 80));
  try {
    // Ensure the provider's API key env var is set — completeSimple runs
    // outside AgentSession and doesn't have access to authStorage directly.
    if (authStorage) {
      const envVar = PROVIDER_ENV_VARS[provider];
      if (envVar && !process.env[envVar]) {
        const key = await authStorage.getApiKey(provider);
        if (key) {
          process.env[envVar] = key;
          log("Title: set", envVar, "from authStorage");
        }
      }
    }

    const model = getModel(provider, modelId);
    const result = await completeSimple(model, {
      systemPrompt:
        "Generate a very short tab title (2-5 words) summarizing this task. Respond with ONLY the title, no quotes or punctuation.",
      messages: [
        {
          role: "user",
          content: `Task: ${prompt.slice(0, 500)}`,
          timestamp: Date.now(),
        },
      ],
    }, {
      maxTokens: 100,
    });
    let title = (result.content || [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("");
    title = title.trim().replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "");
    log("Generated title:", title);
    if (title) emit({ type: "title", title });
  } catch (err) {
    log("Title generation failed:", err.message);
  }
}

// ── Event subscription ──

// Streaming updates can arrive token-by-token. If we forward every delta (and
// especially every debug log) over Tauri IPC, WebKit's Web Content process can
// get buried under thousands of tiny events. Batch adjacent deltas in the
// bridge, then the frontend still does its own requestAnimationFrame flush.
const PARTIAL_FLUSH_MS = 40;
let partialFlushTimer = null;
let partialTextBuffer = "";
let partialThinkingBuffer = "";

function flushPartialBuffers() {
  if (partialFlushTimer) {
    clearTimeout(partialFlushTimer);
    partialFlushTimer = null;
  }
  if (partialThinkingBuffer) {
    emit({ type: "partial", delta: { type: "thinking", text: partialThinkingBuffer } });
    partialThinkingBuffer = "";
  }
  if (partialTextBuffer) {
    emit({ type: "partial", delta: { type: "text", text: partialTextBuffer } });
    partialTextBuffer = "";
  }
}

function queuePartialDelta(kind, text) {
  if (!text) return;
  if (kind === "thinking") {
    partialThinkingBuffer += text;
  } else {
    partialTextBuffer += text;
  }

  // Flush immediately if the buffer is getting large; otherwise coalesce over
  // a short interval. This caps IPC event rate without making streaming feel
  // laggy.
  if (partialTextBuffer.length + partialThinkingBuffer.length >= 8192) {
    flushPartialBuffers();
    return;
  }

  if (!partialFlushTimer) {
    partialFlushTimer = setTimeout(flushPartialBuffers, PARTIAL_FLUSH_MS);
  }
}

/** Log only low-volume event breadcrumbs. High-volume message/tool updates and
 * large payload events would otherwise be forwarded to the WebView on stderr. */
function logSessionEvent(event) {
  if (event.type === "message_update" || event.type === "tool_execution_update") return;
  log(`event: ${event.type}`);
}

/**
 * Subscribe to AgentSession events and emit them in Coppice's event format.
 * AgentSession emits the same core Agent events (message_start, message_end,
 * etc.) PLUS session-specific events (compaction_start, compaction_end,
 * auto_retry_start, auto_retry_end, thinking_level_changed).
 */
function subscribeToSessionEvents(agentSession) {
  if (sessionUnsubscribe) {
    sessionUnsubscribe();
    sessionUnsubscribe = null;
  }

  sessionUnsubscribe = agentSession.subscribe((event) => {
    logSessionEvent(event);
    switch (event.type) {
      case "message_start":
        if (event.message?.role === "assistant") {
          emit({ type: "status", status: "thinking" });
        }
        break;

      case "message_update": {
        const aEvent = event.assistantMessageEvent;
        if (!aEvent) break;
        if (aEvent.type === "text_delta") {
          queuePartialDelta("text", aEvent.delta);
        } else if (aEvent.type === "thinking_delta") {
          queuePartialDelta("thinking", aEvent.delta);
        } else if (aEvent.type === "text_start" || aEvent.type === "thinking_start") {
          emit({ type: "status", status: "thinking" });
        }
        break;
      }

      case "message_end": {
        // Ensure no delayed partial event can arrive after the final assistant
        // message (which would leave duplicate live text under the completed
        // response in the frontend).
        flushPartialBuffers();

        const msg = event.message;
        if (!msg || msg.role !== "assistant") break;

        // Surface real API errors (auth failures, rate limits, etc.).
        // Aborts are normal interrupts and should not appear as chat errors.
        if (msg.stopReason === "error") {
          const errMsg = msg.errorMessage || `Request failed: ${msg.stopReason}`;
          log(`API error: ${errMsg}`);
          emit({ type: "error", message: errMsg });
          break;
        }
        if (msg.stopReason === "aborted") {
          log(`request interrupted: ${msg.errorMessage || "aborted"}`);
          break;
        }

        // Build content blocks in Coppice format
        const blocks = [];
        for (const block of msg.content || []) {
          if (block.type === "text") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "toolCall") {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.arguments,
            });
            emit({ type: "status", status: "tool_use" });
          } else if (block.type === "thinking") {
            blocks.push({ type: "thinking", text: block.thinking });
          }
        }

        emit({ type: "assistant", content: blocks });

        // Emit per-turn usage
        const usage = msg.usage;
        if (usage) {
          lastTurnUsage = usageToTokenUsage(usage);
          addUsageToSessionTotals(usage);
          log(
            `turn usage: in=${lastTurnUsage.inputTokens} CR=${lastTurnUsage.cacheReadTokens} CW=${lastTurnUsage.cacheWriteTokens} out=${lastTurnUsage.outputTokens}`,
          );
        }
        emit({
          type: "turn_cost",
          cost: lastTurnUsage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        });
        break;
      }

      case "tool_execution_start":
        emit({
          type: "status",
          status: "tool_use",
        });
        break;

      case "tool_execution_update":
        emit({
          type: "tool_progress",
          toolUseId: event.toolCallId,
          toolName: event.toolName,
          elapsed: 0,
        });
        break;

      case "tool_execution_end": {
        const resultText = extractResultText(event.result);
        emit({
          type: "tool_result",
          toolUseId: event.toolCallId,
          content: trimToolResult(resultText),
          isError: event.isError,
        });
        break;
      }

      case "agent_end": {
        flushPartialBuffers();

        const lastAssistant = [...(event.messages || [])]
          .reverse()
          .find((m) => m.role === "assistant");

        // Context window from Pi's session accounting when available. This is
        // more accurate than a model-name heuristic and matches Pi's own footer,
        // including provider-specific windows and post-compaction unknown usage.
        const contextUsage = agentSession.getContextUsage?.();
        const currentModel = agentSession.model;
        const contextWindow = contextUsage?.contextWindow || currentModel?.contextWindow || 0;

        const subtype = lastAssistant?.stopReason === "aborted"
          ? "interrupted"
          : lastAssistant?.stopReason === "error"
            ? "error"
            : "success";

        emit({
          type: "result",
          subtype,
          sessionId: "",
          cost: { ...sessionTotals },
          lastTurnCost: {
            totalCostUsd: 0,
            ...(lastTurnUsage ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            }),
          },
          contextWindow,
          durationMs: 0,
          numTurns: 0,
        });

        lastTurnUsage = null;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        break;
      }

      // ── AgentSession-specific events ──

      case "compaction_start":
        log(`compaction started: reason=${event.reason}`);
        // Only emit status — do NOT emit slash_output here because
        // the frontend's slash_output handler calls setStatus("done"),
        // which would corrupt state mid-stream.
        emit({ type: "status", status: "thinking" });
        break;

      case "compaction_end":
        if (event.result && !event.aborted) {
          log(`compaction complete: ${event.result.tokensBefore} tokens before`);
          emit({
            type: "compact_boundary",
            summary: event.result.summary || "",
          });
        } else if (event.aborted) {
          log("compaction aborted");
        } else if (event.errorMessage) {
          log(`compaction failed: ${event.errorMessage}`);
          emit({ type: "error", message: `Compaction failed: ${event.errorMessage}` });
        }
        break;

      case "auto_retry_start":
        // Log only — do NOT emit slash_output (frontend handler calls setStatus("done"),
        // corrupting state during an active retry cycle).
        log(`auto-retry: attempt ${event.attempt}/${event.maxAttempts} delay=${event.delayMs}ms: ${event.errorMessage}`);
        break;

      case "auto_retry_end":
        log(`auto-retry ended: success=${event.success} attempt=${event.attempt}${event.finalError ? ` error=${event.finalError}` : ""}`);
        if (!event.success && event.finalError) {
          emit({ type: "error", message: event.finalError });
        }
        break;

      case "thinking_level_changed":
        log(`thinking level changed to: ${event.level}`);
        break;

      default:
        break;
    }
  });
}

/**
 * Load project commands from .claude/commands/ and .claude/skills/ directories.
 * These are cross-SDK — they work in both Claude and Pi modes.
 * Pi has its own prompt templates from .pi/prompts/ handled by AgentSession.
 */
async function loadClaudeProjectCommands(cwd) {
  const commands = [];
  const seen = new Set();

  // Scan .claude/commands/ for flat *.md files (project-local first, then user-global)
  const commandDirs = [
    join(cwd, ".claude", "commands"),
    join(homedir(), ".claude", "commands"),
  ];
  for (const dir of commandDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -3);
      if (seen.has(name)) continue;
      try {
        const content = await readFile(join(dir, entry.name), "utf8");
        const firstLine = content.split("\n").find((l) => l.trim()) || "";
        seen.add(name);
        commands.push({ name, description: firstLine.trim(), argumentHint: "$ARGUMENTS" });
      } catch {
        // Unreadable file — skip
      }
    }
  }

  // Scan .claude/skills/ for <name>/SKILL.md
  const skillDirs = [
    join(cwd, ".claude", "skills"),
    join(homedir(), ".claude", "skills"),
  ];
  for (const dir of skillDirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (seen.has(name)) continue;
      try {
        const content = await readFile(join(dir, name, "SKILL.md"), "utf8");
        const firstLine = content.split("\n").find((l) => l.trim()) || "";
        seen.add(name);
        commands.push({ name, description: firstLine.trim(), argumentHint: "$ARGUMENTS" });
      } catch {
        // SKILL.md missing or unreadable — skip
      }
    }
  }

  return commands;
}

/**
 * Expand a .claude/commands/ or .claude/skills/ slash command.
 * Returns the expanded content or null if no match.
 * This handles commands that Pi's AgentSession won't know about
 * (since Pi only expands .pi/prompts/ templates internally).
 */
async function expandClaudeCommand(prompt, cwd) {
  if (!prompt || !prompt.startsWith("/")) return null;
  const match = prompt.match(/^\/(\S+)(?:\s+(.*))?$/s);
  if (!match) return null;
  const [, name, args] = match;
  const candidates = [
    join(cwd, ".claude", "commands", `${name}.md`),
    join(homedir(), ".claude", "commands", `${name}.md`),
    join(cwd, ".claude", "skills", name, "SKILL.md"),
    join(homedir(), ".claude", "skills", name, "SKILL.md"),
  ];
  for (const filePath of candidates) {
    try {
      let content = await readFile(filePath, "utf8");
      if (args !== undefined) {
        content = content.replaceAll("$ARGUMENTS", args);
      } else {
        content = content.replaceAll("$ARGUMENTS", "");
      }
      return content.trim();
    } catch {
      // File not found — try next candidate
    }
  }
  return null;
}

/**
 * Emit the slash command list for the frontend command picker.
 * Includes: allowed Pi builtins + prompt templates from .pi/prompts/
 * + cross-SDK commands from .claude/commands/ and .claude/skills/.
 */
async function emitSlashCommands() {
  if (!session) return;

  const commands = [];
  const seen = new Set();

  // Add allowed built-in commands
  commands.push(
    { name: "compact", description: "Compact the conversation history", argumentHint: "[instructions]" },
    { name: "model", description: "Change the model", argumentHint: "[model]" },
    { name: "session", description: "Show session info and stats", argumentHint: "" },
  );
  for (const c of commands) seen.add(c.name);

  // Add prompt templates from AgentSession's resource loader (.pi/prompts/)
  try {
    const templates = session.promptTemplates;
    if (templates && templates.length > 0) {
      for (const t of templates) {
        if (seen.has(t.name)) continue;
        seen.add(t.name);
        commands.push({
          name: t.name,
          description: t.description || "",
          argumentHint: t.argumentHint || "$ARGUMENTS",
        });
      }
    }
  } catch (err) {
    log("Failed to load prompt templates:", err.message);
  }

  // Add cross-SDK commands from .claude/commands/ and .claude/skills/
  try {
    const claudeCommands = await loadClaudeProjectCommands(currentCwd);
    for (const c of claudeCommands) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      commands.push(c);
    }
  } catch (err) {
    log("Failed to load .claude/ commands:", err.message);
  }

  emit({ type: "commands", commands });
}

// ── Session handler ──

async function startSession(msg) {
  const opts = msg.options || {};
  currentCwd = msg.cwd || process.cwd();
  currentPermissionMode = opts.permissionMode || "default";

  // Seed session totals from prior cost (for resumed sessions)
  if (!sessionTotalsSeeded && opts.priorCost) {
    sessionTotals.inputTokens = opts.priorCost.inputTokens || 0;
    sessionTotals.outputTokens = opts.priorCost.outputTokens || 0;
    sessionTotals.cacheReadTokens = opts.priorCost.cacheReadTokens || 0;
    sessionTotals.cacheWriteTokens = opts.priorCost.cacheWriteTokens || 0;
    sessionTotals.totalCostUsd = opts.priorCost.totalCostUsd || 0;
    sessionTotalsSeeded = true;
  }

  // Resolve model
  const provider = opts.piProvider || "anthropic";
  const modelId = opts.piModelId || "claude-sonnet-4-20250514";
  let model;
  try {
    model = getModel(provider, modelId);
  } catch (err) {
    log(`Failed to resolve model ${provider}/${modelId}: ${err.message}`);
    emit({
      type: "error",
      message: `Unknown model: ${provider}/${modelId}. Check your Pi Agent settings.`,
    });
    return;
  }

  log(`session start provider=${provider} model=${modelId}`);

  // Resolve thinking level (accepts both Pi native and Coppice effort levels)
  const thinkingLevel = resolveThinkingLevel(opts);

  // Reset any previous per-session overrides before applying the latest auth
  // and tool-output settings. Reused bridge processes must not keep stale
  // API keys or output limits from an earlier failed run.
  applySessionEnvOverrides(opts);

  // Refresh auth storage on every start so an existing session picks up new
  // OAuth credentials written by a separate login flow.
  try {
    if (!authStorage) {
      authStorage = AuthStorage.create();
    } else {
      authStorage.reload?.();
    }
    const hasAnthropicAuth = typeof authStorage.hasAuth === "function"
      ? authStorage.hasAuth("anthropic")
      : !!(await authStorage.getApiKey("anthropic"));
    log(`auth storage: loaded (anthropic=${hasAnthropicAuth})`);
  } catch (err) {
    log(`auth storage: failed to init (${err.message}), falling back to env vars`);
  }

  // Build custom tools (Coppice IDE tools + MCP + web access)
  log("step: building custom tools...");
  const coppiceTools = buildCoppiceToolDefinitions();
  let customTools = [...coppiceTools, ...buildTodoToolDefinitions()];

  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    log("step: loading MCP servers...");
    const { tools: mcpTools, statuses } = await loadMcpToolDefinitions(opts.mcpServers);
    log(`step: MCP servers done (${mcpTools.length} tools, ${statuses.length} servers)`);
    customTools = [...customTools, ...mcpTools];
  } else {
    await closeMcpConnections();
  }

  if (opts.enableWebAccess !== false) {
    log("step: loading web access tools...");
    try {
      const webTools = await getCachedWebAccessTools();
      log(`step: web access tools done (${webTools.length})`);
      customTools = [...customTools, ...webTools];
    } catch (err) {
      log(`step: web access tools failed: ${err.message}`);
    }
  }

  // Add subagent tool (only for the parent session, not children)
  if (opts.enableSubagent !== false) {
    log("step: adding subagent tool...");
    customTools.push(buildSubagentToolDefinition());
  }

  // Dispose previous session. The file-backed SessionManager has already
  // written all messages to disk via appendFileSync, so no data is lost.
  if (session) {
    try {
      session.dispose();
    } catch {
      /* ignore */
    }
    session = null;
    sessionUnsubscribe = null;
  }

  // Use file-backed SessionManager so the SDK handles message persistence
  // and restoration automatically. The JSONL file is created lazily on the
  // first assistant response and read back on subsequent startSession calls.
  const sessionId = msg.sessionId || `unnamed-${Date.now()}`;
  const sessionFilePath = getSessionFilePath(sessionId);
  const sessionManager = SessionManager.open(sessionFilePath, undefined, currentCwd);
  const existingCtx = sessionManager.buildSessionContext();
  const resumeCount = existingCtx.messages.length;
  reconstructTodoState(sessionManager);

  log(`step: creating AgentSession (tools=${customTools.length} thinking=${thinkingLevel} resume=${resumeCount} file=${sessionFilePath})...`);

  try {
    const { session: newSession } = await createAgentSession({
      cwd: currentCwd,
      model,
      thinkingLevel,
      authStorage,
      sessionManager,
      customTools,
      // No tools in chat mode
      ...(opts.chatMode ? { noTools: "all" } : {}),
    });

    session = newSession;

    // Install permission hook on the underlying Agent.
    // Chain with any existing hook installed by createAgentSession() (e.g. _installAgentToolHooks).
    const originalBeforeToolCall = session.agent.beforeToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      const result = await handlePermission(
        context.toolCall,
        context.args,
        currentPermissionMode,
      );
      if (result && result.block) {
        return { block: true, reason: result.reason || "Denied by user" };
      }
      // Delegate to the SDK's original hook (handles tool registry dispatch, etc.)
      if (originalBeforeToolCall) {
        return originalBeforeToolCall(context, signal);
      }
      return undefined; // allow
    };

    // Keep parallel tool execution
    session.agent.toolExecution = "parallel";

    // Filter out error/aborted assistant messages from restored context.
    // The JSONL file persists all messages including failures; clean them
    // out so they don't confuse the model or waste context tokens.
    const restoredMessages = session.agent.state.messages;
    const cleanMessages = restoredMessages.filter((m) => {
      if (m?.role !== "assistant") return true;
      return m.stopReason !== "error" && m.stopReason !== "aborted";
    });
    if (cleanMessages.length !== restoredMessages.length) {
      log(
        `filtered ${restoredMessages.length - cleanMessages.length} error/aborted message(s) from restored context`,
      );
      session.agent.state.messages = cleanMessages;
    }

    // Append Coppice-specific instructions to the system prompt.
    // Per-tool guidance is handled by promptGuidelines on each tool definition;
    // only general context and frugality instructions are appended here.
    const basePrompt = session.systemPrompt || "";
    const coppiceAppend = [
      "",
      "---",
      "",
      TOOL_FRUGALITY_INSTRUCTION,
      "",
      "---",
      "",
      COPPICE_TOOLS_INSTRUCTION,
    ];
    if (opts.enableSubagent !== false) {
      coppiceAppend.push("", "---", "", SUBAGENT_INSTRUCTION);
    }
    if (opts.conciseMode) {
      coppiceAppend.push("", "---", "", CONCISE_MODE_INSTRUCTION);
    }
    session.agent.state.systemPrompt = basePrompt + "\n" + coppiceAppend.join("\n");
  } catch (err) {
    log(`createAgentSession failed: ${err.message}`, err.stack);
    emit({
      type: "error",
      message: `Failed to create agent session: ${err.message}`,
    });
    return;
  }

  log("step: session created, subscribing to events...");
  subscribeToSessionEvents(session);

  // Collect tool names from the session's active tools
  const activeToolNames = session.getActiveToolNames();

  // Emit init event (same shape as bridge.mjs)
  log("step: emitting init event...");
  emit({
    type: "init",
    sessionId: msg.sessionId || "",
    tools: activeToolNames,
    model: `${provider}/${modelId}`,
    permissionMode: currentPermissionMode,
    mcpServers: [{ name: "coppice", status: "connected" }, ...currentMcpStatuses],
    slashCommands: ["compact", "model", "session"],
    isResume: !!opts.resume,
  });

  // Emit slash commands with full details
  emitSlashCommands();

  // Emit available models for the frontend
  try {
    const providers = getProviders();
    const allModels = [];
    for (const p of providers) {
      try {
        const models = getModels(p);
        for (const m of models) {
          allModels.push({
            value: m.id,
            label: m.name,
            provider: p,
            contextWindow: m.contextWindow,
            reasoning: m.reasoning,
          });
        }
      } catch {
        /* provider may not have API key set, skip */
      }
    }
    emit({ type: "pi_models", models: allModels });
  } catch (err) {
    log("Failed to enumerate models:", err.message);
  }

  // Generate a short tab title from the first prompt (fire-and-forget)
  if (!titleGenerated && msg.prompt) {
    titleGenerated = true;
    generateTitle(msg.prompt, provider, modelId);
  }

  // Heartbeat for network stall detection
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => emit({ type: "heartbeat" }), 10_000);

  // Run the prompt — expand .claude/commands/ templates first (Pi SDK
  // only expands .pi/prompts/ internally via session.prompt()).
  let promptText = msg.prompt;
  if (promptText.startsWith("/")) {
    const expanded = await expandClaudeCommand(promptText, currentCwd);
    if (expanded) {
      log(`expanded .claude/ command: /${promptText.split(/\s/)[0].slice(1)}`);
      promptText = expanded;
    }
  }
  log(`prompting model=${provider}/${modelId} tools=${activeToolNames.length} prompt="${promptText.slice(0, 80)}..."`);
  log(`ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}, length: ${(process.env.ANTHROPIC_API_KEY || "").length}`);
  try {
    const images = parseImages(msg.images);
    const promptOpts = images.length > 0 ? { images } : {};
    await session.prompt(promptText, promptOpts);
    log("session.prompt() resolved");
  } catch (err) {
    log("Session error:", err.message, err.stack);
    emit({ type: "error", message: err.message || String(err) });
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }
}

// ── Stdin reader ──

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log("Invalid JSON on stdin:", line);
    return;
  }
  handleCommand(msg).catch((err) => {
    log("Error handling command:", err.message);
    emit({ type: "error", message: err.message });
  });
});

rl.on("close", () => {
  cleanup();
  process.exit(0);
});

// ── Command handler ──

async function handleCommand(msg) {
  switch (msg.type) {
    case "start":
      await startSession(msg);
      break;

    case "input":
      if (!session) break;
      if (session.isStreaming) {
        // Agent is busy — steer (redirect without losing work).
        // AgentSession.steer() handles slash command validation (throws
        // if it's an extension command) and prompt template expansion.
        try {
          const images = parseImages(msg.images);
          await session.steer(msg.text, images.length > 0 ? images : undefined);
        } catch (err) {
          // Extension commands can't be steered — try as follow-up
          log("steer failed, trying followUp:", err.message);
          try {
            const images = parseImages(msg.images);
            await session.followUp(msg.text, images.length > 0 ? images : undefined);
          } catch (err2) {
            log("followUp also failed:", err2.message);
          }
        }
      } else {
        // Agent is idle — new prompt. Expand .claude/commands/ templates first
        // (Pi SDK only handles .pi/prompts/ templates internally).
        let inputText = msg.text;
        if (inputText.startsWith("/")) {
          const expanded = await expandClaudeCommand(inputText, currentCwd);
          if (expanded) {
            log(`expanded .claude/ command: /${inputText.split(/\s/)[0].slice(1)}`);
            inputText = expanded;
          }
        }
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => emit({ type: "heartbeat" }), 10_000);
        try {
          const promptOpts = {};
          const images = parseImages(msg.images);
          if (images.length > 0) {
            promptOpts.images = images;
          }
          await session.prompt(inputText, promptOpts);
        } catch (err) {
          log("Session prompt error:", err.message);
          emit({ type: "error", message: err.message });
        }
      }
      break;

    case "interrupt":
      if (session) {
        await session.abort().catch(() => {});
        emit({ type: "result", subtype: "interrupted" });
      }
      break;

    case "set_model":
      if (session && msg.model) {
        try {
          // Parse "provider/modelId" format or just modelId
          let newProvider, newModelId;
          if (msg.model.includes("/")) {
            [newProvider, newModelId] = msg.model.split("/", 2);
          } else {
            newProvider = "anthropic";
            newModelId = msg.model;
          }
          const newModel = getModel(newProvider, newModelId);
          await session.setModel(newModel);
          log(`Model switched to ${newProvider}/${newModelId}`);
        } catch (err) {
          log("setModel error:", err.message);
        }
      }
      break;

    case "set_permission_mode":
      currentPermissionMode = msg.mode || "default";
      break;

    case "list_commands":
      emitSlashCommands();
      break;

    case "tool_response": {
      const pending = pendingToolResponses.get(msg.callId);
      if (pending) {
        pendingToolResponses.delete(msg.callId);
        if (msg.behavior === "allow") {
          pending.resolve(undefined); // allow — return undefined from beforeToolCall
        } else {
          pending.resolve({
            block: true,
            reason: msg.message || "User denied this action",
          });
        }
      }
      break;
    }

    case "ask_response": {
      const pending = pendingAskResponses.get(msg.callId);
      if (pending) {
        pendingAskResponses.delete(msg.callId);
        pending.resolve(msg.answers);
      }
      break;
    }

    case "coppice_tool_result": {
      const pending = pendingCoppiceToolCalls.get(msg.callId);
      if (pending) {
        pendingCoppiceToolCalls.delete(msg.callId);
        pending.resolve({
          result: msg.result || "",
          isError: msg.isError || false,
        });
      }
      break;
    }

    case "update_mcp_headers": {
      const updates = msg.servers || {};
      for (const [name, update] of Object.entries(updates)) {
        if (!currentMcpServerEntries[name]) continue;
        // Update stored entry headers
        currentMcpServerEntries[name].headers = {
          ...(currentMcpServerEntries[name].headers || {}),
          ...update.headers,
        };
        // Reconnect this server with updated headers
        const oldClient = mcpClientMap.get(name);
        if (oldClient) {
          try { await oldClient.close(); } catch {}
          mcpConnections = mcpConnections.filter((c) => c.name !== name);
        }
        try {
          const newClient = new McpClient(
            { name: "coppice-pi-agent", version: "0.1.0" },
            { capabilities: {} },
          );
          const transport = buildMcpTransport(name, currentMcpServerEntries[name]);
          await newClient.connect(transport, { timeout: 30_000 });
          mcpClientMap.set(name, newClient);
          mcpConnections.push({ client: newClient, name });
          log(`mcp: reconnected ${name} with refreshed token`);
        } catch (err) {
          log(`mcp: reconnect failed for ${name}: ${err.message}`);
          mcpClientMap.delete(name);
        }
      }
      break;
    }

    case "close":
      cleanup();
      process.exit(0);
      break;

    default:
      log("Unknown command type:", msg.type);
  }
}

/** Parse image attachments from a message into Pi's ImageContent format. */
function parseImages(images) {
  if (!images || !Array.isArray(images)) return [];
  return images
    .filter((img) => img.data && img.mediaType)
    .map((img) => ({
      type: "image",
      data: img.data,
      mimeType: img.mediaType,
    }));
}

// ── Cleanup ──

function cleanup() {
  flushPartialBuffers();
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (sessionUnsubscribe) {
    sessionUnsubscribe();
    sessionUnsubscribe = null;
  }
  if (session) {
    try {
      session.abort().catch(() => {});
      session.dispose();
    } catch {
      /* ignore */
    }
  }
  closeMcpConnections().catch(() => {});
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
