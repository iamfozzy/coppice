/**
 * Coppice Agent Bridge
 *
 * Thin wrapper that drives @anthropic-ai/claude-agent-sdk via a JSON-line
 * protocol over stdin/stdout. One bridge process per agent session.
 *
 * Stdin (Rust → Node): one JSON object per line
 * Stdout (Node → Rust): one JSON object per line
 * Stderr: debug/error logging (forwarded by Rust to app logs)
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers ──

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(...args) {
  process.stderr.write("[bridge] " + args.join(" ") + "\n");
}

/**
 * Trim large tool result text for frontend display/storage.
 *
 * The SDK still sees the full output for its own context window management;
 * this only trims what we send to the UI and persist in the DB.
 *
 * Strategy: keep the first and last N lines, insert a "[trimmed]" marker.
 */
const TOOL_RESULT_MAX_LINES = 200;
const TOOL_RESULT_KEEP_LINES = 80; // lines to keep from head and tail

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



/**
 * Concise mode instruction — appended to system prompt when the user enables
 * "Concise" mode in the UI. Reduces output token usage by eliminating
 * conversational filler and explanatory prose.
 */
const CONCISE_MODE_INSTRUCTION = `CONCISE MODE: no preamble, no filler, no restating plans or summaries. Execute multi-step tasks silently; report only final outcome. Sentence fragments ok. Errors: state failure + fix only. No apologies, hedges, unrequested alternatives, or explanatory code comments.`;

/**
 * Always-on guidance to keep tool outputs small — tool results stay in the
 * context window for every subsequent turn, so verbose commands compound in
 * cost. Prefer narrow searches (Grep with path/glob filters), bounded reads
 * (Read with offset/limit), and piped pagination (| head -N) over dumping
 * whole files or running wide recursive greps.
 */
const TOOL_FRUGALITY_INSTRUCTION = `Keep tool outputs small: they persist in context for every later turn. Prefer Grep with path/glob filters over wide searches; read files with offset/limit when you know the region; pipe noisy commands through head/tail. Don't cat whole large files or directories to browse — target what you need.`;

const NO_ATTRIBUTION_INSTRUCTION = `IMPORTANT: Do NOT add any Co-Authored-By lines, attribution trailers, or similar attribution metadata to git commit messages. The user has disabled git attribution in their settings.`;

/**
 * Load the user's ~/.claude/settings.json and check whether git attribution
 * is disabled. The SDK's `settingSources: ["user"]` reads this file for
 * permissions and allowed tools, but the `claude_code` preset system prompt
 * still contains instructions to add Co-Authored-By lines. We read the file
 * ourselves so we can append a countermanding instruction when the user has
 * opted out.
 */
async function loadUserClaudeSettings() {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    const raw = await readFile(settingsPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isAttributionDisabled(settings) {
  if (!settings) return false;
  if (settings.includeCoAuthoredBy === false) return true;
  if (settings.gitAttribution === false) return true;
  return false;
}

/** Returns true if the given model value supports the 1M context beta. */
function modelSupports1M(model) {
  if (!model) return false;
  const m = String(model).toLowerCase();
  if (m.includes("haiku")) return false;
  return (
    m.includes("opus-4-6") ||
    m.includes("opus-4-7") ||
    m.includes("sonnet-4-6") ||
    m.includes("opus-4") ||
    m.includes("sonnet-4")
  );
}


/**
 * Load project-level slash commands from .claude/commands/ directories.
 *
 * Scans both the user-global (~/.claude/commands/) and the project-local
 * (.claude/commands/) directories for *.md files. Each file becomes a slash
 * command where the filename (minus extension) is the command name and the
 * first non-empty line of content is used as the description.
 *
 * We load these ourselves so that slash commands work regardless of
 * how settingSources is configured.
 */
async function loadProjectCommands(cwd) {
  const commands = [];
  const seen = new Set();

  // Scan .claude/commands/ for flat *.md files
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
      const name = entry.name.slice(0, -3); // strip .md
      if (seen.has(name)) continue;
      try {
        const content = await readFile(join(dir, entry.name), "utf8");
        const firstLine = content.split("\n").find((l) => l.trim()) || "";
        seen.add(name);
        commands.push({
          name,
          description: firstLine.trim(),
          argumentHint: "$ARGUMENTS",
        });
      } catch {
        // Unreadable file — skip silently
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
        commands.push({
          name,
          description: firstLine.trim(),
          argumentHint: "$ARGUMENTS",
        });
      } catch {
        // SKILL.md missing or unreadable — skip
      }
    }
  }

  return commands;
}

