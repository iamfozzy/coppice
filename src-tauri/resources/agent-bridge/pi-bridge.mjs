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

import { getModel, getProviders, getModels } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
      name: "coppice_notify_user",
      label: "Notify User",
      description:
        "Show a system notification to the user via the Coppice IDE. Use for important events like task completion or errors that need attention.",
      promptSnippet: "Show a system notification to the user",
      promptGuidelines: [
        "Use coppice_notify_user for important events (task completion, errors needing attention) instead of just printing a message.",
      ],
      parameters: Type.Object({
        message: Type.String({ description: "Notification body text" }),
        title: Type.Optional(
          Type.String({
            description: "Notification title (defaults to 'Coppice')",
          }),
        ),
      }),
      execute: coppiceExecute("notify_user"),
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
    "coppice_notify_user",
    "coppice_open_url",
  ];
  if (readOnlyTools.includes(toolName)) return undefined;

  // Pi's read-only tools — always allow
  const piReadOnly = ["read", "grep", "find", "ls"];
  if (piReadOnly.includes(toolName)) return undefined;

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

// ── Event subscription ──

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
    log(`event: ${event.type}${event.type === "message_update" ? "" : " " + JSON.stringify(event).slice(0, 120)}`);
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
          emit({ type: "partial", delta: { type: "text", text: aEvent.delta } });
        } else if (aEvent.type === "thinking_delta") {
          emit({
            type: "partial",
            delta: { type: "thinking", text: aEvent.delta },
          });
        } else if (aEvent.type === "text_start" || aEvent.type === "thinking_start") {
          emit({ type: "status", status: "thinking" });
        }
        break;
      }

      case "message_end": {
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
          lastTurnUsage = {
            inputTokens: usage.input || 0,
            outputTokens: usage.output || 0,
            cacheReadTokens: usage.cacheRead || 0,
            cacheWriteTokens: usage.cacheWrite || 0,
          };
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
        // Find the last assistant message for usage/cost
        const lastAssistant = [...(event.messages || [])]
          .reverse()
          .find((m) => m.role === "assistant");
        const usage = lastAssistant?.usage;

        if (usage) {
          const queryCost = {
            inputTokens: usage.input || 0,
            outputTokens: usage.output || 0,
            cacheReadTokens: usage.cacheRead || 0,
            cacheWriteTokens: usage.cacheWrite || 0,
          };
          const queryCostUsd = usage.cost?.total || 0;

          sessionTotals.inputTokens += queryCost.inputTokens;
          sessionTotals.outputTokens += queryCost.outputTokens;
          sessionTotals.cacheReadTokens += queryCost.cacheReadTokens;
          sessionTotals.cacheWriteTokens += queryCost.cacheWriteTokens;
          sessionTotals.totalCostUsd += queryCostUsd;
        }

        // Context window from model metadata
        const currentModel = agentSession.model;
        const contextWindow = currentModel?.contextWindow || 0;

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

  // Build custom tools (Coppice IDE tools + web access)
  log("step: building custom tools...");
  const coppiceTools = buildCoppiceToolDefinitions();
  let customTools = [...coppiceTools];

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
    mcpServers: [],
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
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
