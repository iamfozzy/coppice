/**
 * Coppice Pi Agent Bridge
 *
 * Drives @earendil-works/pi-agent-core + pi-ai + pi-coding-agent via the
 * same JSON-line stdin/stdout protocol as bridge.mjs. One process per
 * agent session.
 *
 * Stdin (Rust → Node): one JSON object per line
 * Stdout (Node → Rust): one JSON object per line
 * Stderr: debug/error logging (forwarded by Rust to app logs)
 *
 * Uses Pi's SDK libraries directly (not the RPC mode) so that Coppice
 * retains full control over events, permissions, and session state.
 */

import { Agent } from "@earendil-works/pi-agent-core";
import { getModel, getProviders, getModels } from "@earendil-works/pi-ai";
import {
  createCodingTools,
  createReadOnlyTools,
  AuthStorage,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createInterface } from "readline";
import { readFile, readdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { constants as fsConstants } from "node:fs";

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
  // Pi native thinking level takes priority
  if (opts.thinkingLevel && PI_THINKING_LEVELS.includes(opts.thinkingLevel)) {
    return opts.thinkingLevel;
  }
  // Map Coppice effort → Pi thinking
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

const CONCISE_MODE_INSTRUCTION = `CONCISE MODE: no preamble, no filler, no restating plans or summaries. Execute multi-step tasks silently; report only final outcome. Sentence fragments ok. Errors: state failure + fix only. No apologies, hedges, unrequested alternatives, or explanatory code comments.`;

const TOOL_FRUGALITY_INSTRUCTION = `Keep tool outputs small: they persist in context for every later turn. Prefer grep with path filters over wide searches; read files with offset/limit when you know the region; pipe noisy commands through head/tail. Don't cat whole large files or directories to browse — target what you need.`;

const COPPICE_TOOLS_INSTRUCTION = `You are running inside the Coppice desktop IDE. You have access to Coppice-specific tools (prefixed "coppice_") that interact directly with the IDE:
- Use coppice_create_worktree instead of git worktree commands — it registers the worktree in the IDE's project model and copies env files. When you need to do work in the new worktree, pass the task as the 'prompt' parameter — Coppice will switch to the new worktree and spawn a separate agent tab to execute it. NEVER cd into the new worktree yourself after creating it.
- Use coppice_spawn_terminal to open new terminal tabs in the IDE, optionally running a command.
- Use coppice_open_file to surface files in the IDE's editor tabs so the user can see them.
- Use coppice_notify_user for important events (task completion, errors needing attention) instead of just printing a message.
- Use coppice_open_url for links the user should visit (PR URLs, documentation).
- Use coppice_open_scratchpad to create a scratchpad with notes, plans, or generated content.
Don't use these for routine intermediate steps — only when IDE integration genuinely helps.`;

// ── System prompt builder ──

/**
 * Build the Coppice system prompt. Pi's buildSystemPrompt() is not
 * exported from the package, so we construct our own tailored version.
 * This is intentionally model-agnostic — it works with any provider.
 */
function buildCoppiceSystemPrompt({ cwd, tools, contextFiles, conciseMode, chatMode }) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const promptCwd = cwd.replace(/\\/g, "/");

  if (chatMode) {
    const parts = [
      "You are a helpful coding assistant. Answer questions clearly and concisely.",
    ];
    if (conciseMode) parts.push(CONCISE_MODE_INSTRUCTION);
    parts.push(`\nCurrent date: ${date}`);
    parts.push(`Current working directory: ${promptCwd}`);
    return parts.join("\n\n");
  }

  // Tool list with short descriptions
  const toolsList = tools
    .map((t) => `- ${t.name}: ${(t.promptSnippet || t.description || "").slice(0, 100)}`)
    .join("\n");

  // Guidelines
  const guidelines = [
    "Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)",
    "Be concise in your responses",
    "Show file paths clearly when working with files",
  ];

  let prompt = `You are an expert coding assistant operating inside Coppice, a desktop IDE for Git worktrees and dev workflows. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines.map((g) => `- ${g}`).join("\n")}`;

  // Coppice-specific instructions
  prompt += "\n\n---\n\n" + TOOL_FRUGALITY_INSTRUCTION;
  prompt += "\n\n---\n\n" + COPPICE_TOOLS_INSTRUCTION;
  if (conciseMode) {
    prompt += "\n\n---\n\n" + CONCISE_MODE_INSTRUCTION;
  }

  // Project context files
  if (contextFiles && contextFiles.length > 0) {
    prompt += "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `## ${filePath}\n\n${content}\n\n`;
    }
  }

  prompt += `\nCurrent date: ${date}`;
  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;
}