/**
 * Expand a project slash command into its markdown content.
 *
 * If `prompt` starts with "/<name>" and a matching .claude/commands/<name>.md
 * file exists (project-local first, then user-global), returns the file content
 * with $ARGUMENTS replaced by any trailing arguments. Returns null if no match.
 */
async function expandProjectCommand(prompt, cwd) {
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

// ── Pending callback maps ──
// canUseTool and AskUserQuestion block until the frontend responds.
// Each pending callback stores { resolve } keyed by callId.

const pendingToolResponses = new Map();
const pendingAskResponses = new Map();
let callIdCounter = 0;

function nextCallId() {
  return String(++callIdCounter);
}

/**
 * Build an Anthropic content block array from text + optional images.
 * Returns an array of content blocks (image blocks first, then text).
 */
function buildContentBlocks(text, images) {
  const blocks = [];
  if (images && Array.isArray(images)) {
    for (const img of images) {
      if (img.data && img.mediaType) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mediaType,
            data: img.data,
          },
        });
      }
    }
  }
  if (text) {
    blocks.push({ type: "text", text });
  }
  return blocks;
}

/**
 * Check whether a message carries image attachments.
 */
function hasImages(msg) {
  return msg.images && Array.isArray(msg.images) && msg.images.length > 0;
}

// ── State ──

let activeQuery = null;
let activeAbort = null;
let pendingInterrupt = false;
let hasInitialized = false;
let currentPermissionMode = "default";
let titleGenerated = false;
let currentCwd = process.cwd();

// Track per-turn usage for accurate context window display.
// The SDK's result.usage is the aggregate across ALL API calls in a query,
// not the last call. We need the last call's usage for context display.
let lastTurnUsage = null;

// Track the SDK's running total_cost_usd across queries so we can compute
// per-query deltas. The SDK accumulates total_cost_usd in global state
// (especially on resume), so we must delta to avoid double-counting.
let prevTotalCostUsd = 0;

// Cumulative session totals across every query handled by this bridge
// process. Since one bridge = one session, this is the per-session total.
// Seeded from `start.options.priorCost` on the first start() call so that
// resumed tabs include cost from previous app sessions. The frontend
// receives these absolute totals on every `result` event and just replaces
// its session.cost with them — no client-side accumulation.
let sessionTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalCostUsd: 0,
};
let sessionTotalsSeeded = false;

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
      if (activeQuery) {
        const inputBlocks = hasImages(msg)
          ? buildContentBlocks(msg.text, msg.images)
          : msg.text;
        await activeQuery.streamInput(
          (async function* () {
            yield {
              type: "user",
              message: { role: "user", content: inputBlocks },
            };
          })()
        );
      }
      break;

    case "interrupt":
      if (activeQuery) {
        pendingInterrupt = true;
        await activeQuery.interrupt().catch(() => {});
      }
      break;

    case "set_model":
      if (activeQuery) {
        await activeQuery.setModel(msg.model).catch((err) => {
          log("setModel error:", err.message);
        });
      }
      break;

    case "set_permission_mode":
      currentPermissionMode = msg.mode || "default";
      if (activeQuery) {
        await activeQuery.setPermissionMode(msg.mode).catch((err) => {
          log("setPermissionMode error:", err.message);
        });
      }
      break;

    case "list_commands":
      await emitCommands();
      break;

    case "tool_response": {
      const pending = pendingToolResponses.get(msg.callId);
      if (pending) {
        pendingToolResponses.delete(msg.callId);
        if (msg.behavior === "allow") {
          // The SDK requires `updatedInput` to be the actual tool input, not
          // undefined. Fall back to the original toolInput captured when we
          // prompted — the frontend has no reason to mutate it for a plain
          // Allow click, and a missing value here silently breaks execution.
          pending.resolve({
            behavior: "allow",
            updatedInput: msg.updatedInput ?? pending.toolInput,
          });
        } else {
          pending.resolve({
            behavior: "deny",
            message: msg.message || "User denied this action",
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

    case "close":
      cleanup();
      process.exit(0);
      break;

    default:
      log("Unknown command type:", msg.type);
  }
}

// ── Slash commands ──

async function emitCommands() {
  if (!activeQuery) return;
  try {
    const sdkCommands = await activeQuery.supportedCommands();
    // Merge in project-level commands from .claude/commands/ directories.
    // The SDK also discovers these via settingSources, but we load manually
    // as a fallback. SDK commands take priority (deduped by name).
    const projectCommands = await loadProjectCommands(currentCwd);
    const sdkNames = new Set(sdkCommands.map((c) => c.name));
    const merged = [
      ...sdkCommands,
      ...projectCommands.filter((c) => !sdkNames.has(c.name)),
    ];
    emit({ type: "commands", commands: merged });
  } catch (err) {
    log("supportedCommands error:", err.message);
  }
}

// ── Title generation ──
//
// Uses the SDK's `query()` with a one-shot prompt so we inherit whatever auth
// the main session uses (OAuth/subscription or API key). A direct REST call
// would require `ANTHROPIC_API_KEY`, which subscription users don't have.

async function generateTitle(prompt, cwd) {
  log("Generating title for prompt:", prompt.slice(0, 80));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const titleQuery = query({
      prompt: `Generate a very short tab title (2-5 words) summarizing this task. Respond with ONLY the title, no quotes or punctuation.\n\nTask: ${prompt.slice(0, 500)}`,
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        includePartialMessages: false,
        abortController: abort,
      },
    });

    let title = "";
    for await (const message of titleQuery) {
      if (message.type === "assistant") {
        const content = message.message?.content || [];
        for (const block of content) {
          if (block.type === "text" && block.text) title += block.text;
        }
      }
    }

    title = title.trim().replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "");
    log("Generated title:", title);
    if (title) emit({ type: "title", title });
  } catch (err) {
    log("Title generation failed:", err.message);
  } finally {
    clearTimeout(timer);
  }
}

