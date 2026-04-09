import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { listen } from "@tauri-apps/api/event";
import * as commands from "../../lib/commands";
import "@xterm/xterm/css/xterm.css";

interface Props {
  sessionId: string;
  cwd: string;
  command?: string;
  fontSize?: number;
  keepAlive?: boolean;
}

export function TerminalPanel({ sessionId, cwd, command, fontSize = 13, keepAlive = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);

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
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Menlo', 'Cascadia Code', monospace",
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
    term.loadAddon(new WebLinksAddon());

    term.open(container);
    termInstanceRef.current = term;

    // Listen for output from backend
    const unlistenOutput = listen<string>(`pty-output-${sessionId}`, (event) => {
      term.write(event.payload);
    });

    const unlistenExit = listen(`pty-exit-${sessionId}`, () => {
      term.write("\r\n\x1b[90m[Process exited]\x1b[0m\r\n");
    });

    // Send input to backend
    const dataDisposable = term.onData((data) => {
      commands.terminalWrite(sessionId, data).catch(() => {});
    });

    // Fit, measure, then spawn (or reconnect if session already exists)
    const spawnTimer = setTimeout(async () => {
      fitAddon.fit();
      const { rows, cols } = term;
      const exists = await commands.terminalExists(sessionId).catch(() => false);
      if (exists) {
        // Session still alive — just resize and focus
        commands.terminalResize(sessionId, rows, cols).catch(() => {});
        term.focus();
      } else {
        commands
          .terminalSpawn(sessionId, cwd, command, rows, cols)
          .then(() => term.focus())
          .catch((e) => {
            term.write(`\x1b[31mFailed to spawn: ${e}\x1b[0m\r\n`);
          });
      }
    }, 100);

    // Observe container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      const { rows, cols } = term;
      if (rows > 0 && cols > 0) {
        commands.terminalResize(sessionId, rows, cols).catch(() => {});
      }
    });
    resizeObserver.observe(container);

    const keepAliveCapture = keepAlive;
    return () => {
      clearTimeout(spawnTimer);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      if (!keepAliveCapture) {
        commands.terminalKill(sessionId).catch(() => {});
      }
      termInstanceRef.current = null;
      term.dispose();
    };
  }, [sessionId, cwd, command]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Extract file paths from the drop
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const paths: string[] = [];
        for (let i = 0; i < files.length; i++) {
          // Electron/Tauri exposes .path on File objects
          const file = files[i] as File & { path?: string };
          if (file.path) {
            paths.push(file.path);
          }
        }
        if (paths.length > 0) {
          // Write file paths into the terminal, space-separated and quoted
          const text = paths.map((p) => `"${p}"`).join(" ");
          commands.terminalWrite(sessionId, text).catch(() => {});
        }
      }
    },
    [sessionId]
  );

  return (
    <div
      ref={containerRef}
      className="bg-bg-primary"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{
        position: "absolute",
        inset: 0,
        padding: "4px 0 0 8px",
      }}
    />
  );
}
