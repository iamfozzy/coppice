import { memo, useState, useCallback } from "react";
import type { AgentMessage } from "../../lib/types";
import { Tooltip } from "../ui/Tooltip";
import { MarkdownContent } from "./MarkdownContent";
import { claudeAuthLogin } from "../../lib/commands";

interface Props {
  message: AgentMessage;
  onCancel?: (messageId: string) => void;
  worktreePath?: string;
}

export const MessageBubble = memo(function MessageBubble({ message, onCancel, worktreePath }: Props) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end pl-12">
          <div className={`rounded-xl rounded-br-sm px-3.5 py-2 text-sm text-text-primary whitespace-pre-wrap break-words ${
            message.isQueued
              ? "bg-amber-500/8 border border-amber-500/20"
              : "bg-accent/10 border border-accent/20"
          }`}>
            {message.isQueued && (
              <div className="flex items-center gap-1 mb-1 text-[length:var(--app-font-10)] text-amber-400 font-medium">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1" />
                  <path d="M5 2.5v3l1.5 1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
                </svg>
                <span className="flex-1">Queued — will send when the agent finishes</span>
                {onCancel && (
                  <Tooltip text="Cancel queued message" side="top">
                    <button
                      onClick={() => onCancel(message.id)}
                      className="ml-1 p-0.5 rounded hover:bg-amber-500/20 text-amber-400 hover:text-amber-300 transition-colors"
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    </button>
                  </Tooltip>
                )}
              </div>
            )}
            {message.content}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="pr-8">
          {message.thinkingText && <ThinkingBlock text={message.thinkingText} />}
          {message.content && <MarkdownContent text={message.content} worktreePath={worktreePath} />}
        </div>
      );

    case "system":
      return (
        <div className="flex items-center gap-2 py-0.5">
          <div className="flex-1 h-px bg-border-primary" />
          <span className="text-[length:var(--app-font-10)] text-text-tertiary shrink-0 flex items-center gap-1.5">
            {message.content}
            {message.mcpServers && message.mcpServers.length > 0 && (
              <McpTooltip servers={message.mcpServers} />
            )}
          </span>
          <div className="flex-1 h-px bg-border-primary" />
        </div>
      );

    case "slash_output":
      return (
        <div className="pr-8">
          <div className="rounded-lg border border-border-primary bg-bg-secondary/40 overflow-hidden">
            <div className="px-3 py-1 bg-bg-secondary/60 border-b border-border-primary text-[length:var(--app-font-10)] text-text-tertiary font-mono uppercase tracking-wider">
              slash command output
            </div>
            <div className="px-3 py-2">
              <MarkdownContent text={message.content || ""} worktreePath={worktreePath} />
            </div>
          </div>
        </div>
      );

    case "error":
      return <ErrorBubble message={message} />;

    default:
      return null;
  }
});

// ---------------------------------------------------------------------------
// Auth error detection + re-login action
// ---------------------------------------------------------------------------

/** Patterns that indicate an authentication / login expiry error. */
const AUTH_ERROR_PATTERNS = [
  /not authenticated/i,
  /authentication.*(?:expired|failed|required|invalid)/i,
  /unauthorized/i,
  /session_stale_relogin/i,
  /untrusted_device/i,
  /login.*(?:expired|required)/i,
  /token.*(?:expired|invalid|revoked)/i,
  /please.*log\s*in/i,
  /credential.*(?:expired|invalid|missing)/i,
  /401/,
  /oauth.*(?:expired|failed|invalid)/i,
];

function isAuthError(content: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(content));
}

function ErrorBubble({ message }: { message: AgentMessage }) {
  const [loginStatus, setLoginStatus] = useState<"idle" | "pending" | "success">("idle");
  const showLogin = isAuthError(message.content || "");

  const handleLogin = useCallback(async () => {
    setLoginStatus("pending");
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<string>("claude-auth-event", (event) => {
        try {
          const msg = JSON.parse(event.payload);
          if (msg.type === "success") {
            setLoginStatus("success");
            unlisten();
          } else if (msg.type === "error") {
            setLoginStatus("idle");
            unlisten();
          }
        } catch {}
      });
      await claudeAuthLogin();
    } catch {
      setLoginStatus("idle");
    }
  }, []);

  return (
    <div className="flex items-start gap-2 bg-error/8 border border-error/20 rounded-lg px-3 py-2.5 text-sm text-error">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="mt-0.5 shrink-0">
        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1.2" />
        <path d="M7 4v3.5M7 9.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <div className="break-words flex-1">
        <span>{message.content}</span>
        {showLogin && (
          <button
            type="button"
            onClick={handleLogin}
            disabled={loginStatus !== "idle"}
            className={`ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-[length:var(--app-font-11)] font-medium rounded transition-colors ${
              loginStatus === "success"
                ? "bg-green-500/15 text-green-400 border border-green-500/30"
                : loginStatus === "pending"
                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/30 animate-pulse"
                  : "bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500/20 cursor-pointer"
            }`}
          >
            {loginStatus === "success" ? "✓ Logged in" :
             loginStatus === "pending" ? "Logging in…" :
             "Re-login"}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MCP servers tooltip
// ---------------------------------------------------------------------------
function McpTooltip({ servers }: { servers: Array<{ name: string; status: string }> }) {
  const connected = servers.filter((s) => s.status === "connected");
  const other = servers.filter((s) => s.status !== "connected");

  return (
    <div className="flex items-center gap-1">
      {connected.length > 0 && (
        <McpDropdown servers={connected} variant="connected" />
      )}
      {other.length > 0 && (
        <McpDropdown servers={other} variant="other" />
      )}
    </div>
  );
}

function McpDropdown({
  servers,
  variant,
}: {
  servers: Array<{ name: string; status: string }>;
  variant: "connected" | "other";
}) {
  const [open, setOpen] = useState(false);
  const isConnected = variant === "connected";

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(!open)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[length:var(--app-font-9)] font-medium transition-colors ${
          isConnected
            ? "bg-green-500/10 text-green-400 hover:bg-green-500/20"
            : "bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
        }`}
        title={isConnected ? "Connected MCP servers" : "Pending MCP servers"}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-green-400" : "bg-amber-400"}`} />
        {servers.length}
      </button>
      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-50 min-w-[140px] bg-bg-secondary border border-border-primary rounded-lg shadow-lg py-1.5 px-2">
          <div className="text-[length:var(--app-font-9)] text-text-tertiary uppercase tracking-wider mb-1">
            {isConnected ? "Connected" : "Pending"}
          </div>
          {servers.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5 py-0.5 text-[length:var(--app-font-10)]">
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-green-400" : "bg-amber-400"}`} />
              <span className="text-text-secondary truncate">{s.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thinking block
// ---------------------------------------------------------------------------
function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n").length;
  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-[length:var(--app-font-11)] text-text-tertiary hover:text-text-secondary transition-colors"
      >
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Thinking
        <span className="text-text-tertiary/60">({lines} {lines === 1 ? "line" : "lines"})</span>
      </button>
      {open && (
        <div className="mt-1.5 pl-3 border-l-2 border-border-primary text-xs text-text-tertiary/80 whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {text}
        </div>
      )}
    </div>
  );
}