// ── Start agent session ──

async function startSession(msg) {
  // Abort any existing query before starting a new one
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  activeQuery = null;

  if (msg.cwd) currentCwd = msg.cwd;

  const opts = msg.options || {};

  // Seed cumulative session totals from the frontend's persisted cost on the
  // first start of this bridge process. Resumed tabs carry forward their
  // tokens/USD from before the app restart so the toolbar stays accurate.
  if (!sessionTotalsSeeded) {
    sessionTotalsSeeded = true;
    const prior = opts.priorCost;
    if (prior && typeof prior === "object") {
      sessionTotals = {
        inputTokens: Number(prior.inputTokens) || 0,
        outputTokens: Number(prior.outputTokens) || 0,
        cacheReadTokens: Number(prior.cacheReadTokens) || 0,
        cacheWriteTokens: Number(prior.cacheWriteTokens) || 0,
        totalCostUsd: Number(prior.totalCostUsd) || 0,
      };
    }
  }

  // Generate a short tab title from the first prompt (fire-and-forget)
  if (!titleGenerated && msg.prompt) {
    titleGenerated = true;
    generateTitle(msg.prompt, msg.cwd);
  }
  const abortController = new AbortController();
  activeAbort = abortController;
  pendingInterrupt = false;

  // Include "project" in settingSources so project-level .claude/settings.json
  // (permissions, allowed tools, etc.) and CLAUDE.md files are loaded by the
  // SDK automatically.
  const queryOptions = {
    cwd: msg.cwd,
    abortController,
    includePartialMessages: true,
    settingSources: opts.settingSources || ["user", "project", "local"],
  };

  // When extended context is enabled and the model supports it, append
  // the [1m] suffix to the model ID. The SDK detects this suffix and
  // automatically enables 1M context + the required beta headers.
  // See: https://github.com/lukilabs/craft-agents-oss/issues/443
  if (opts.model) {
    let effectiveModel = opts.model;
    if (opts.extendedContext && modelSupports1M(opts.model) && !/\[1m\]/i.test(opts.model)) {
      effectiveModel = opts.model + "[1m]";
    }
    queryOptions.model = effectiveModel;
  }
  if (opts.effort) queryOptions.effort = opts.effort;
  if (opts.permissionMode) {
    queryOptions.permissionMode = opts.permissionMode;
    currentPermissionMode = opts.permissionMode;
  }
  if (opts.allowedTools) queryOptions.allowedTools = opts.allowedTools;
  if (opts.maxTurns) queryOptions.maxTurns = opts.maxTurns;
  if (opts.maxBudgetUsd) queryOptions.maxBudgetUsd = opts.maxBudgetUsd;
  if (opts.resume) queryOptions.resume = opts.resume;
  console.error(
    `[bridge] query start model=${queryOptions.model || "default"} extendedContext=${!!opts.extendedContext}`,
  );

  // Use Claude Code's full system prompt by default so the agent behaves like
  // Claude Code (aggressive tool use, codebase-first answers, etc.).
  // The caller can override with a custom string or their own preset config.
  // CLAUDE.md content is injected by the SDK via settingSources.
  // Chat mode — disable tools regardless of whether we're starting fresh or
  // resuming. This must be set before the systemPrompt branching below so that
  // resumed chat-mode sessions don't silently pick up the default tool set
  // (~15K tokens of tool definitions).
  if (opts.chatMode) {
    queryOptions.tools = [];
  }

  // Check whether the user has disabled git attribution in ~/.claude/settings.json.
  // The claude_code preset system prompt instructs the model to add Co-Authored-By
  // lines; we append a countermanding instruction when the user has opted out.
  const userClaudeSettings = await loadUserClaudeSettings();
  const noAttribution = isAttributionDisabled(userClaudeSettings);

  // SDK replays the original system prompt from the session, so skip the
  // re-load to avoid redundant token cost.
  if (opts.systemPrompt) {
    queryOptions.systemPrompt = opts.systemPrompt;
  } else if (opts.resume) {
    // Resuming — SDK restores the original system prompt. Nothing to do.
  } else if (opts.chatMode) {
    // Chat mode — minimal system prompt, no tools. Much smaller token footprint
    // than the claude_code preset since we skip tool definitions entirely.
    const parts = [
      "You are a helpful coding assistant. Answer questions clearly and concisely.",
    ];
    if (opts.conciseMode) parts.push(CONCISE_MODE_INSTRUCTION);
    if (noAttribution) parts.push(NO_ATTRIBUTION_INSTRUCTION);
    queryOptions.systemPrompt = parts.join("\n\n---\n\n");
  } else {
    const appendParts = [];
    appendParts.push(TOOL_FRUGALITY_INSTRUCTION);
    if (opts.conciseMode) appendParts.push(CONCISE_MODE_INSTRUCTION);
    if (noAttribution) appendParts.push(NO_ATTRIBUTION_INSTRUCTION);
    queryOptions.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: appendParts.length ? appendParts.join("\n\n---\n\n") : undefined,
    };
  }

  if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
    queryOptions.mcpServers = opts.mcpServers;
  }

  // Permission callback — blocks until frontend responds (unless bypassed)
  queryOptions.canUseTool = async (toolName, toolInput, context) => {
    // Bypass mode — auto-allow everything without prompting
    if (currentPermissionMode === "bypassPermissions") {
      // Still route AskUserQuestion to the frontend for user interaction
      if (toolName === "AskUserQuestion") {
        return handleAskUserTool(toolInput);
      }
      return { behavior: "allow" };
    }

    // AcceptEdits mode — auto-allow file operations, prompt for the rest
    if (currentPermissionMode === "acceptEdits") {
      const autoAllowTools = [
        "Edit", "Write", "Read", "Glob", "Grep",
        "NotebookEdit", "MultiEdit",
      ];
      if (autoAllowTools.includes(toolName)) {
        return { behavior: "allow" };
      }
      if (toolName === "Bash") {
        const cmd = (toolInput.command || "").trim();
        const safePrefixes = /^(ls|cat|head|tail|wc|find|echo|pwd|mkdir|touch|cp|mv)\b/;
        if (safePrefixes.test(cmd)) {
          return { behavior: "allow" };
        }
      }
    }

    // AskUserQuestion always routes to the frontend
    if (toolName === "AskUserQuestion") {
      return handleAskUserTool(toolInput);
    }

    // Regular tool permission request — prompt the frontend
    const callId = nextCallId();
    emit({
      type: "tool_permission",
      callId,
      toolName,
      toolInput,
    });

    return new Promise((resolve) => {
      pendingToolResponses.set(callId, { resolve, toolInput });
      // Timeout after 2 minutes — auto-deny
      setTimeout(() => {
        if (pendingToolResponses.has(callId)) {
          pendingToolResponses.delete(callId);
          resolve({
            behavior: "deny",
            message: "Permission request timed out",
          });
        }
      }, 120_000);
    });
  };

  /** Route AskUserQuestion to the frontend and wait for answers. */
  async function handleAskUserTool(toolInput) {
    const callId = nextCallId();
    emit({
      type: "ask_user",
      callId,
      questions: toolInput.questions || [],
    });

    const answers = await new Promise((resolve) => {
      pendingAskResponses.set(callId, { resolve });
      setTimeout(() => {
        if (pendingAskResponses.has(callId)) {
          pendingAskResponses.delete(callId);
          resolve({});
        }
      }, 300_000);
    });

    return {
      behavior: "allow",
      updatedInput: {
        questions: toolInput.questions,
        answers,
      },
    };
  }

  // Hooks — emit status on Stop/Notification
  queryOptions.hooks = {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            // Required for canUseTool to work in streaming mode
            return { continue: true };
          },
        ],
      },
    ],
  };

  // Environment — pass API key and base URL if provided
  if (opts.apiKey || opts.baseUrl) {
    queryOptions.env = {
      ...(queryOptions.env || {}),
    };
    if (opts.apiKey) {
      queryOptions.env.ANTHROPIC_API_KEY = opts.apiKey;
    }
    if (opts.baseUrl) {
      queryOptions.env.ANTHROPIC_BASE_URL = opts.baseUrl;
    }
  }

  // Token-saving env overrides — these control SDK internals.
  //
  // ANTHROPIC_SMALL_FAST_MODEL: override the "small fast" model that the SDK
  // uses for lightweight tool calls (default: Haiku). Set to the same model
  // as the primary to disable Haiku switching entirely.
  //
  // CLAUDE_CODE_SUBAGENT_MODEL: override the model used by the Task (subagent)
  // tool. Default: "sonnet". Set to "haiku" for cheaper subagents, or
  // "inherit" to use the parent conversation's model.
  //
  // BASH_MAX_OUTPUT_LENGTH: cap how many characters of Bash tool output the
  // SDK keeps in context (default: 30000). Lower values shrink context growth
  // from verbose commands. Range: 1–150000.
  //
  // TASK_MAX_OUTPUT_LENGTH: same as above but for Task (subagent) tool output
  // that flows back into the parent context. Default: 30000.
  // Base URL override — also set on process.env so that internal SDK calls
  // (e.g. title generation) route through the proxy too.
  if (opts.baseUrl) {
    process.env.ANTHROPIC_BASE_URL = opts.baseUrl;
  }
  if (opts.smallFastModel) {
    process.env.ANTHROPIC_SMALL_FAST_MODEL = opts.smallFastModel;
  }
  if (opts.subagentModel) {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = opts.subagentModel;
  }
  if (opts.bashMaxOutputLength) {
    process.env.BASH_MAX_OUTPUT_LENGTH = String(opts.bashMaxOutputLength);
  }
  if (opts.taskMaxOutputLength) {
    process.env.TASK_MAX_OUTPUT_LENGTH = String(opts.taskMaxOutputLength);
  }

  try {
    // Expand project slash commands: if the prompt starts with "/<name>" and
    // a matching .claude/commands/<name>.md file exists, replace the prompt
    // with its content ($ARGUMENTS substituted).
    let effectivePrompt = msg.prompt;
    const expanded = await expandProjectCommand(msg.prompt, currentCwd);
    if (expanded !== null) {
      effectivePrompt = expanded;
    }

    // When images are attached, we must use the AsyncIterable<SDKUserMessage>
    // form of `prompt` because the SDK's query() only accepts `string` or
    // `AsyncIterable` — not content block arrays.  A plain string prompt is
    // wrapped by the SDK internally; an iterable lets us provide image blocks.
    let promptArg;
    if (hasImages(msg)) {
      const contentBlocks = buildContentBlocks(effectivePrompt, msg.images);
      promptArg = (async function* () {
        yield {
          type: "user",
          session_id: "",
          message: { role: "user", content: contentBlocks },
          parent_tool_use_id: null,
        };
      })();
    } else {
      promptArg = effectivePrompt;
    }

    const result = query({
      prompt: promptArg,
      options: queryOptions,
    });
    activeQuery = result;

    for await (const message of result) {
      processMessage(message);
    }
  } catch (err) {
    if (pendingInterrupt) {
      emit({ type: "result", subtype: "interrupted" });
    } else {
      emit({ type: "error", message: err.message || String(err) });
    }
  } finally {
    activeQuery = null;
    activeAbort = null;
    pendingInterrupt = false;
  }
}

