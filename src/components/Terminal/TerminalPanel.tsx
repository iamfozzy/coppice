import { useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { listen } from "@tauri-apps/api/event";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import * as commands from "../../lib/commands";
import { XTERM_DARK, XTERM_DIM, XTERM_ATOM, XTERM_LIGHT, resolveTheme } from "../../lib/theme";
import { useAppStore } from "../../stores/appStore";
import "@xterm/xterm/css/xterm.css";

const OUTPUT_BUFFER_LIMIT = 1_000_000;
const sessionOutputBuffers = new Map<string, string>();

function appendSessionOutput(sessionId: string, output: string) {
  const next = (sessionOutputBuffers.get(sessionId) ?? "") + output;
  sessionOutputBuffers.set(
    sessionId,
    next.length > OUTPUT_BUFFER_LIMIT ? next.slice(next.length - OUTPUT_BUFFER_LIMIT) : next,
  );
}

interface Props {
  sessionId: string;
  cwd: string;
  command?: string;
  fontSize?: number;
  fontFamily?: string;
  keepAlive?: boolean;
  kind?: "terminal" | "claude";
  /** Claude CLI session id captured from hooks; used when restoring a tab after app restart. */
  resumeSessionId?: string;
  /** Restored Claude CLI tab with no exact id — ask Claude CLI to continue the latest session. */
  resumeLatest?: boolean;
}

export function TerminalPanel({ sessionId, cwd, command, fontSize = 13, fontFamily, keepAlive = false, kind = "terminal", resumeSessionId, resumeLatest = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const themeMode = useAppStore((s) => s.appSettings?.theme ?? "dim");
  const isClaude = kind === "claude";
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

    const xtermTheme = { light: XTERM_LIGHT, dim: XTERM_DIM, atom: XTERM_ATOM, dark: XTERM_DARK }[resolveTheme(themeMode)];
    const term = new Terminal({
      theme: xtermTheme,
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
      if (isClaude && e.type === "keydown" && e.key === "Enter" && e.shiftKey) {
        // Claude Code treats Ctrl+J/LF as the portable multiline newline
        // shortcut. WebView/xterm stacks do not reliably emit distinct
        // Shift+Enter sequences, so normalize it here for CLI tabs.
        commands.terminalWrite(sessionId, "\n").catch(() => {});
        e.preventDefault();
        return false;
      }

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
          writeClipboardText(cleaned).catch(() => navigator.clipboard.writeText(cleaned).catch(() => {}));
          e.preventDefault();
          return false;
        }

        // Fallback: internal selection service shape changed — copy raw selection.
        writeClipboardText(selection).catch(() => navigator.clipboard.writeText(selection).catch(() => {}));
        e.preventDefault();
        return false;
      }
      return true;
    });

    const bellDisposable = term.onBell(() => {
      if (isClaude) {
        useAppStore.getState().setClaudeStatus(sessionId, "idle");
      }
    });

    const osc9Disposable = term.parser.registerOscHandler(9, (data) => {
      // iTerm2/ConEmu progress convention: OSC 9;4;state;percent BEL.
      // state 0 clears; state 1/3 are normal/indeterminate; 2/4 are error/warn.
      if (!data.startsWith("4;")) return false;
      const [, stateRaw, progressRaw] = data.split(";");
      const state = Number(stateRaw);
      const progress = Number(progressRaw);
      if (state === 0 || !Number.isFinite(progress)) {
        useAppStore.getState().setTerminalProgress(sessionId, null);
      } else {
        useAppStore.getState().setTerminalProgress(sessionId, progress);
      }
      return true;
    });

    const writePastedText = (text: string) => {
      const normalized = text.replace(/\r\n/g, "\n");
      const payload = isClaude ? `\x1b[200~${normalized}\x1b[201~` : normalized;
      commands.terminalWrite(sessionId, payload).catch(() => {});
    };

    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData("text/plain");
      if (!text) return;
      // Capture and stop the paste before xterm's own textarea handler sees it;
      // otherwise Ctrl/Cmd+V is written once by us (for bracketed paste) and
      // once by xterm's default paste path.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      writePastedText(text);
    };
    container.addEventListener("paste", onPaste, true);

    const onContextMenu = (e: MouseEvent) => {
      // Same capture-phase stop: prevents the WebView/OS default text-area
      // context menu from appearing on top of Coppice's terminal menu.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setContextMenu({ x: e.clientX, y: e.clientY });
    };
    container.addEventListener("contextmenu", onContextMenu, true);

    // Listen for output from backend
    const unlistenOutput = listen<string>(`pty-output-${sessionId}`, (event) => {
      appendSessionOutput(sessionId, event.payload);
      term.write(event.payload);
    });

    const unlistenExit = listen(`pty-exit-${sessionId}`, () => {
      const exitMessage = "\r\n\x1b[90m[Process exited]\x1b[0m\r\n";
      appendSessionOutput(sessionId, exitMessage);
      term.write(exitMessage);
    });

    // Clear terminal buffer when a runner is restarted
    const onClear = (e: Event) => {
      if ((e as CustomEvent).detail === sessionId) {
        sessionOutputBuffers.delete(sessionId);
        term.reset();
      }
    };
    window.addEventListener("terminal-clear", onClear);

    // Send input to backend
    const dataDisposable = term.onData((data) => {
      if (isClaude && data.includes("\r")) {
        useAppStore.getState().setClaudeStatus(sessionId, "active");
      }
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
        const bufferedOutput = sessionOutputBuffers.get(sessionId);
        if (bufferedOutput) term.write(bufferedOutput);
        commands.terminalResize(sessionId, rows, cols).catch(() => {});
        term.focus();
      } else {
        const spawnPromise = isClaude
          ? commands.terminalSpawnClaude(sessionId, cwd, command, rows, cols, resumeSessionId, resumeLatest)
          : commands.terminalSpawn(sessionId, cwd, command, rows, cols);
        spawnPromise
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
      bellDisposable.dispose();
      osc9Disposable.dispose();
      container.removeEventListener("paste", onPaste, true);
      container.removeEventListener("contextmenu", onContextMenu, true);
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
  }, [sessionId, cwd, command, fontFamily, fontSize, isClaude]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [contextMenu]);

  const writeClipboardToTerminal = async () => {
    const text = await readClipboardText().catch(() => navigator.clipboard.readText().catch(() => ""));
    if (!text) return;
    const normalized = text.replace(/\r\n/g, "\n");
    const payload = isClaude ? `\x1b[200~${normalized}\x1b[201~` : normalized;
    commands.terminalWrite(sessionId, payload).catch(() => {});
  };

  // Live-update xterm theme without re-creating the terminal
  useEffect(() => {
    const term = termInstanceRef.current;
    if (!term) return;
    term.options.theme = { light: XTERM_LIGHT, dim: XTERM_DIM, atom: XTERM_ATOM, dark: XTERM_DARK }[resolveTheme(themeMode)];
  }, [themeMode]);

  const menuLeft = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 170) : 0;
  const menuTop = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 140) : 0;

  const clearClaudeNotification = () => {
    if (isClaude) {
      useAppStore.getState().clearClaudeIdleStatus(sessionId);
    }
  };

  return (
    <>
      <div
        ref={containerRef}
        className="bg-bg-primary"
        onPointerDown={clearClaudeNotification}
        onFocus={clearClaudeNotification}
        style={{
          position: "absolute",
          inset: 0,
          padding: "4px 0 0 8px",
        }}
      />
      {contextMenu && (
        <div
          className="fixed z-[9999] min-w-40 rounded-md border border-border-primary bg-bg-secondary py-1 shadow-xl text-[length:var(--app-font-11)]"
          style={{ left: menuLeft, top: menuTop }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <TerminalMenuItem onClick={() => {
            const term = termInstanceRef.current;
            const selection = term?.getSelection();
            if (selection) writeClipboardText(selection).catch(() => navigator.clipboard.writeText(selection).catch(() => {}));
            setContextMenu(null);
          }}>Copy</TerminalMenuItem>
          <TerminalMenuItem onClick={() => { writeClipboardToTerminal(); setContextMenu(null); }}>Paste</TerminalMenuItem>
          <TerminalMenuItem onClick={() => { termInstanceRef.current?.selectAll(); setContextMenu(null); }}>Select all</TerminalMenuItem>
          <div className="my-1 border-t border-border-primary" />
          <TerminalMenuItem onClick={() => { termInstanceRef.current?.clear(); setContextMenu(null); }}>Clear scrollback</TerminalMenuItem>
        </div>
      )}
    </>
  );
}

function TerminalMenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="block w-full px-3 py-1.5 text-left text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
