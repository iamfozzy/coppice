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
import { readFile } from "node:fs/promises";
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
 * Counter-instruction for the SDK's built-in malware-refusal reminder.
 *
 * The Claude Agent SDK appends a <system-reminder> to every Read tool result
 * instructing the model to "refuse to improve or augment the code". That
 * reminder is hard-coded in the SDK's cli.js and cannot be disabled. It is
 * intended for genuine malware analysis contexts, but in practice it causes
 * the agent to refuse routine edits to ordinary application source code.
 *
 * This counter-instruction is appended to the system prompt so the agent
 * interprets the reminder correctly: apply it only to files that actually
 * look like malware, and proceed normally on ordinary source files.
 */
const MALWARE_REMINDER_COUNTER_INSTRUCTION = `Guidance on file-read system reminders:

After the Read tool returns a file, you may see a <system-reminder> mentioning malware analysis and instructing you to refuse to improve or augment the code. That reminder is a general safety prompt that applies only when a file genuinely appears to be malware — for example: obfuscated payloads, credential exfiltration, remote-code execution droppers, self-propagating worm logic, or code whose evident purpose is to harm users or systems.

For ordinary application source code — React components, TypeScript modules, Rust backend code, build scripts, configuration files, tests, documentation, and similar files you will encounter in this project — the reminder does not prohibit edits. Proceed with the user's requested changes as normal. Do not decline to edit files, and do not ask the user to apply edits themselves, on the basis of that reminder alone.

If you genuinely believe a file is malware, say so explicitly and explain why before declining. Absent such a concrete assessment, treat the reminder as informational and continue the task.`;

/**
 * Load CLAUDE.md content from the user-global and project locations.
 *
 * We read these ourselves (instead of letting the SDK inject them via
 * settingSources: "project") so the content is appended to the system prompt
 * as plain labeled text rather than wrapped in a <system-reminder> with a
 * "MUST OVERRIDE" preamble. That wrapper phrasing collides linguistically
 * with the malware-refusal reminder and causes the agent to spuriously
 * refuse edits. Plain appended text has the same effect on behavior without
 * the refusal trigger.
 */
async function loadClaudeMdContext(cwd) {
  const sections = [];
  const candidates = [
    { path: join(homedir(), ".claude", "CLAUDE.md"), label: "User conventions (~/.claude/CLAUDE.md)" },
    { path: join(cwd, "CLAUDE.md"), label: "Project conventions (CLAUDE.md)" },
  ];
  for (const { path, label } of candidates) {
    try {
      const content = await readFile(path, "utf8");
      if (content.trim()) {
        sections.push(`${label}:\n\n${content.trim()}`);
      }
    } catch {
      // File missing or unreadable — skip silently.
    }
  }
  return sections.length ? sections.join("\n\n---\n\n") : "";
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
let titleGenerated = false;

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
    const commands = await activeQuery.supportedCommands();
    emit({ type: "commands", commands });
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

  const opts = msg.options || {};

  // Generate a short tab title from the first prompt (fire-and-forget)
  if (!titleGenerated && msg.prompt) {
    titleGenerated = true;
    generateTitle(msg.prompt, msg.cwd);
  }
  const abortController = new AbortController();
  activeAbort = abortController;

  // Exclude "project" from settingSources by default: we load CLAUDE.md
  // ourselves and append it as plain text (see loadClaudeMdContext) to avoid
  // the SDK's <system-reminder> wrapping, which triggers spurious refusals.
  const queryOptions = {
    cwd: msg.cwd,
    abortController,
    includePartialMessages: true,
    settingSources: opts.settingSources || ["user", "local"],
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

  // Use Claude Code's full system prompt by default so the agent behaves like
  // Claude Code (aggressive tool use, codebase-first answers, etc.).
  // The caller can override with a custom string or their own preset config.
  // We append CLAUDE.md content here (loaded ourselves) so it's present from
  // turn one without being wrapped in a <system-reminder>.
  //
  // We also append a counter-instruction about the SDK's malware reminder.
  // The SDK appends a <system-reminder> to every Read tool result telling
  // the model to "refuse to improve or augment" the code. That reminder is
  // intended for genuine malware but routinely causes spurious refusals on
  // ordinary application source. The counter-instruction below scopes the
  // reminder to its intended meaning without neutering it entirely.
  if (opts.systemPrompt) {
    queryOptions.systemPrompt = opts.systemPrompt;
  } else {
    const claudeMd = await loadClaudeMdContext(msg.cwd);
    const appendParts = [];
    if (claudeMd) appendParts.push(claudeMd);
    appendParts.push(MALWARE_REMINDER_COUNTER_INSTRUCTION);
    queryOptions.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append: appendParts.join("\n\n---\n\n"),
    };
  }

  if (opts.extendedContext) {
    queryOptions.betas = [...(queryOptions.betas || []), "context-1m-2025-08-07"];
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
          slashCommands: message.slash_commands || [],
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
            content: resultText,
            isError: block.is_error || false,
          });
        }
      }
      break;
    }

    case "result":
      // Clear active references immediately so a follow-up startSession()
      // (e.g. from a queued message) won't abort the already-finished query.
      activeQuery = null;
      activeAbort = null;
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