// ── Coppice IDE tools (TypeBox schemas) ──

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

/** Build the 7 Coppice IDE tools as Pi AgentTool definitions. */
function buildCoppiceTools() {
  return [
    {
      name: "coppice_create_worktree",
      label: "Create Worktree",
      description:
        "Create a new git worktree in the Coppice IDE. Registers it in the project model and copies env files. Provide an existing branch name to check out, OR set new_branch + base_branch to create a new branch. When you have a task to perform in the new worktree, pass it as 'prompt' — Coppice will switch to the new worktree and spawn a new agent tab with that task. Do NOT cd into the worktree yourself after creating it.",
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
      async execute(_toolCallId, params) {
        const result = await callCoppice("create_worktree", params);
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
    {
      name: "coppice_list_worktrees",
      label: "List Worktrees",
      description:
        "List all worktrees registered in the current Coppice project.",
      parameters: Type.Object({}),
      async execute() {
        const result = await callCoppice("list_worktrees", {});
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
    {
      name: "coppice_spawn_terminal",
      label: "Spawn Terminal",
      description:
        "Open a new terminal tab in the Coppice IDE, optionally running a command in it.",
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
      async execute(_toolCallId, params) {
        const result = await callCoppice("spawn_terminal", params);
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
    {
      name: "coppice_open_file",
      label: "Open File",
      description:
        "Open a file in the Coppice IDE's editor/diff tab so the user can see it.",
      parameters: Type.Object({
        path: Type.String({
          description:
            "Absolute path or path relative to the worktree root",
        }),
      }),
      async execute(_toolCallId, params) {
        const result = await callCoppice("open_file", params);
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
    {
      name: "coppice_open_scratchpad",
      label: "Open Scratchpad",
      description:
        "Create a new agent tab in the Coppice scratchpad with pre-filled content. Useful for plans, notes, or generated content.",
      parameters: Type.Object({
        content: Type.String({
          description: "Content to pre-fill as the initial prompt",
        }),
        title: Type.Optional(
          Type.String({ description: "Label for the scratchpad tab" }),
        ),
      }),
      async execute(_toolCallId, params) {
        const result = await callCoppice("open_scratchpad", params);
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
    {
      name: "coppice_notify_user",
      label: "Notify User",
      description:
        "Show a system notification to the user via the Coppice IDE. Use for important events like task completion or errors that need attention.",
      parameters: Type.Object({
        message: Type.String({ description: "Notification body text" }),
        title: Type.Optional(
          Type.String({
            description: "Notification title (defaults to 'Coppice')",
          }),
        ),
      }),
      async execute(_toolCallId, params) {
        const result = await callCoppice("notify_user", params);
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
    {
      name: "coppice_open_url",
      label: "Open URL",
      description:
        "Open a URL in the user's system browser. Use for PR links, documentation, or other web pages the user should see.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL to open" }),
      }),
      async execute(_toolCallId, params) {
        const result = await callCoppice("open_url", params);
        return {
          content: [
            { type: "text", text: result.result || JSON.stringify(result) },
          ],
          details: {},
        };
      },
    },
  ];
}

// ── Context file loading ──

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
 * Load project context files (CLAUDE.md, AGENTS.md) for the system prompt.
 * Returns array of { path, content } suitable for buildSystemPrompt().
 */
async function loadContextFiles(cwd) {
  const candidates = [
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/CLAUDE.md",
    ".pi/AGENTS.md",
  ];
  const files = [];
  for (const name of candidates) {
    const fullPath = join(cwd, name);
    if (await fileExists(fullPath)) {
      try {
        const content = await readFile(fullPath, "utf-8");
        files.push({ path: name, content });
      } catch {
        /* skip unreadable files */
      }
    }
  }
  return files;
}

// ── Web access tool loading ──

/**
 * Load pi-web-access tools by importing the package and intercepting
 * its registerTool() calls. Returns AgentTool[] on success, [] on failure.
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
    //
    // jiti aliases need package directory paths. These ESM-only packages
    // have strict exports that block require.resolve(), so we resolve
    // from the top-level node_modules directory.
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
    return tools;
  } catch (err) {
    log("pi-web-access not available:", err.message);
    return [];
  }
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

// ── Agent state ──

let agent = null;
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
 * Subscribe to Agent events and emit them in Coppice's event format.
 * This maps Pi's AgentEvent types to the same JSON events that
 * bridge.mjs emits, so the frontend needs no changes.
 */
function subscribeToEvents(agentInstance) {
  agentInstance.subscribe((event) => {
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

        // Surface API errors (auth failures, rate limits, etc.)
        if (msg.stopReason === "error" || msg.stopReason === "aborted") {
          const errMsg = msg.errorMessage || `Request failed: ${msg.stopReason}`;
          log(`API error: ${errMsg}`);
          emit({ type: "error", message: errMsg });
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
        const model = agentInstance.state?.model;
        const contextWindow = model?.contextWindow || 0;

        emit({
          type: "result",
          subtype: "success",
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

      default:
        break;
    }
  });
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

  // Build tools
  log("step: creating coding tools...");
  const codingTools = createCodingTools(currentCwd);
  log(`step: coding tools OK (${codingTools.length})`);
  const readOnlyExtras = createReadOnlyTools(currentCwd);
  log(`step: read-only tools OK (${readOnlyExtras.length})`);
  const coppiceTools = buildCoppiceTools();
  log(`step: coppice tools OK (${coppiceTools.length})`);

  // Merge coding + read-only extras (avoid duplicates by name)
  const codingNames = new Set(codingTools.map((t) => t.name));
  const extras = readOnlyExtras.filter((t) => !codingNames.has(t.name));
  let allTools = [...codingTools, ...extras, ...coppiceTools];

  // Load web access tools if enabled
  if (opts.enableWebAccess !== false) {
    log("step: loading web access tools...");
    const webTools = await loadWebAccessTools();
    log(`step: web access tools done (${webTools.length})`);
    allTools = [...allTools, ...webTools];
  }

  // No tools in chat mode
  if (opts.chatMode) {
    allTools = [];
  }

  // Build system prompt
  log("step: loading context files...");
  const contextFiles = await loadContextFiles(currentCwd);
  log(`step: context files OK (${contextFiles.length})`);
  log("step: building system prompt...");
  const systemPrompt = buildCoppiceSystemPrompt({
    cwd: currentCwd,
    tools: allTools,
    contextFiles,
    conciseMode: opts.conciseMode,
    chatMode: opts.chatMode,
  });

  // Resolve thinking level (accepts both Pi native and Coppice effort levels)
  const thinkingLevel = resolveThinkingLevel(opts);

  // Set API key via env var if provided
  if (opts.apiKey) {
    process.env.ANTHROPIC_API_KEY = opts.apiKey;
  }

  // Set per-provider API keys from Pi settings.
  // Uses the same PROVIDER_ENV_VARS map as getEnvApiKey() so all providers
  // are handled consistently.
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

  // Token-saving env overrides
  if (opts.bashMaxOutputLength) {
    process.env.BASH_MAX_OUTPUT_LENGTH = String(opts.bashMaxOutputLength);
  }
  if (opts.taskMaxOutputLength) {
    process.env.TASK_MAX_OUTPUT_LENGTH = String(opts.taskMaxOutputLength);
  }

  // Initialize auth storage for OAuth credential resolution.
  // Reads ~/.pi/agent/auth.json — the same file created by `pi login`.
  // This lets Coppice use existing Pi OAuth sessions (Anthropic, GitHub
  // Copilot, OpenAI Codex) without requiring a raw API key.
  if (!authStorage) {
    try {
      authStorage = AuthStorage.create();
      const hasAnthropicAuth = !!(await authStorage.getApiKey("anthropic"));
      log(`auth storage: loaded (anthropic=${hasAnthropicAuth})`);
    } catch (err) {
      log(`auth storage: failed to init (${err.message}), falling back to env vars`);
    }
  }

  log(`step: creating agent (tools=${allTools.length} thinking=${thinkingLevel})...`);
  if (!agent) {
    // First start — create the Agent
    agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: allTools,
        thinkingLevel,
      },
      // Dynamic API key resolution: checks env vars first (set from
      // Coppice settings), then falls back to Pi's auth.json OAuth
      // tokens. This enables zero-config auth if the user has done
      // `pi login anthropic` (or any other provider).
      getApiKey: async (providerName) => {
        // OAuth tokens take priority (auto-refresh, subscription-based)
        if (authStorage) {
          try {
            const oauthKey = await authStorage.getApiKey(providerName);
            if (oauthKey) return oauthKey;
          } catch {
            // OAuth refresh failed — fall through to env vars
          }
        }
        // Fall back to env vars (set from Coppice settings API key fields)
        const envKey = getEnvApiKey(providerName);
        if (envKey) return envKey;
        return undefined;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const result = await handlePermission(
          toolCall,
          args,
          currentPermissionMode,
        );
        if (result && result.block) {
          return { block: true, reason: result.reason || "Denied by user" };
        }
        return undefined; // allow
      },
      toolExecution: "parallel",
    });

    log("step: agent created, subscribing to events...");
    subscribeToEvents(agent);
  } else {
    // Subsequent start — update state for new query
    agent.state.systemPrompt = systemPrompt;
    agent.state.model = model;
    agent.state.tools = allTools;
    agent.state.thinkingLevel = thinkingLevel;
  }

  // Emit init event (same shape as bridge.mjs)
  log("step: emitting init event...");
  emit({
    type: "init",
    sessionId: msg.sessionId || "",
    tools: allTools.map((t) => t.name),
    model: `${provider}/${modelId}`,
    permissionMode: currentPermissionMode,
    mcpServers: [],
    slashCommands: [],
    isResume: !!opts.resume,
  });

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

  // Run the prompt
  log(`prompting model=${provider}/${modelId} tools=${allTools.length} prompt="${msg.prompt.slice(0, 80)}..."`);
  log(`ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}, length: ${(process.env.ANTHROPIC_API_KEY || "").length}`);
  try {
    if (msg.images && msg.images.length > 0) {
      const imageBlocks = msg.images
        .filter((img) => img.data && img.mediaType)
        .map((img) => ({
          type: "image",
          data: img.data,
          mimeType: img.mediaType,
        }));
      await agent.prompt(msg.prompt, imageBlocks);
    } else {
      await agent.prompt(msg.prompt);
    }
    log("agent.prompt() resolved");
  } catch (err) {
    log("Agent error:", err.message, err.stack);
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
      if (!agent) break;
      if (agent.state.isStreaming) {
        // Agent is busy — steer (redirect without losing work)
        if (msg.images && msg.images.length > 0) {
          const imageBlocks = msg.images
            .filter((img) => img.data && img.mediaType)
            .map((img) => ({
              type: "image",
              data: img.data,
              mimeType: img.mediaType,
            }));
          agent.steer({
            role: "user",
            content: [
              { type: "text", text: msg.text },
              ...imageBlocks,
            ],
            timestamp: Date.now(),
          });
        } else {
          agent.steer({
            role: "user",
            content: msg.text,
            timestamp: Date.now(),
          });
        }
      } else {
        // Agent is idle — new prompt
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => emit({ type: "heartbeat" }), 10_000);
        try {
          if (msg.images && msg.images.length > 0) {
            const imageBlocks = msg.images
              .filter((img) => img.data && img.mediaType)
              .map((img) => ({
                type: "image",
                data: img.data,
                mimeType: img.mediaType,
              }));
            await agent.prompt(msg.text, imageBlocks);
          } else {
            await agent.prompt(msg.text);
          }
        } catch (err) {
          log("Agent prompt error:", err.message);
          emit({ type: "error", message: err.message });
        }
      }
      break;

    case "interrupt":
      if (agent) {
        agent.abort();
        emit({ type: "result", subtype: "interrupted" });
      }
      break;

    case "set_model":
      if (agent && msg.model) {
        try {
          // Parse "provider/modelId" format or just modelId
          let provider, modelId;
          if (msg.model.includes("/")) {
            [provider, modelId] = msg.model.split("/", 2);
          } else {
            provider = "anthropic";
            modelId = msg.model;
          }
          const newModel = getModel(provider, modelId);
          agent.state.model = newModel;
          log(`Model switched to ${provider}/${modelId}`);
        } catch (err) {
          log("setModel error:", err.message);
        }
      }
      break;

    case "set_permission_mode":
      currentPermissionMode = msg.mode || "default";
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

// ── Cleanup ──

function cleanup() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (agent) {
    agent.abort();
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
