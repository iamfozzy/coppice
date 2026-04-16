import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import * as commands from "../../lib/commands";
import { useAppStore } from "../../stores/appStore";
import type { AgentMessage } from "../../lib/types";
import { AgentToolbar } from "./AgentToolbar";
import { MessageList } from "./MessageList";
import { AgentInputBar } from "./AgentInputBar";
import { PermissionDialog } from "./PermissionDialog";
import { AskUserDialog } from "./AskUserDialog";

interface Props {
  sessionId: string;
  cwd: string;
  initialPrompt?: string;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `msg-${++msgIdCounter}-${Date.now()}`;
}

export function AgentPanel({ sessionId, cwd, initialPrompt }: Props) {
  const session = useAppStore((s) => s.agentSessionByTab[sessionId]);
  const appendMessage = useAppStore((s) => s.appendAgentMessage);
  const updateStreaming = useAppStore((s) => s.updateAgentStreamingText);
  const clearStreaming = useAppStore((s) => s.clearAgentStreamingText);
  const setStatus = useAppStore((s) => s.setAgentStatus);
  const setCost = useAppStore((s) => s.setAgentCost);
  const setSdkSessionId = useAppStore((s) => s.setAgentSdkSessionId);
  const setPendingPermission = useAppStore((s) => s.setAgentPendingPermission);
  const setPendingQuestion = useAppStore((s) => s.setAgentPendingQuestion);
  const setModel = useAppStore((s) => s.setAgentModel);
  const setEffort = useAppStore((s) => s.setAgentEffort);
  const setPermissionMode = useAppStore((s) => s.setAgentPermissionMode);
  const appSettings = useAppStore((s) => s.appSettings);

  const startedRef = useRef(false);
  // Track current tool_use blocks to pair with tool_results
  const activeToolsRef = useRef<Map<string, { name: string; input: unknown }>>(new Map());

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
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "system",
          content: `Session started (model: ${msg.model || "default"})`,
          timestamp: Date.now(),
        });
        break;
      }

      case "assistant": {
        // Flush any streaming text into a final message
        const store = useAppStore.getState();
        const currentSession = store.agentSessionByTab[sessionId];
        if (currentSession?.streamingText) {
          clearStreaming(sessionId);
        }

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
        const resultText = msg.resultText as string;
        if (resultText) {
          appendMessage(sessionId, {
            id: nextMsgId(),
            type: "assistant",
            content: resultText,
            timestamp: Date.now(),
          });
        }
        const cost = msg.cost as { totalCostUsd: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } | undefined;
        if (cost) {
          setCost(sessionId, cost);
        }
        setStatus(sessionId, "done");
        activeToolsRef.current.clear();
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
        break;
      }
    }
  }

  // Send a follow-up message
  const handleSend = (text: string) => {
    appendMessage(sessionId, {
      id: nextMsgId(),
      type: "user",
      content: text,
      timestamp: Date.now(),
    });

    const store = useAppStore.getState();
    const currentSession = store.agentSessionByTab[sessionId];

    if (currentSession?.status === "done" || currentSession?.status === "error" || currentSession?.status === "idle") {
      // Start a new session or resume
      setStatus(sessionId, "thinking");
      if (currentSession?.sdkSessionId) {
        // Resume the existing session
        commands
          .agentStart(sessionId, cwd, text, {
            model: currentSession.model || undefined,
            effort: currentSession.effort || undefined,
            permissionMode: currentSession.permissionMode || undefined,
            resume: currentSession.sdkSessionId,
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
      } else {
        // Fresh start
        commands
          .agentStart(sessionId, cwd, text, {
            model: currentSession?.model || undefined,
            effort: currentSession?.effort || undefined,
            permissionMode: currentSession?.permissionMode || undefined,
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
      }
    } else {
      // Send as follow-up input to active session
      setStatus(sessionId, "thinking");
      commands.agentSendInput(sessionId, text).catch((err) => {
        appendMessage(sessionId, {
          id: nextMsgId(),
          type: "error",
          content: String(err),
          timestamp: Date.now(),
        });
      });
    }
  };

  const handleToolResponse = (behavior: "allow" | "deny") => {
    const pending = session?.pendingPermission;
    if (!pending) return;
    commands.agentToolResponse(sessionId, pending.callId, behavior).catch(() => {});
    setPendingPermission(sessionId, null);
    setStatus(sessionId, "tool_use");
  };

  const handleAskResponse = (answers: Record<string, string>) => {
    const pending = session?.pendingQuestion;
    if (!pending) return;
    commands.agentAskResponse(sessionId, pending.callId, answers).catch(() => {});
    setPendingQuestion(sessionId, null);
    setStatus(sessionId, "thinking");
  };

  const handleModelChange = (model: string) => {
    setModel(sessionId, model);
    commands.agentSetModel(sessionId, model).catch(() => {});
  };

  const handleEffortChange = (effort: "low" | "medium" | "high" | "max") => {
    setEffort(sessionId, effort);
  };

  const handlePermissionModeChange = (mode: "default" | "plan" | "acceptEdits" | "bypassPermissions") => {
    setPermissionMode(sessionId, mode);
    commands.agentSetPermissionMode(sessionId, mode).catch(() => {});
  };

  const handleInterrupt = () => {
    commands.agentInterrupt(sessionId).catch(() => {});
  };

  if (!session) return null;

  const isInputDisabled =
    session.status === "thinking" ||
    session.status === "tool_use" ||
    session.status === "waiting_permission";

  return (
    <div className="flex flex-col h-full bg-bg-primary">
      <AgentToolbar
        session={session}
        onModelChange={handleModelChange}
        onEffortChange={handleEffortChange}
        onPermissionModeChange={handlePermissionModeChange}
        onInterrupt={handleInterrupt}
      />

      <MessageList
        messages={session.messages}
        streamingText={session.streamingText}
      />

      {/* Permission dialog */}
      {session.pendingPermission && (
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

      <AgentInputBar
        disabled={isInputDisabled}
        placeholder={
          session.status === "done"
            ? "Send a follow-up message..."
            : session.status === "waiting_input"
              ? "Answer Claude's question..."
              : session.status === "idle"
                ? "Send a message to start..."
                : "Claude is working..."
        }
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
