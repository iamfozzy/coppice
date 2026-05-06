import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as commands from "../../lib/commands";
import { useAppStore } from "../../stores/appStore";
import type { AgentMessage, EffortLevel, ImageAttachment, SlashCommand, TraceEvent } from "../../lib/types";
import { AgentToolbar } from "./AgentToolbar";
import { AgentControls } from "./AgentControls";
import { MessageList } from "./MessageList";
import { AgentInputBar } from "./AgentInputBar";
import { PermissionDialog } from "./PermissionDialog";
import { AskUserDialog } from "./AskUserDialog";
import { isPlanPermission } from "./PlanApprovalDialog";

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

let traceIdCounter = 0;
function nextTraceId() {
  return `tr-${++traceIdCounter}-${Date.now()}`;
}

export function AgentPanel({ sessionId, cwd, initialPrompt, visible }: Props) {
  const session = useAppStore((s) => s.agentSessionByTab[sessionId]);
  const appendMessage = useAppStore((s) => s.appendAgentMessage);
  const updateStreaming = useAppStore((s) => s.updateAgentStreamingText);
  const clearStreaming = useAppStore((s) => s.clearAgentStreamingText);
  const updateStreamingThinking = useAppStore((s) => s.updateAgentStreamingThinking);
  const clearStreamingThinking = useAppStore((s) => s.clearAgentStreamingThinking);
  const setStatus = useAppStore((s) => s.setAgentStatus);
  const setSdkSessionId = useAppStore((s) => s.setAgentSdkSessionId);
  const setPendingPermission = useAppStore((s) => s.setAgentPendingPermission);
  const setPendingQuestion = useAppStore((s) => s.setAgentPendingQuestion);
  const setModel = useAppStore((s) => s.setAgentModel);
  const setEffort = useAppStore((s) => s.setAgentEffort);
  const setPermissionMode = useAppStore((s) => s.setAgentPermissionMode);
  const setConciseMode = useAppStore((s) => s.setAgentConciseMode);
  const setChatMode = useAppStore((s) => s.setAgentChatMode);
  const setExtendedContext = useAppStore((s) => s.setAgentExtendedContext);
  const setSlashCommands = useAppStore((s) => s.setAgentSlashCommands);
  const pushQueuedMessage = useAppStore((s) => s.pushAgentQueuedMessage);
  const cancelQueuedMessage = useAppStore((s) => s.cancelQueuedAgentMessage);
  const shiftQueuedMessage = useAppStore((s) => s.shiftQueuedMessage);
  const promoteAllQueuedMessages = useAppStore((s) => s.promoteAllQueuedMessages);
  const appendTrace = useAppStore((s) => s.appendTraceEvent);
  const appendTraces = useAppStore((s) => s.appendTraceEvents);
  const appSettings = useAppStore((s) => s.appSettings);

  const startedRef = useRef(false);
  // Track current tool_use blocks to pair with tool_results
  const activeToolsRef = useRef<Map<string, { name: string; input: unknown }>>(new Map());
  // Track the last assistant message uuid to deduplicate
  const lastAssistantUuidRef = useRef<string | null>(null);
  // Whether we've already renamed this tab (to avoid overwriting Haiku title with truncated prompt).
  // If the tab was restored from cache (has existing messages), treat it as already renamed.
  const tabRenamedRef = useRef((session?.messages?.length ?? 0) > 0);

  // Stall detection — track last event from bridge, warn if no events for 30s while busy
  const lastEventTimeRef = useRef(Date.now());
  const [stalled, setStalled] = useState(false);

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

  /** Start or resume an agent session with the given prompt text. */
  const dispatchToAgent = (text: string, images?: ImageAttachment[]) => {
    const store = useAppStore.getState();
    const currentSession = store.agentSessionByTab[sessionId];
    setStatus(sessionId, "thinking");

    if (currentSession?.sdkSessionId) {
      // Always resume — SDK handles its own compaction
      commands
        .agentStart(sessionId, cwd, text, {
          model: currentSession.model || undefined,
          effort: currentSession.effort || undefined,
          permissionMode: currentSession.permissionMode || undefined,
          conciseMode: currentSession.conciseMode || undefined,
          chatMode: currentSession.chatMode || undefined,
          extendedContext: currentSession.extendedContext || undefined,
          resume: currentSession.sdkSessionId,
          apiKey: appSettings?.agent_api_key || undefined,
          priorCost: currentSession.cost ?? undefined,
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
      // Fresh start
      commands
        .agentStart(sessionId, cwd, text, {
          model: currentSession?.model || undefined,
          effort: currentSession?.effort || undefined,
          permissionMode: currentSession?.permissionMode || undefined,
          conciseMode: currentSession?.conciseMode || undefined,
          chatMode: currentSession?.chatMode || undefined,
          extendedContext: currentSession?.extendedContext || undefined,
          apiKey: appSettings?.agent_api_key || undefined,
          priorCost: currentSession?.cost ?? undefined,
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
      lastEventTimeRef.current = Date.now();
      if (stalled) setStalled(false);
      handleBridgeEvent(msg);
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [sessionId]);

  // Stall detection — check every 5s if the bridge has gone silent while busy
  useEffect(() => {
    const STALL_THRESHOLD_MS = 30_000;
    const id = setInterval(() => {
      const s = useAppStore.getState().agentSessionByTab[sessionId];
      const isBusy = s?.status === "thinking" || s?.status === "tool_use";
      const elapsed = Date.now() - lastEventTimeRef.current;
      setStalled(isBusy && elapsed > STALL_THRESHOLD_MS);
    }, 5_000);
    return () => clearInterval(id);
  }, [sessionId]);

  // Eagerly load project slash commands from .claude/commands/ so they appear
  // in the command picker before the SDK bridge session has started.
  useEffect(() => {
    console.log("[AgentPanel] useEffect fired — loading project commands for cwd:", cwd, "sessionId:", sessionId);
    commands.getProjectCommands(cwd).then((projectCmds) => {
      console.log("[AgentPanel] getProjectCommands returned:", projectCmds);
      if (!projectCmds.length) return;
      const store = useAppStore.getState();
      const current = store.agentSessionByTab[sessionId]?.slashCommands ?? [];
      console.log("[AgentPanel] current slashCommands count:", current.length);
      const existingNames = new Set(current.map((c) => c.name));
      const newCmds = projectCmds.filter((c) => !existingNames.has(c.name));
      if (newCmds.length) {
        setSlashCommands(sessionId, [
          ...current,
          ...newCmds.map((c) => ({
            name: c.name,
            description: c.description,
            argumentHint: c.argumentHint,
          })),
        ]);
        console.log("[AgentPanel] Merged", newCmds.length, "project commands into store");
      }
    }).catch((err) => { console.warn("[AgentPanel] Failed to load project commands:", err); });
  }, [sessionId, cwd]);

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
    // Trace: initial query_start
    appendTrace(sessionId, { type: "query_start", content: initialPrompt, id: nextTraceId(), timestamp: Date.now() });
    setStatus(sessionId, "thinking");

    commands
      .agentStart(sessionId, cwd, initialPrompt, {
        model: session?.model || undefined,
        effort: session?.effort || undefined,
        permissionMode: session?.permissionMode || undefined,
        conciseMode: session?.conciseMode || undefined,
        chatMode: session?.chatMode || undefined,
        extendedContext: session?.extendedContext || undefined,
        apiKey: appSettings?.agent_api_key || undefined,
        priorCost: session?.cost ?? undefined,
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
    // Batch trace events — collected during the switch and flushed once at the end
    const pendingTraces: Array<Omit<TraceEvent, "id" | "timestamp">> = [];
    const bt = (e: Omit<TraceEvent, "id" | "timestamp">) => { pendingTraces.push(e); };

    switch (type) {
      case "init": {
        setSdkSessionId(sessionId, msg.sessionId as string);
        // Sync the model the SDK actually resolved (matters when no explicit
        // model was requested and the SDK picked its own default).
        const sdkModel = msg.model as string | undefined;
        if (sdkModel) {
          const cur = useAppStore.getState().agentSessionByTab[sessionId];
          if (!cur?.model) setModel(sessionId, sdkModel);
        }
        // Seed slash commands from the init payload (names only); the bridge
        // follows up with a richer `commands` event that includes descriptions.
        // Merge with any existing entries (notably project commands eagerly
        // loaded from .claude/commands/) so this seed pass doesn't clobber
        // them — otherwise they only reappear once the SDK gets around to
        // re-enumerating them, which is racy and user-visible.
        const names = msg.slashCommands as string[] | undefined;
        if (names && names.length) {
          const current = useAppStore.getState().agentSessionByTab[sessionId]?.slashCommands ?? [];
          const sdkNames = new Set(names);
          const merged = [
            ...names.map((name) => {
              const existing = current.find((c) => c.name === name);
              return existing ?? { name, description: "", argumentHint: "" };
            }),
            ...current.filter((c) => !sdkNames.has(c.name)),
          ];
          setSlashCommands(sessionId, merged);
        }
        // Only show "Session started" for the first init, not on resume
        if (!msg.isResume) {
          const mcpServers = msg.mcpServers as Array<{ name: string; status: string }> | undefined;
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "system",
            content: `Session started (model: ${sdkModel || "default"})`,
            mcpServers: mcpServers?.length ? mcpServers : undefined,
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
        if (currentSession?.streamingThinkingText) {
          clearStreamingThinking(sessionId);
        }

        // Track uuid to deduplicate against result event
        const uuid = msg.uuid as string | undefined;
        if (uuid) lastAssistantUuidRef.current = uuid;

        const content = msg.content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> || [];
        let textContent = "";
        let thinkingText = "";
        const toolBlocks: Array<{ id: string; name: string; input: unknown }> = [];

        for (const block of content) {
          if (block.type === "text") {
            textContent += block.text || "";
          } else if (block.type === "thinking") {
            thinkingText += block.text || "";
          } else if (block.type === "tool_use") {
            toolBlocks.push({ id: block.id!, name: block.name!, input: block.input });
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

        // Trace: turn_start FIRST — includes tool names so the turn always
        // knows what tools were called even if tool_result pairing fails.
        bt({
          type: "turn_start",
          content: textContent ? textContent.slice(0, 200) : undefined,
          thinkingText: thinkingText || undefined,
          turnToolNames: toolBlocks.length > 0 ? toolBlocks.map((b) => b.name) : undefined,
        });

        // Trace: individual tool_call events (for pairing with tool_result)
        for (const tb of toolBlocks) {
          bt({ type: "tool_call", toolName: tb.name, toolInput: tb.input, toolUseId: tb.id });
        }
        break;
      }

      case "partial": {
        const delta = msg.delta as { type: string; text?: string; thinking?: string } | undefined;
        if (delta?.type === "text" && delta.text) {
          updateStreaming(sessionId, delta.text);
        } else if (delta?.type === "thinking" && delta.text) {
          updateStreamingThinking(sessionId, delta.text);
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
        // Trace: tool_result
        bt({
          type: "tool_result",
          toolName: tool?.name || "Tool",
          toolOutput: (msg.content as string)?.slice(0, 500),
          toolUseId,
          isError: msg.isError as boolean,
        });
        break;
      }

      case "tool_progress": {
        // Update the active tool's elapsed time for visual feedback
        setStatus(sessionId, "tool_use");
        break;
      }

      case "turn_cost": {
        // Each turn_cost carries one API call's usage. We only use it to
        // refresh `lastTurnCost` — which represents the context window size
        // of the most recent call. We deliberately do NOT sum these into
        // session `cost`: in a tool loop, each call's cache_read already
        // includes the full cached prefix, so summing inflates totals ~N×.
        // The authoritative session totals arrive in the `result` event via
        // SDK modelUsage.
        const tc = msg.cost as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
        if (tc) {
          useAppStore.getState().setAgentLastTurnCost(sessionId, tc);
          // Accumulate output tokens for the in-flight query so the toolbar
          // can show live progress while session totals stay frozen.
          useAppStore.getState().accumulateQueryOutput(sessionId, tc.outputTokens);
          // Trace: preserve per-turn cost (this is the data that was previously overwritten)
          bt({ type: "turn_cost", cost: tc });
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
        clearStreamingThinking(sessionId);
        // Don't emit resultText as a message — it duplicates the last assistant message.
        const cost = msg.cost as { totalCostUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
        const lastTurn = msg.lastTurnCost as { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
        if (cost) {
          // `cost` from the bridge is now the absolute cumulative session
          // total (the bridge accumulates internally and seeds from
          // priorCost on first start). Replace session.cost directly —
          // no client-side accumulation.
          useAppStore.getState().replaceAgentCost(sessionId, cost);
          // `lastTurnCost` from the bridge is the last individual API
          // call's usage (tracked per-turn in the bridge), NOT the
          // per-query aggregate. This represents what the model actually
          // held in its context window on the final call.
          useAppStore.getState().setAgentLastTurnCost(sessionId, lastTurn ?? {
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            cacheReadTokens: cost.cacheReadTokens,
            cacheWriteTokens: cost.cacheWriteTokens,
          });
        }
        // Query finished — reset the in-flight output accumulator.
        useAppStore.getState().resetQueryOutput(sessionId);
        // Store the SDK-reported context window size if provided.
        const sdkContextWindow = msg.contextWindow as number | undefined;
        if (sdkContextWindow && sdkContextWindow > 0) {
          useAppStore.getState().setAgentSdkContextWindow(sessionId, sdkContextWindow);
        }
        const subtype = msg.subtype as string;
        activeToolsRef.current.clear();
        lastAssistantUuidRef.current = null;

        // Trace: query_end with full metrics
        const durationMs = msg.durationMs as number | undefined;
        const numTurns = msg.numTurns as number | undefined;
        bt({
          type: "query_end",
          durationMs,
          numTurns,
          cumulativeCost: cost ?? undefined,
          contextWindow: sdkContextWindow,
          status: subtype,
        });

        // Auto-dispatch next queued message
        const latestSession = useAppStore.getState().agentSessionByTab[sessionId];
        const hasQueue = latestSession && latestSession.queuedMessages.length > 0;

        // Show error subtypes only when they indicate a real failure the user
        // should know about. `error_during_execution` is a common SDK
        // termination reason when a tool returned an error that the agent
        // already handled gracefully — surfacing it alarms users needlessly.
        if (subtype && subtype.startsWith("error_") && !hasQueue && subtype !== "error_during_execution") {
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "error",
            content: `Session ended: ${subtype.replace(/_/g, " ")}`,
            timestamp: Date.now(),
          });
        }
        setStatus(sessionId, "done");

        if (hasQueue) {
          const nextQueued = latestSession.queuedMessages[0];
          shiftQueuedMessage(sessionId);
          dispatchToAgent(nextQueued.text, nextQueued.images);
        }
        break;
      }

      case "status": {
        const statusVal = msg.status as string;
        if (statusVal === "tool_use") setStatus(sessionId, "tool_use");
        else if (statusVal === "thinking") setStatus(sessionId, "thinking");
        else if (statusVal === "exited") setStatus(sessionId, "done");
        // Trace: status transitions
        bt({ type: "status_change", status: statusVal });
        break;
      }

      case "error": {
        const errorMsg = msg.message as string;
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "error",
          content: errorMsg,
          timestamp: Date.now(),
        });
        setStatus(sessionId, "error");
        // Trace: error
        bt({ type: "error", content: errorMsg });

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
        // Merge SDK-provided commands with any existing project commands the
        // SDK didn't include, so eagerly-loaded entries from .claude/commands/
        // survive this update. SDK-provided entries take precedence on name
        // collisions (they have richer descriptions).
        const cmds = msg.commands as SlashCommand[] | undefined;
        if (cmds) {
          const current = useAppStore.getState().agentSessionByTab[sessionId]?.slashCommands ?? [];
          const sdkNames = new Set(cmds.map((c) => c.name));
          setSlashCommands(sessionId, [
            ...cmds,
            ...current.filter((c) => !sdkNames.has(c.name)),
          ]);
        }
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

      case "compact_boundary": {
        const preTokens = msg.preTokens as number | undefined;
        const trigger = msg.trigger as string | undefined;
        const label = trigger === "manual" ? "Manual compaction" : "Auto-compaction";
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "system",
          content: `${label} — context summarized${preTokens ? ` (was ${Math.round(preTokens / 1000)}K tokens)` : ""}.`,
          timestamp: Date.now(),
        });
        // Trace: compaction event
        bt({ type: "compact", preTokens, trigger: trigger ?? undefined });
        break;
      }

      case "heartbeat":
        break;
    }

    // Flush all batched trace events in a single state update
    if (pendingTraces.length > 0) {
      const now = Date.now();
      appendTraces(sessionId, pendingTraces.map((e, i) => ({
        ...e, id: nextTraceId(), timestamp: now + i,
      })));
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
      // Trace: query_start
      appendTrace(sessionId, { type: "query_start", content: text, id: nextTraceId(), timestamp: Date.now() });
      dispatchToAgent(text, images);
    } else if (
      currentSession?.status === "thinking" ||
      currentSession?.status === "tool_use"
    ) {
      // Queue the message (including any images) — dispatched when agent finishes.
      pushQueuedMessage(sessionId, text, images);
      appendMessage(sessionId, {
        id: nextMsgId(),
        type: "user",
        content: text + imageNote,
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

  const handleChatModeChange = (enabled: boolean) => {
    setChatMode(sessionId, enabled);
  };

  const handleExtendedContextChange = (enabled: boolean) => {
    setExtendedContext(sessionId, enabled);
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
        streamingThinkingText={session.streamingThinkingText}
        status={session.status}
        stalled={stalled}
        onCancelQueued={(msgId) => cancelQueuedMessage(sessionId, msgId)}
        pendingPlan={session.pendingPermission && isPlanPermission(session.pendingPermission) ? session.pendingPermission : null}
        onPlanApprove={(updatedInput) => handleToolResponse("allow", { updatedInput })}
        onPlanRequestChanges={(feedback) =>
          handleToolResponse("deny", {
            message: `Please revise the plan: ${feedback}`,
          })
        }
        onPlanDeny={() => handleToolResponse("deny")}
      />

      {/* Permission dialog — non-plan permissions only (plans render inline in chat) */}
      {session.pendingPermission && !isPlanPermission(session.pendingPermission) && (
        <PermissionDialog
          pending={session.pendingPermission}
          onAllow={() => handleToolResponse("allow")}
          onDeny={() => handleToolResponse("deny")}
        />
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
        sessionId={sessionId}
        onInterrupt={handleInterrupt}
      />
      <AgentControls
        model={session.model}
        effort={session.effort}
        permissionMode={session.permissionMode}
        conciseMode={session.conciseMode}
        chatMode={session.chatMode}
        extendedContext={session.extendedContext}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onPermissionModeChange={handlePermissionModeChange}
        onConciseModeChange={handleConciseModeChange}
        onChatModeChange={handleChatModeChange}
        onExtendedContextChange={handleExtendedContextChange}
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
                : "Queue message..."
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