// ── Message processing ──

function processMessage(message) {
  switch (message.type) {
    case "system":
      if (message.subtype === "init") {
        const isFirst = !hasInitialized;
        hasInitialized = true;
        emit({
          type: "init",
          sessionId: message.session_id,
          tools: message.tools || [],
          model: message.model || "",
          permissionMode: message.permissionMode || "",
          mcpServers: message.mcp_servers || [],
          slashCommands: [
            ...(message.slash_commands || []),
            ...(message.skills || []),
          ],
          isResume: !isFirst,
        });
        // Fetch the richer command list (name, description, argumentHint) —
        // supportedCommands() resolves after initialization.
        emitCommands();
      } else if (message.subtype === "status") {
        // SDK status updates (e.g. "compacting")
        if (message.status) {
          emit({ type: "status", status: message.status });
        }
      } else if (message.subtype === "compact_boundary") {
        // SDK compacted the conversation — surface in the UI
        emit({
          type: "compact_boundary",
          preTokens: message.compact_metadata?.pre_tokens,
          trigger: message.compact_metadata?.trigger,
        });
      }
      break;

    case "assistant": {
      const content = message.message?.content || [];
      const blocks = [];
      for (const block of content) {
        if (block.type === "text") {
          blocks.push({ type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input,
          });
          emit({ type: "status", status: "tool_use" });
        } else if (block.type === "thinking") {
          blocks.push({ type: "thinking", text: block.thinking });
        }
      }
      emit({
        type: "assistant",
        uuid: message.uuid,
        content: blocks,
      });

      // Emit per-turn usage so the UI can show the current context size.
      // Also save it — result.usage is the aggregate across ALL API calls
      // in the query, so we need this per-call snapshot for accurate
      // context window display.
      const usage = message.message?.usage;
      if (usage) {
        lastTurnUsage = {
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
        };
        const total = lastTurnUsage.inputTokens + lastTurnUsage.cacheReadTokens + lastTurnUsage.cacheWriteTokens;
        console.error(
          `[bridge] turn usage: fresh=${lastTurnUsage.inputTokens} CR=${lastTurnUsage.cacheReadTokens} CW=${lastTurnUsage.cacheWriteTokens} out=${lastTurnUsage.outputTokens} total_in=${total}`,
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

    case "user": {
      // Slash command output is emitted as a user message with content wrapped
      // in <local-command-stdout>/<local-command-stderr> tags and isReplay:true.
      // Pass those through as `slash_output` so the UI can render them; the
      // regular "skip replay" filter would otherwise drop the result entirely.
      const rawContent = message.message?.content;
      if (typeof rawContent === "string") {
        const stdoutMatch = rawContent.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
        const stderrMatch = rawContent.match(/<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/);
        if (stdoutMatch || stderrMatch) {
          emit({
            type: "slash_output",
            stdout: stdoutMatch ? stdoutMatch[1].trim() : "",
            stderr: stderrMatch ? stderrMatch[1].trim() : "",
          });
          break;
        }
      }

      // Skip replay messages to prevent duplicates
      if (message.isReplay) break;

      // Tool results come back as user messages
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === "tool_result") {
          const resultText =
            typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n")
                : "";
          emit({
            type: "tool_result",
            toolUseId: block.tool_use_id,
            content: trimToolResult(resultText),
            isError: block.is_error || false,
          });
        }
      }
      break;
    }

    case "result": {
      // Clear active references immediately so a follow-up startSession()
      // (e.g. from a queued message) won't abort the already-finished query.
      activeQuery = null;
      activeAbort = null;

      // ── Per-query cost via result.usage ──
      // result.usage is a local accumulator (K1 in SDK source) that starts
      // at zero for each query() invocation and sums every API call's usage.
      // This is the true per-query aggregate. We use it instead of
      // modelUsage (from the global STATE.modelUsage) which accumulates
      // across queries — especially on resume — causing double-counting
      // when the frontend adds it to the pre-query snapshot.
      const resultUsage = message.usage || {};
      const queryCost = {
        inputTokens: resultUsage.input_tokens || 0,
        outputTokens: resultUsage.output_tokens || 0,
        cacheReadTokens: resultUsage.cache_read_input_tokens || 0,
        cacheWriteTokens: resultUsage.cache_creation_input_tokens || 0,
      };

      // total_cost_usd from the SDK is a running total in global state.
      // Compute the delta for this query to avoid double-counting.
      const currentTotalCostUsd = message.total_cost_usd || 0;
      const queryCostUsd = Math.max(0, currentTotalCostUsd - prevTotalCostUsd);
      prevTotalCostUsd = currentTotalCostUsd;

      // Accumulate per-query usage into the bridge-side session totals.
      // The frontend treats `cost` on a result event as the absolute
      // session total, so it just replaces session.cost with this value.
      sessionTotals.inputTokens += queryCost.inputTokens;
      sessionTotals.outputTokens += queryCost.outputTokens;
      sessionTotals.cacheReadTokens += queryCost.cacheReadTokens;
      sessionTotals.cacheWriteTokens += queryCost.cacheWriteTokens;
      sessionTotals.totalCostUsd += queryCostUsd;

      // ── Context window from SDK modelUsage ──
      // modelUsage entries include a contextWindow field that reflects
      // the model's actual context window (200K, 1M, etc.). Forward it
      // so the frontend doesn't have to guess from the model name.
      const modelUsage = message.modelUsage || {};
      let contextWindow = 0;
      for (const mu of Object.values(modelUsage)) {
        if (mu.contextWindow > contextWindow) contextWindow = mu.contextWindow;
      }

      emit({
        type: "result",
        subtype: message.subtype,
        sessionId: message.session_id,
        cost: { ...sessionTotals },
        // Use the last per-turn usage we tracked (from the final assistant
        // message). This represents what the model held in its context
        // window for the last API call — the correct value for the context
        // percentage display. Falls back to the per-query aggregate only
        // if no turn_cost was emitted (shouldn't normally happen).
        lastTurnCost: {
          totalCostUsd: 0,
          ...(lastTurnUsage ?? queryCost),
        },
        contextWindow: contextWindow || 0,
        durationMs: message.duration_ms || 0,
        numTurns: message.num_turns || 0,
      });

      // Reset per-query tracking for the next query.
      lastTurnUsage = null;
      break;
    }

    case "stream_event": {
      // SDKPartialAssistantMessage — raw streaming events
      const evt = message.event;
      if (!evt) break;
      if (evt.type === "content_block_start") {
        emit({ type: "status", status: "thinking" });
      } else if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "text_delta") {
          emit({
            type: "partial",
            delta: { type: "text", text: evt.delta.text },
          });
        } else if (evt.delta?.type === "thinking_delta") {
          emit({
            type: "partial",
            delta: { type: "thinking", text: evt.delta.thinking },
          });
        }
      }
      break;
    }

    case "tool_progress": {
      emit({
        type: "tool_progress",
        toolUseId: message.tool_use_id,
        toolName: message.tool_name,
        elapsed: message.elapsed_time_seconds || 0,
      });
      break;
    }

    default:
      break;
  }
}

// ── Cleanup ──

function cleanup() {
  if (activeQuery) {
    try {
      activeQuery.close();
    } catch {
      // Ignore cleanup errors
    }
    activeQuery = null;
  }
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  // Resolve any pending callbacks so they don't hang
  for (const [, pending] of pendingToolResponses) {
    pending.resolve({
      behavior: "deny",
      message: "Bridge shutting down",
    });
  }
  pendingToolResponses.clear();
  for (const [, pending] of pendingAskResponses) {
    pending.resolve({});
  }
  pendingAskResponses.clear();
}

// Handle uncaught errors gracefully
process.on("uncaughtException", (err) => {
  emit({ type: "error", message: `Uncaught: ${err.message}` });
  log("Uncaught exception:", err.stack || err.message);
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  emit({ type: "error", message: `Unhandled rejection: ${msg}` });
  log("Unhandled rejection:", msg);
});

emit({ type: "status", status: "ready" });
