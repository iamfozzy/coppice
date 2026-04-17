import { useState, useRef, useEffect, useMemo } from "react";
import type { SlashCommand } from "../../lib/types";

interface Props {
  disabled: boolean;
  isAgentBusy: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  slashCommands?: SlashCommand[];
  onSend: (text: string) => void;
}

/** Return the command name the user is currently typing, or null. */
function parseLeadingSlash(text: string): string | null {
  // Only trigger on a leading `/` with no whitespace yet — i.e. the whole input
  // so far is the command name. This matches Claude Code's picker behavior.
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

export function AgentInputBar({ disabled, isAgentBusy, autoFocus, placeholder, slashCommands, onSend }: Props) {
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus textarea when this tab becomes visible
  useEffect(() => {
    if (autoFocus && !disabled) {
      textareaRef.current?.focus();
    }
  }, [autoFocus, disabled]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [text]);

  const query = parseLeadingSlash(text);
  const filtered = useMemo<SlashCommand[]>(() => {
    if (query === null || !slashCommands?.length) return [];
    const q = query.toLowerCase();
    return slashCommands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 10);
  }, [query, slashCommands]);

  const pickerOpen = filtered.length > 0;

  // Reset the highlighted row whenever the filter changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const sendText = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
  };

  const applyCommand = (cmd: SlashCommand) => {
    // If the command takes arguments, insert `/name ` and let the user type.
    // Otherwise send immediately — mirrors Claude Code's one-tap behavior.
    if (cmd.argumentHint) {
      setText(`/${cmd.name} `);
      textareaRef.current?.focus();
    } else {
      sendText(`/${cmd.name}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) setText(`/${cmd.name}${cmd.argumentHint ? " " : ""}`);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) applyCommand(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText(text);
    }
  };

  // Determine button label & style based on queue state
  const showQueueButton = isAgentBusy && !disabled;

  return (
    <div className="relative">
      {pickerOpen && (
        <div className="absolute bottom-full left-3 right-3 mb-1 max-h-60 overflow-y-auto rounded-lg border border-border-primary bg-bg-secondary shadow-lg z-10">
          {filtered.map((cmd, i) => (
            <button
              key={cmd.name}
              type="button"
              className={`w-full text-left px-3 py-1.5 text-[12px] font-mono flex items-baseline gap-2 ${
                i === activeIndex
                  ? "bg-accent/20 text-text-primary"
                  : "text-text-secondary hover:bg-bg-tertiary"
              }`}
              onMouseDown={(e) => {
                // Prevent textarea blur so focus stays put after selection.
                e.preventDefault();
                applyCommand(cmd);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="text-accent">/{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="text-text-tertiary">{cmd.argumentHint}</span>
              )}
              {cmd.description && (
                <span className="ml-auto text-text-tertiary truncate">
                  {cmd.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 px-3 py-2.5 bg-bg-secondary">
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/20 transition-all font-mono leading-relaxed"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || "Send a message..."}
          disabled={disabled}
          spellCheck={false}
        />
        <button
          className={`shrink-0 h-8 flex items-center justify-center rounded-lg text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            showQueueButton
              ? "bg-amber-500/80 hover:bg-amber-500 px-2.5 gap-1.5"
              : "bg-accent hover:bg-accent-hover w-8"
          }`}
          onClick={() => sendText(text)}
          disabled={disabled || !text.trim()}
          title={showQueueButton ? "Queue (Enter)" : "Send (Enter)"}
        >
          {showQueueButton ? (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 3v3.5l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span className="text-[11px] font-medium">Queue</span>
            </>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 7h12M8 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
