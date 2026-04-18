import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as commands from "../../lib/commands";
import { useAppStore } from "../../stores/appStore";
import type { AgentMessage, AgentSessionState, EffortLevel, ImageAttachment, SlashCommand } from "../../lib/types";
import { AgentToolbar } from "./AgentToolbar";
import { AgentControls } from "./AgentControls";
import { MessageList } from "./MessageList";
import { AgentInputBar } from "./AgentInputBar";
import { PermissionDialog } from "./PermissionDialog";
import { AskUserDialog } from "./AskUserDialog";
import { PlanApprovalDialog, isPlanPermission } from "./PlanApprovalDialog";

interface Props {
  sessionId: string;
  cwd: string;
  initialPrompt?: string;
  visible?: boolean;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${++msgIdCounter}-${Date.now()}`;
}

/** Rough per-million-token pricing by model family for live cost estimation. */
function estimateTurnCostUsd(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number): number {
  // Pricing: [inputPerMTok, outputPerMTok, cacheReadPerMTok, cacheWritePerMTok]
  let pricing = [15, 75, 1.5, 18.75]; // opus default
  if (model.includes("sonnet")) pricing = [3, 15, 0.3, 3.75];
  else if (model.includes("haiku")) pricing = [0.8, 4, 0.08, 1];
  const [inp, out, cr, cw] = pricing;
  return (inputTokens * inp + outputTokens * out + cacheReadTokens * cr + cacheWriteTokens * cw) / 1_000_000;
}

export function AgentPanel({ sessionId, cwd, initialPrompt, visible }: Props) {
  const session = useAppStore((s) => s.agentSessionByTab[sessionId]);
  const appendMessage = useAppStore((s) => s.appendAgentMessage);
  const updateStreaming = useAppStore((s) => s.updateAgentStreamingText);
  const clearStreaming = useAppStore((s) => s.clearAgentStreamingText);
  const setStatus = useAppStore((s) => s.setAgentStatus);
  const setSdkSessionId = useAppStore((s) => s.setAgentSdkSessionId);
  const setPendingPermission = useAppStore((s) => s.setAgentPendingPermission);
  const setPendingQuestion = useAppStore((s) => s.setAgentPendingQuestion);
  const setModel = useAppStore((s) => s.setAgentModel);
  const setEffort = useAppStore((s) => s.setAgentEffort);
  const setPermissionMode = useAppStore((s) => s.setAgentPermissionMode);
  const setConciseMode = useAppStore((s) => s.setAgentConciseMode);
  const setSlashCommands = useAppStore((s) => s.setAgentSlashCommands);
  const pushQueuedMessage = useAppStore((s) => s.pushAgentQueuedMessage);
  const shiftQueuedMessage = useAppStore((s) => s.shiftQueuedMessage);
  const promoteAllQueuedMessages = useAppStore((s) => s.promoteAllQueuedMessages);
  const appSettings = useAppStore((s) => s.appSettings);

  const startedRef = useRef(false);
  // Track current tool_use blocks to pair with tool_results
  const activeToolsRef = useRef<Map<string, { name: string; input: unknown }>>(new Map());
  // Track the last assistant message uuid to deduplicate
  const lastAssistantUuidRef = useRef<string | null>(null);
  // Snapshot of cumulative cost before the current query started, so the
  // authoritative `result` event can replace turn_cost estimates cleanly.
  const preQueryCostRef = useRef(session?.cost ?? null);
  // Whether we've already renamed this tab (to avoid overwriting Haiku title with truncated prompt).
  // If the tab was restored from cache (has existing messages), treat it as already renamed.
  const tabRenamedRef = useRef((session?.messages?.length ?? 0) > 0);

  /** Rename this tab by looking up the owning worktree. */
  const renameThisTab = (label: string) => {
    const store = useAppStore.getState();
    for (const [wtId, tabs] of Object.entries(store.tabsByWorktree)) {
      if (tabs.some((t) => t.id === sessionId)) {
        store.renameTab(wtId, sessionId, label);
        break;
      }
    }
  };

  /** Immediately rename tab to a truncated version of the prompt. */
  const applyQuickTitle = (prompt: string) => {
    if (tabRenamedRef.current) return;
    tabRenamedRef.current = true;
    const words = prompt.trim().split(/\s+/).slice(0, 6).join(" ");
    const label = words.length > 30 ? words.slice(0, 30) + "..." : words;
    if (label) renameThisTab(label);
  };

  /**
   * Build a compact context summary from the conversation history.
   * Used when resuming a session that has grown too large — starts a fresh
   * SDK session with a summary prefix instead of replaying the full history.
   */
  const buildSessionSummary = (session: AgentSessionState, newPrompt: string): string => {
    const parts: string[] = [];

    // Extract user requests and assistant responses (skip tool call/result noise)
    const userMsgs = session.messages.filter((m) => m.type === "user" && !m.isQueued);
    const assistantMsgs = session.messages.filter((m) => m.type === "assistant" && m.content);

    // Summarize the conversation as prior context
    parts.push("<prior_session_context>");
    parts.push("This is a continuation of a previous session. Here is a summary of what was discussed and accomplished:\n");

    // Include all user requests (usually short)
    for (const msg of userMsgs) {
      parts.push(`User request: ${msg.content}`);
    }

    // Include the last few assistant responses (most relevant context)
    const recentAssistant = assistantMsgs.slice(-3);
    if (recentAssistant.length > 0) {
      parts.push("\nRecent assistant responses:");
      for (const msg of recentAssistant) {
        // Truncate long assistant responses
        const text = msg.content!.length > 1000
          ? msg.content!.slice(0, 1000) + "... [truncated]"
          : msg.content!;
        parts.push(text);
      }
    }

    // Note any errors that occurred
    const errors = session.messages.filter((m) => m.type === "error");
    if (errors.length > 0) {
      const lastError = errors[errors.length - 1];
      parts.push(`\nLast error: ${lastError.content}`);
    }

    parts.push("</prior_session_context>\n");
    parts.push(`New request: ${newPrompt}`);

    return parts.join("\n");
  };

  /** Token threshold above which we start a fresh session with summary instead of resuming. */
  const FRESH_SESSION_TOKEN_THRESHOLD = 60_000;

  /** Start or resume an agent session with the given prompt text. */
  const dispatchToAgent = (text: string, images?: ImageAttachment[]) => {
    const store = useAppStore.getState();
    const currentSession = store.agentSessionByTab[sessionId];
    // Snapshot cost before this query so we can replace turn_cost estimates
    // with the authoritative total from the result event.
    preQueryCostRef.current = currentSession?.cost ?? null;
    setStatus(sessionId, "thinking");

    if (currentSession?.sdkSessionId) {
      const inputTokens = currentSession.cost?.inputTokens ?? 0;

      if (inputTokens > FRESH_SESSION_TOKEN_THRESHOLD) {
        // Session is large — start fresh with a context summary to save tokens.
        // Clear the SDK session ID so subsequent sends also start fresh.
        const setSdkId = useAppStore.getState().setAgentSdkSessionId;
        setSdkId(sessionId, null);
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "system",
          content: `Session compacted (${Math.round(inputTokens / 1000)}K input tokens) — starting fresh with context summary.`,
          timestamp: Date.now(),
        });
        const summaryPrompt = buildSessionSummary(currentSession, text);
        commands
          .agentStart(sessionId, cwd, summaryPrompt, {
            model: currentSession.model || undefined,
            effort: currentSession.effort || undefined,
            permissionMode: currentSession.permissionMode || undefined,
            conciseMode: currentSession.conciseMode || undefined,
            apiKey: appSettings?.agent_api_key || undefined,
          }, images)
          .catch((err) => {
            appendMessage(sessionId, {
              id: nextMsgId(),
              type: "error",
              content: String(err),
              timestamp: Date.now(),
            });
            setStatus(sessionId, "error");
          });
      } else {
        // Resume the existing session normally
        commands
          .agentStart(sessionId, cwd, text, {
            model: currentSession.model || undefined,
            effort: currentSession.effort || undefined,
            permissionMode: currentSession.permissionMode || undefined,
            conciseMode: currentSession.conciseMode || undefined,
            resume: currentSession.sdkSessionId,
            apiKey: appSettings?.agent_api_key || undefined,
          }, images)
          .catch((err) => {
            appendMessage(sessionId, {
              id: nextMsgId(),
              type: "error",
              content: String(err),
              timestamp: Date.now(),
            });
            setStatus(sessionId, "error");
          });
      }
    } else {
      // Fresh start
      commands
        .agentStart(sessionId, cwd, text, {
          model: currentSession?.model || undefined,
          effort: currentSession?.effort || undefined,
          permissionMode: currentSession?.permissionMode || undefined,
          conciseMode: currentSession?.conciseMode || undefined,
          apiKey: appSettings?.agent_api_key || undefined,
        }, images)
        .catch((err) => {
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "error",
            content: String(err),
            timestamp: Date.now(),
          });
          setStatus(sessionId, "error");
        });
    }
  };

  // Subscribe to agent events from the Rust backend
  useEffect(() => {
    const unlisten = listen<string>(`agent-event-${sessionId}`, (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.payload);
      } catch {
        return;
      }
      handleBridgeEvent(msg);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionId]);

  // Start the session if we have an initial prompt
  useEffect(() => {
    if (!initialPrompt || startedRef.current) return;
    startedRef.current = true;

    // Immediately rename tab to a truncated prompt (Haiku title will refine later)
    applyQuickTitle(initialPrompt);

    // Add user message immediately
    appendMessage(sessionId, {
      id: nextMsgId(),
      type: "user",
      content: initialPrompt,
      timestamp: Date.now(),
    });
    setStatus(sessionId, "thinking");

    commands
      .agentStart(sessionId, cwd, initialPrompt, {
        model: session?.model || undefined,
        effort: session?.effort || undefined,
        permissionMode: session?.permissionMode || undefined,
        conciseMode: session?.conciseMode || undefined,
        apiKey: appSettings?.agent_api_key || undefined,
      })
      .catch((err) => {
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
        setStatus(sessionId, "error");
      });
  }, [initialPrompt, sessionId, cwd]);

  function handleBridgeEvent(msg: Record<string, unknown>) {
    const type = msg.type as string;

    switch (type) {
      case "init": {
        setSdkSessionId(sessionId, msg.sessionId as string);
        // Seed slash commands from the init payload (names only); the bridge
        // follows up with a richer `commands` event that includes descriptions.
        const names = msg.slashCommands as string[] | undefined;
        if (names && names.length) {
          setSlashCommands(
            sessionId,
            names.map((name) => ({ name, description: "", argumentHint: "" }))
          );
        }
        // Only show "Session started" for the first init, not on resume
        if (!msg.isResume) {
          const mcpServers = msg.mcpServers as Array<{ name: string; status: string }> | undefined;
          const mcpInfo = mcpServers?.length
            ? ` · MCPs: ${mcpServers.map((s) => `${s.name} (${s.status})`).join(", ")}`
            : "";
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "system",
            content: `Session started (model: ${msg.model || "default"})${mcpInfo}`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "assistant": {
        // Flush any streaming text into a final message
        const store = useAppStore.getState();
        const currentSession = store.agentSessionByTab[sessionId];
        if (currentSession?.streamingText) {
          clearStreaming(sessionId);
        }

        // Track uuid to deduplicate against result event
        const uuid = msg.uuid as string | undefined;
        if (uuid) lastAssistantUuidRef.current = uuid;

        const content = msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> || [];
        let textContent = "";
        let thinkingText = "";

        for (const block of content) {
          if (block.type === "text") {
            textContent += block.text || "";
          } else if (block.type === "thinking") {
            thinkingText += block.text || "";
          } else if (block.type === "tool_use") {
            // Track tool use for pairing with tool_result
            activeToolsRef.current.set(block.id!, { name: block.name!, input: block.input });
            appendMessage(sessionId, {
              id: nextMsgId(),
              type: "tool_call",
              toolName: block.name,
              toolInput: block.input,
              toolUseId: block.id,
              timestamp: Date.now(),
            });
          }
        }

        if (textContent || thinkingText) {
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "assistant",
            content: textContent,
            thinkingText: thinkingText || undefined,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "partial": {
        const delta = msg.delta as { type: string; text?: string } | undefined;
        if (delta?.type === "text" && delta.text) {
          updateStreaming(sessionId, delta.text);
        }
        setStatus(sessionId, "thinking");
        break;
      }

      case "tool_result": {
        const toolUseId = msg.toolUseId as string;
        const tool = activeToolsRef.current.get(toolUseId);
        activeToolsRef.current.delete(toolUseId);
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "tool_result",
          toolName: tool?.name || "Tool",
          toolOutput: msg.content as string,
          toolUseId,
          isError: msg.isError as boolean,
          timestamp: Date.now(),
        });
        break;
      }

      case "tool_progress": {
        // Update the active tool's elapsed time for visual feedback
        setStatus(sessionId, "tool_use");
        break;
      }

      case "turn_cost": {
        // Per-turn usage on each assistant message reports cumulative-for-that-message
        // input tokens (including full prior context), so accumulating every event
        // badly over-counts. Instead, treat the latest message's usage as the
        // running total for the current turn and show pre-query snapshot + that.
        // The authoritative `result` event will replace this with exact totals.
        const tc = msg.cost as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
        if (tc) {
          const currentModel = useAppStore.getState().agentSessionByTab[sessionId]?.model || "";
          const estimated = estimateTurnCostUsd(currentModel, tc.inputTokens, tc.outputTokens, tc.cacheReadTokens, tc.cacheWriteTokens);
          const pre = preQueryCostRef.current;
          const running = pre
            ? {
                inputTokens: pre.inputTokens + tc.inputTokens,
                outputTokens: pre.outputTokens + tc.outputTokens,
                cacheReadTokens: pre.cacheReadTokens + tc.cacheReadTokens,
                cacheWriteTokens: pre.cacheWriteTokens + tc.cacheWriteTokens,
                totalCostUsd: pre.totalCostUsd + estimated,
              }
            : { ...tc, totalCostUsd: estimated };
          useAppStore.getState().replaceAgentCost(sessionId, running);
        }
        break;
      }

      case "tool_permission": {
        setPendingPermission(sessionId, {
          callId: msg.callId as string,
          toolName: msg.toolName as string,
          toolInput: msg.toolInput as Record<string, unknown>,
        });
        setStatus(sessionId, "waiting_permission");
        break;
      }

      case "ask_user": {
        setPendingQuestion(sessionId, {
          callId: msg.callId as string,
          questions: msg.questions as AgentMessage["toolInput"] extends unknown ? AgentPendingQuestionInput : never,
        });
        setStatus(sessionId, "waiting_input");
        break;
      }

      case "result": {
        // Flush streaming
        clearStreaming(sessionId);
        // Don't emit resultText as a message — it duplicates the last assistant message.
        const cost = msg.cost as { totalCostUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
        if (cost) {
          // The result event carries the authoritative cost for this query.
          // Replace turn_cost estimates: set cost = pre-query snapshot + authoritative.
          const pre = preQueryCostRef.current;
          const finalCost = pre
            ? {
                inputTokens: pre.inputTokens + cost.inputTokens,
                outputTokens: pre.outputTokens + cost.outputTokens,
                cacheReadTokens: pre.cacheReadTokens + cost.cacheReadTokens,
                cacheWriteTokens: pre.cacheWriteTokens + cost.cacheWriteTokens,
                totalCostUsd: pre.totalCostUsd + cost.totalCostUsd,
              }
            : cost;
          useAppStore.getState().replaceAgentCost(sessionId, finalCost);
          // Store just this turn's usage — sum of fresh + cache read + cache write
          // approximates the current context window size.
          useAppStore.getState().setAgentLastTurnCost(sessionId, cost);
        }
        const subtype = msg.subtype as string;
        activeToolsRef.current.clear();
        lastAssistantUuidRef.current = null;

        // Auto-dispatch next queued message
        const latestSession = useAppStore.getState().agentSessionByTab[sessionId];
        const hasQueue = latestSession && latestSession.queuedMessages.length > 0;

        // Only show error subtypes when there's nothing queued — abort/interrupt
        // subtypes during queue dispatch are expected and shouldn't alarm the user.
        if (subtype && subtype.startsWith("error_") && !hasQueue) {
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "error",
            content: `Session ended: ${subtype.replace(/_/g, " ")}`,
            timestamp: Date.now(),
          });
        }
        setStatus(sessionId, "done");

        if (hasQueue) {
          const nextText = latestSession.queuedMessages[0];
          shiftQueuedMessage(sessionId);
          dispatchToAgent(nextText);
        }
        break;
      }

      case "status": {
        const status = msg.status as string;
        if (status === "tool_use") setStatus(sessionId, "tool_use");
        else if (status === "thinking") setStatus(sessionId, "thinking");
        else if (status === "exited") setStatus(sessionId, "done");
        break;
      }

      case "error": {
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "error",
          content: msg.message as string,
          timestamp: Date.now(),
        });
        setStatus(sessionId, "error");

        // Promote all queued messages to regular (unsent) user messages on error —
        // don't auto-dispatch so the user can decide whether to retry.
        const errSession = useAppStore.getState().agentSessionByTab[sessionId];
        if (errSession && errSession.queuedMessages.length > 0) {
          promoteAllQueuedMessages(sessionId);
        }
        break;
      }

      case "bridge_stderr": {
        // Raw stderr from the agent bridge process. Only surface unambiguous
        // failure signals — otherwise every informational log would spam the
        // thread. If the bridge dies before emitting anything useful, this is
        // the only breadcrumb the user gets.
        const text = (msg.text as string) || "";
        // Skip known informational log lines that aren't real errors
        const isInfoLine = /generated title:|generating title for/i.test(text);
        const looksLikeError = /error|cannot find|failed|exception|ENOENT|throw/i.test(text);
        if (looksLikeError && !isInfoLine) {
          // Strip any existing [bridge] prefix to avoid doubling up
          const cleaned = text.replace(/^\[bridge\]\s*/i, "");
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "error",
            content: `[bridge] ${cleaned}`,
            timestamp: Date.now(),
          });
        }
        break;
      }

      case "title": {
        const title = msg.title as string;
        if (title) renameThisTab(title);
        break;
      }

      case "commands": {
        const cmds = msg.commands as SlashCommand[] | undefined;
        if (cmds) setSlashCommands(sessionId, cmds);
        break;
      }

      case "slash_output": {
        // Output from a local slash command (e.g. /compact, /help). Slash
        // commands short-circuit the API call, so we won't get an `assistant`
        // message — surface their stdout/stderr here instead. Clear the
        // thinking state so the input becomes editable again.
        clearStreaming(sessionId);
        const stdout = (msg.stdout as string) || "";
        const stderr = (msg.stderr as string) || "";
        const text = [stdout, stderr].filter(Boolean).join("\n\n");
        if (text) {
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "slash_output",
            content: text,
            timestamp: Date.now(),
          });
        }
        setStatus(sessionId, "done");
        break;
      }
    }
  }

  // Send a follow-up message (or queue it if agent is busy)
  const handleSend = (text: string, images?: ImageAttachment[]) => {
    // Rename tab from first typed message (when no initialPrompt was provided)
    applyQuickTitle(text);

    const store = useAppStore.getState();
    const currentSession = store.agentSessionByTab[sessionId];

    // Build display content including image count for the message bubble
    const imageNote = images?.length ? ` [${images.length} image${images.length > 1 ? "s" : ""} attached]` : "";

    if (currentSession?.status === "done" || currentSession?.status === "error" || currentSession?.status === "idle") {
      // Direct send — session is not busy
      appendMessage(sessionId, {
        id: nextMsgId(),
        type: "user",
        content: text + imageNote,
        timestamp: Date.now(),
      });
      dispatchToAgent(text, images);
    } else if (
      currentSession?.status === "thinking" ||
      currentSession?.status === "tool_use"
    ) {
      // Queue the message — agent is actively processing.
      // Note: images cannot be queued — they are dropped for queued messages.
      pushQueuedMessage(sessionId, text);
      appendMessage(sessionId, {
        id: nextMsgId(),
        type: "user",
        content: text,
        isQueued: true,
        timestamp: Date.now(),
      });
    } else {
      // waiting_input — send as follow-up input to active session
      appendMessage(sessionId, {
        id: nextMsgId(),
        type: "user",
        content: text + imageNote,
        timestamp: Date.now(),
      });
      setStatus(sessionId, "thinking");
      commands.agentSendInput(sessionId, text, images).catch((err) => {
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
      });
    }
  };

  const handleToolResponse = (behavior: "allow" | "deny", opts?: { message?: string; updatedInput?: unknown }) => {
    const pending = session?.pendingPermission;
    if (!pending) return;
    commands
      .agentToolResponse(sessionId, pending.callId, behavior, opts?.message, opts?.updatedInput)
      .catch((err) => {
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "error",
          content: `Tool response failed: ${err}`,
          timestamp: Date.now(),
        });
      });
    setPendingPermission(sessionId, null);
    setStatus(sessionId, "tool_use");
  };

  const handleAskResponse = (answers: Record<string, string>) => {
    const pending = session?.pendingQuestion;
    if (!pending) return;
    commands.agentAskResponse(sessionId, pending.callId, answers).catch((err) => {
      appendMessage(sessionId, {
        id: nextMsgId(),
        type: "error",
        content: `Ask response failed: ${err}`,
        timestamp: Date.now(),
      });
    });
    setPendingQuestion(sessionId, null);
    setStatus(sessionId, "thinking");
  };

  const handleModelChange = (model: string) => {
    setModel(sessionId, model);
    commands.agentSetModel(sessionId, model).catch(() => {});
  };

  const handleEffortChange = (effort: EffortLevel) => {
    setEffort(sessionId, effort);
  };

  const handlePermissionModeChange = (mode: "default" | "plan" | "acceptEdits" | "bypassPermissions") => {
    setPermissionMode(sessionId, mode);
    commands.agentSetPermissionMode(sessionId, mode).catch(() => {});
  };

  const handleConciseModeChange = (enabled: boolean) => {
    setConciseMode(sessionId, enabled);
  };

  const handleInterrupt = () => {
    // Stop sends the interrupt signal. The bridge will emit a `result` event
    // which will set status to "done" and auto-dispatch queued messages.
    // This keeps the conversation alive — the user (or queue) can continue.
    commands.agentInterrupt(sessionId).catch(() => {});
  };

  if (!session) return null;

  const isInputDisabled = session.status === "waiting_permission";
  const isAgentBusy =
    session.status === "thinking" || session.status === "tool_use";

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <MessageList
        messages={session.messages}
        streamingText={session.streamingText}
        status={session.status}
      />

      {/* Permission dialog */}
      {session.pendingPermission && (
        isPlanPermission(session.pendingPermission) ? (
          <PlanApprovalDialog
            pending={session.pendingPermission}
            onApprove={(updatedInput) => handleToolResponse("allow", { updatedInput })}
            onRequestChanges={(feedback) =>
              handleToolResponse("deny", {
                message: `Please revise the plan: ${feedback}`,
              })
            }
            onDeny={() => handleToolResponse("deny")}
          />
        ) : (
          <PermissionDialog
            pending={session.pendingPermission}
            onAllow={() => handleToolResponse("allow")}
            onDeny={() => handleToolResponse("deny")}
          />
        )
      )}

      {/* Ask user dialog */}
      {session.pendingQuestion && (
        <AskUserDialog
          pending={session.pendingQuestion}
          onSubmit={handleAskResponse}
        />
      )}

      {/* Bottom controls: status/cost bar, model/effort/plan, then input */}
      <AgentToolbar
        session={session}
        onInterrupt={handleInterrupt}
      />
      <AgentControls
        model={session.model}
        effort={session.effort}
        permissionMode={session.permissionMode}
        conciseMode={session.conciseMode}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onPermissionModeChange={handlePermissionModeChange}
        onConciseModeChange={handleConciseModeChange}
      />
      <AgentInputBar
        sessionId={sessionId}
        disabled={isInputDisabled}
        isAgentBusy={isAgentBusy}
        autoFocus={visible}
        placeholder={
          session.status === "done"
            ? "Send a follow-up message..."
            : session.status === "waiting_input"
              ? "Answer Claude's question..."
              : session.status === "idle"
                ? "Send a message to start..."
                : "Queue a message for when Claude finishes..."
        }
        slashCommands={session.slashCommands}
        onSend={handleSend}
      />
    </div>
  );
}

// Type helper for ask_user questions
type AgentPendingQuestionInput = Array<{
  question: string;
  header: string;
  options: Array<{ label: string; description: string; preview?: string }>;
  multiSelect: boolean;
}>;
