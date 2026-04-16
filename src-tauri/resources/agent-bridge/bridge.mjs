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

// ── Helpers ──

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function log(...args) {
  process.stderr.write("[bridge] " + args.join(" ") + "\n");
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

// ── State ──

let activeQuery = null;
let activeAbort = null;
let hasInitialized = false;
let currentPermissionMode = "default";

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
        await activeQuery.streamInput(
          (async function* () {
            yield {
              type: "user",
              message: { role: "user", content: msg.text },
            };
          })()
        );
      }
      break;

    case "interrupt":
      if (activeQuery) {
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

    case "tool_response": {
      const pending = pendingToolResponses.get(msg.callId);
      if (pending) {
        pendingToolResponses.delete(msg.callId);
        if (msg.behavior === "allow") {
          pending.resolve({
            behavior: "allow",
            updatedInput: msg.updatedInput,
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

// ── Start agent session ──

async function startSession(msg) {
  // Abort any existing query before starting a new one
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  activeQuery = null;

  const opts = msg.options || {};
  const abortController = new AbortController();
  activeAbort = abortController;

  const queryOptions = {
    cwd: msg.cwd,
    abortController,
    includePartialMessages: true,
    settingSources: opts.settingSources || ["user", "project", "local"],
  };

  if (opts.model) queryOptions.model = opts.model;
  if (opts.effort) queryOptions.effort = opts.effort;
  if (opts.permissionMode) {
    queryOptions.permissionMode = opts.permissionMode;
    currentPermissionMode = opts.permissionMode;
  }
  if (opts.allowedTools) queryOptions.allowedTools = opts.allowedTools;
  if (opts.maxTurns) queryOptions.maxTurns = opts.maxTurns;
  if (opts.maxBudgetUsd) queryOptions.maxBudgetUsd = opts.maxBudgetUsd;
  if (opts.resume) queryOptions.resume = opts.resume;
  if (opts.systemPrompt) queryOptions.systemPrompt = opts.systemPrompt;
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
      pendingToolResponses.set(callId, { resolve });
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

  // Environment — pass API key if provided
  if (opts.apiKey) {
    queryOptions.env = {
      ...(queryOptions.env || {}),
      ANTHROPIC_API_KEY: opts.apiKey,
    };
  }

  try {
    const result = query({
      prompt: msg.prompt,
      options: queryOptions,
    });
    activeQuery = result;

    for await (const message of result) {
      processMessage(message);
    }
  } catch (err) {
    emit({ type: "error", message: err.message || String(err) });
  } finally {
    activeQuery = null;
    activeAbort = null;
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
          isResume: !isFirst,
        });
      } else if (message.subtype === "status") {
        // SDK status updates (e.g. "compacting")
        if (message.status) {
          emit({ type: "status", status: message.status });
        }
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
      break;
    }

    case "user": {
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
            content: resultText,
            isError: block.is_error || false,
          });
        }
      }
      break;
    }

    case "result":
      emit({
        type: "result",
        subtype: message.subtype,
        sessionId: message.session_id,
        cost: {
          totalCostUsd: message.total_cost_usd || 0,
          inputTokens: message.usage?.input_tokens || 0,
          outputTokens: message.usage?.output_tokens || 0,
          cacheReadTokens: message.usage?.cache_read_input_tokens || 0,
          cacheWriteTokens: message.usage?.cache_creation_input_tokens || 0,
        },
        durationMs: message.duration_ms || 0,
        numTurns: message.num_turns || 0,
      });
      break;

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
