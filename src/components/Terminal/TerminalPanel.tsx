import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import * as commands from "../../lib/commands";
import { useAppStore } from "../../stores/appStore";
import "@xterm/xterm/css/xterm.css";

const CLAUDE_IDLE_THRESHOLD_MS = 3000;
// Grace period after spawn — ignore all activity during startup so the
// welcome banner + initial prompt don't trigger a false notification.
const CLAUDE_STARTUP_GRACE_MS = 8000;

interface Props {
  sessionId: string;
  cwd: string;
  command?: string;
  fontSize?: number;
  fontFamily?: string;
  keepAlive?: boolean;
  isClaudeTab?: boolean;
}

// Minimum bytes of output within the activity window to count as genuinely active.
// Prevents tab switches or cursor repositions from triggering false "active" state.
const CLAUDE_ACTIVE_BYTE_THRESHOLD = 200;
// How long the activity byte counter accumulates before resetting.
const CLAUDE_ACTIVITY_WINDOW_MS = 2000;

export function TerminalPanel({ sessionId, cwd, command, fontSize = 13, fontFamily, keepAlive = false, isClaudeTab = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const lastOutputRef = useRef<number>(0);
  const claudeStatusRef = useRef<"active" | "idle" | null>(null);
  const outputBytesRef = useRef<number>(0);
  const activityWindowStartRef = useRef<number>(0);
  // Ignore startup output — the first idle after spawn is always Claude's
  // welcome banner settling, not a real active→idle transition.
  const spawnedAtRef = useRef<number>(0);

  // Focus terminal when the parent visibility changes (tab switching)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new MutationObserver(() => {
      if (container.parentElement?.style.visibility !== "hidden" && termInstanceRef.current) {
        termInstanceRef.current.focus();
      }
    });
    if (container.parentElement) {
      observer.observe(container.parentElement, { attributes: true, attributeFilter: ["style"] });
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: {
        background: "#0a0a0b",
        foreground: "#e4e4e7",
        cursor: "#e4e4e7",
        selectionBackground: "#6366f150",
        black: "#0a0a0b",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#6366f1",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#e4e4e7",
        brightBlack: "#71717a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#fde047",
        brightBlue: "#818cf8",
        brightMagenta: "#c084fc",
        brightCyan: "#22d3ee",
        brightWhite: "#fafafa",
      },
      fontFamily: fontFamily
        ? `'${fontFamily}', 'JetBrains Mono', monospace`
        : "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Menlo', 'DejaVu Sans Mono', monospace",
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    });

    // Unicode support — critical for Claude Code's UI which uses
    // box-drawing chars, emoji, and other wide/combining characters
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      shellOpen(uri);
    }));

    termInstanceRef.current = term;

    // Custom copy handler: strip newlines that xterm.js inserts between
    // soft-wrapped rows, so copying a wrapped long line yields one line.
    // We must preserve column boundaries — use term.getSelection() (which
    // already respects them) and only post-process wrapped-row joins.
    term.attachCustomKeyEventHandler((e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && term.hasSelection()) {
        const buffer = term.buffer.active;

        const selRange = (term as unknown as { _core: { _selectionService: { selectionStart: [number, number] | undefined; selectionEnd: [number, number] | undefined } } })
          ?._core?._selectionService;

        const selection = term.getSelection();
        if (!selection) return true;

        if (selRange?.selectionStart && selRange?.selectionEnd) {
          const startRow = selRange.selectionStart[1];
          const selLines = selection.split("\n");
          const lines: string[] = [];

          for (let idx = 0; idx < selLines.length; idx++) {
            const rowIdx = startRow + idx;
            const line = buffer.getLine(rowIdx);
            // Only rows beyond the first can be "wrapped" (wrapped === continuation of prior row)
            const isWrapped = idx > 0 && !!line?.isWrapped;

            if (isWrapped && lines.length > 0) {
              lines[lines.length - 1] += selLines[idx];
            } else {
              lines.push(selLines[idx]);
            }
          }

          const cleaned = lines.join("\n");
          navigator.clipboard.writeText(cleaned);
          e.preventDefault();
          return false;
        }

        // Fallback: internal selection service shape changed — copy raw selection.
        navigator.clipboard.writeText(selection);
        e.preventDefault();
        return false;
      }
      return true;
    });

    // Listen for output from backend
    spawnedAtRef.current = Date.now();
    const unlistenOutput = listen<string>(`pty-output-${sessionId}`, (event) => {
      term.write(event.payload);
      if (isClaudeTab) {
        const now = Date.now();
        lastOutputRef.current = now;

        // Ignore startup output — Claude's welcome banner and initial prompt
        // render would otherwise look like an active→idle transition.
        if (now - spawnedAtRef.current < CLAUDE_STARTUP_GRACE_MS) return;

        // Track output volume within a rolling window. Only transition to
        // "active" once we've seen enough bytes — small blips from cursor
        // moves, status-line refreshes, or tab-switch reflows are ignored.
        if (now - activityWindowStartRef.current > CLAUDE_ACTIVITY_WINDOW_MS) {
          outputBytesRef.current = 0;
          activityWindowStartRef.current = now;
        }
        outputBytesRef.current += event.payload.length;

        if (
          claudeStatusRef.current !== "active" &&
          outputBytesRef.current >= CLAUDE_ACTIVE_BYTE_THRESHOLD
        ) {
          claudeStatusRef.current = "active";
          useAppStore.getState().setClaudeStatus(sessionId, "active");
        }
      }
    });

    const unlistenExit = listen(`pty-exit-${sessionId}`, () => {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
      if (isClaudeTab) {
        claudeStatusRef.current = null;
        useAppStore.getState().removeClaudeStatus(sessionId);
      }
    });

    // Idle detection for Claude tabs
    let idleInterval: ReturnType<typeof setInterval> | null = null;
    if (isClaudeTab) {
      idleInterval = setInterval(() => {
        if (
          lastOutputRef.current > 0 &&
          Date.now() - lastOutputRef.current > CLAUDE_IDLE_THRESHOLD_MS &&
          claudeStatusRef.current === "active"
        ) {
          claudeStatusRef.current = "idle";
          outputBytesRef.current = 0;
          useAppStore.getState().setClaudeStatus(sessionId, "idle");
        }
      }, 1000);
    }

    // Send input to backend
    const dataDisposable = term.onData((data) => {
      commands.terminalWrite(sessionId, data).catch(() => {});
    });

    let aborted = false;
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const { rows, cols } = term;
      if (rows > 0 && cols > 0) {
        commands.terminalResize(sessionId, rows, cols).catch(() => {});
      }
    });

    // Wait for bundled JetBrains Mono to load before opening the terminal
    // so xterm.js measures character cell widths with the correct font.
    const init = async () => {
      const preloadFont = fontFamily || 'JetBrains Mono';
      await document.fonts.load(`${fontSize}px '${preloadFont}'`).catch(() => {});
      if (aborted) return;

      term.open(container);
      resizeObserver.observe(container);
      fitAddon.fit();

      const { rows, cols } = term;
      const exists = await commands.terminalExists(sessionId).catch(() => false);
      if (aborted) return;

      if (exists) {
        commands.terminalResize(sessionId, rows, cols).catch(() => {});
        term.focus();
      } else {
        commands
          .terminalSpawn(sessionId, cwd, command, rows, cols)
          .then(() => { if (!aborted) term.focus(); })
          .catch((e) => {
            term.write(`\x1b[31mFailed to spawn: ${e}\x1b[0m\r\n`);
          });
      }
    };
    init();

    const keepAliveCapture = keepAlive;
    return () => {
      aborted = true;
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      if (idleInterval) clearInterval(idleInterval);
      if (!keepAliveCapture) {
        commands.terminalKill(sessionId).catch(() => {});
      }
      termInstanceRef.current = null;
      term.dispose();
    };
  }, [sessionId, cwd, command, fontFamily, fontSize]);


  return (
    <div
      ref={containerRef}
      className="bg-bg-primary"
      style={{
        position: "absolute",
        inset: 0,
        padding: "4px 0 0 8px",
      }}
    />
  );
}
