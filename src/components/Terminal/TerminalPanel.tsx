import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { listen } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import * as commands from "../../lib/commands";
import "@xterm/xterm/css/xterm.css";

interface Props {
  sessionId: string;
  cwd: string;
  command?: string;
  fontSize?: number;
  fontFamily?: string;
  keepAlive?: boolean;
}

export function TerminalPanel({ sessionId, cwd, command, fontSize = 13, fontFamily, keepAlive = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  // Mirror props that are read inside the long-lived PTY-output listener
  // into refs. Keeps the main effect's dep array tight (so we don't tear
  // down the terminal when these change) while still letting changes take
  // effect mid-session.
  const keepAliveRef = useRef<boolean>(keepAlive);
  // Last dimensions sent to the backend. On Windows, ConPTY re-emits the
  // visible screen as VT sequences on every resize — those replays land in
  // xterm's scrollback and look like duplicate content (e.g. Claude's
  // welcome banner appearing multiple times when scrolling up). Guarding on
  // "actually changed" prevents spurious ResizeObserver fires (initial
  // observation, font-load layout, etc.) from triggering ConPTY redraws.
  const lastSentSizeRef = useRef<{ rows: number; cols: number } | null>(null);

  // Keep prop-mirror refs in sync without retriggering the big init effect.
  useEffect(() => {
    keepAliveRef.current = keepAlive;
  }, [keepAlive]);

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
    const unlistenOutput = listen<string>(`pty-output-${sessionId}`, (event) => {
      term.write(event.payload);
    });

    const unlistenExit = listen(`pty-exit-${sessionId}`, () => {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
    });

    // Clear terminal buffer when a runner is restarted
    const onClear = (e: Event) => {
      if ((e as CustomEvent).detail === sessionId) {
        term.reset();
      }
    };
    window.addEventListener("terminal-clear", onClear);

    // Send input to backend
    const dataDisposable = term.onData((data) => {
      commands.terminalWrite(sessionId, data).catch(() => {});
    });

    let aborted = false;
    const doFit = () => {
      fitAddon.fit();
      const { rows, cols } = term;
      if (rows > 0 && cols > 0) {
        const last = lastSentSizeRef.current;
        if (last && last.rows === rows && last.cols === cols) {
          // Size unchanged — skip the IPC. On Windows this matters: ConPTY
          // treats every resize as a reason to replay its screen buffer,
          // and those replays pollute xterm's scrollback.
          return;
        }
        lastSentSizeRef.current = { rows, cols };
        commands.terminalResize(sessionId, rows, cols).catch(() => {});
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      // Skip expensive fit + IPC while the sidebar is mid-drag. We re-sync
      // once on "sidebar-resize-end" so the drag itself stays smooth.
      if (document.body.dataset.resizingSidebar) return;
      doFit();
    });
    const onSidebarResizeEnd = () => {
      if (aborted) return;
      doFit();
    };
    window.addEventListener("sidebar-resize-end", onSidebarResizeEnd);

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

      // Seed the last-sent size so the ResizeObserver's initial-observation
      // callback (which fires once with the same dimensions we're spawning
      // at) is skipped — no redundant ConPTY resize, no scrollback pollution.
      lastSentSizeRef.current = { rows, cols };

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

    return () => {
      aborted = true;
      resizeObserver.disconnect();
      window.removeEventListener("sidebar-resize-end", onSidebarResizeEnd);
      dataDisposable.dispose();
      window.removeEventListener("terminal-clear", onClear);
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      // Read keepAlive from the ref so a late prop flip (tab being retired)
      // is honored at teardown time, not at effect-start time.
      if (!keepAliveRef.current) {
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
