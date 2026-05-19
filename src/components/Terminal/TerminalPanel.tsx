import { useEffect, useRef, useState, type ReactNode } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";

/** Custom DOM events fired by reparenting callers (TileView, RunnerSlot)
 *  on the terminal wrapper so TerminalPanel can dispose its WebGL addon
 *  before the move and re-create it after. WebKit invalidates WebGL
 *  contexts when a canvas's ancestor chain changes, so straddling the
 *  reparent with explicit lifecycle calls is the only reliable way to
 *  avoid the post-move blank-canvas state. */
export const TERMINAL_BEFORE_REPARENT = "coppice:terminal-before-reparent";
export const TERMINAL_AFTER_REPARENT = "coppice:terminal-after-reparent";
import { listen } from "@tauri-apps/api/event";
import { readText as readClipboardText, writeText as writeClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import * as commands from "../../lib/commands";
import { XTERM_THEMES, resolveTheme } from "../../lib/theme";
import { useAppStore } from "../../stores/appStore";
import "@xterm/xterm/css/xterm.css";

const OUTPUT_BUFFER_LIMIT = 1_000_000;
const RESTORED_CLAUDE_SPAWN_SPACING_MS = 2500;
const WEBGL_REATTACH_SPACING_MS = 80;
const sessionOutputBuffers = new Map<string, string>();

let restoredClaudeSpawnQueue: Promise<void> = Promise.resolve();
let lastRestoredClaudeSpawnAt = 0;
let terminalWebglReattachQueue: Promise<void> = Promise.resolve();
let lastTerminalWebglReattachAt = 0;

function waitForIdle(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === "function") {
      ric(() => resolve(), { timeout });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}

function enqueueTerminalWebglReattach(task: () => void): void {
  const run = async () => {
    const elapsed = Date.now() - lastTerminalWebglReattachAt;
    const waitMs = Math.max(0, WEBGL_REATTACH_SPACING_MS - elapsed);
    if (waitMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
    }
    await waitForIdle(500);
    lastTerminalWebglReattachAt = Date.now();
    task();
  };

  terminalWebglReattachQueue = terminalWebglReattachQueue.then(run, run).catch(() => {});
}

function enqueueRestoredClaudeSpawn(task: () => Promise<void>): Promise<void> {
  const run = async () => {
    const elapsed = Date.now() - lastRestoredClaudeSpawnAt;
    const waitMs = Math.max(0, RESTORED_CLAUDE_SPAWN_SPACING_MS - elapsed);
    if (waitMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, waitMs));
    }
    lastRestoredClaudeSpawnAt = Date.now();
    await task();
  };

  const next = restoredClaudeSpawnQueue.then(run, run);
  restoredClaudeSpawnQueue = next.catch(() => {});
  return next;
}

function appendSessionOutput(sessionId: string, output: string) {
  const next = (sessionOutputBuffers.get(sessionId) ?? "") + output;
  sessionOutputBuffers.set(
    sessionId,
    next.length > OUTPUT_BUFFER_LIMIT ? next.slice(next.length - OUTPUT_BUFFER_LIMIT) : next,
  );
}

type ClaudeResumeIndicator = "queued" | "resuming";

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
  /** Ask Claude CLI to continue the latest session when no exact resume id is provided. */
  resumeLatest?: boolean;
  /** Mount xterm but do not spawn the PTY until this flips false. */
  deferSpawn?: boolean;
  /** Queue/stagger the spawn to avoid many restored Claude CLIs starting at once. */
  throttleSpawn?: boolean;
}

export function TerminalPanel({ sessionId, cwd, command, fontSize = 13, fontFamily, keepAlive = false, kind = "terminal", resumeSessionId, resumeLatest = false, deferSpawn = false, throttleSpawn = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [claudeResumeIndicator, setClaudeResumeIndicator] = useState<ClaudeResumeIndicator | null>(null);
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
  // Set when a fit was skipped (because the window was mid-resize or the
  // panel was hidden). Drained on window-resize-end or when the panel
  // transitions to visible — avoids 9 simultaneous SIGWINCH+redraw cascades
  // during a window drag with many Claude CLIs open.
  const needsFitRef = useRef<boolean>(false);
  // Filled in by the main init effect so the window-resize-end listener
  // (mounted in a separate effect) can call the same fit function.
  const doFitRef = useRef<(() => void) | null>(null);
  // Filled in by the main init effect after xterm opens. Restored Claude CLI
  // tabs use this to mount a cheap terminal shell immediately but defer the
  // expensive Claude process until the user views the tab.
  const startSpawnRef = useRef<(() => void) | null>(null);
  const spawnStartedRef = useRef<boolean>(false);
  const deferSpawnRef = useRef<boolean>(deferSpawn);
  // Active WebGL renderer addon, if any. Held in a ref so the reparent
  // lifecycle (see TERMINAL_BEFORE_REPARENT / _AFTER_REPARENT below) can
  // dispose and re-create it without having to thread it through every
  // event handler. `null` means the terminal is on xterm's built-in DOM
  // renderer — either because WebGL hasn't been (re-)attached yet, or
  // because a previous attach failed / lost its context.
  const webglRef = useRef<WebglAddon | null>(null);
  const webglWasActiveBeforeReparentRef = useRef<boolean>(false);
  // True whenever the terminal is not on-screen — either because its tab
  // wrapper is `visibility: hidden` (tab switch) or because it's parked in
  // the runner pool at -9999,-9999. Suspended terminals stop blinking the
  // cursor, hide their renderer surface, and throttle PTY flush on the
  // backend. Read by the ResizeObserver / *-resize-end handlers below so
  // they defer fits while the terminal can't be seen anyway.
  const suspendedRef = useRef<boolean>(false);

  // Keep prop-mirror refs in sync without retriggering the big init effect.
  useEffect(() => {
    keepAliveRef.current = keepAlive;
  }, [keepAlive]);

  useEffect(() => {
    deferSpawnRef.current = deferSpawn;
    if (!deferSpawn) {
      startSpawnRef.current?.();
    }
  }, [deferSpawn]);

  // Suspension state machine. Two detectors run in parallel:
  //   • MutationObserver on the tab-visibility wrapper (catches the
  //     visibility:hidden flip when App.tsx switches tabs).
  //   • IntersectionObserver on the container (catches the runner-pool
  //     case where the wrapper is parked at -9999,-9999 with no visibility
  //     flag, plus reparent-driven viewport transitions).
  // The terminal is suspended whenever either signal reports "not viewable".
  // While suspended we stop the cursor blink and throttle PTY flush on the
  // backend; we deliberately do NOT hide the renderer surface here because
  // the WebGL canvas misbehaves on reparenting if its containing element is
  // visibility:hidden during the move (lost context, blank surface on
  // resume). Hiding for tab switches is already done by App.tsx's wrapper
  // `visibility: hidden`; for the runner pool, -9999,-9999 positioning
  // suffices. On resume we drain any deferred fit and restore focus.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const visibilityTarget = container.parentElement?.parentElement;

    let cssHidden = visibilityTarget?.style.visibility === "hidden";
    let offscreen = false;

    const apply = () => {
      const suspended = cssHidden || offscreen;
      if (suspended === suspendedRef.current) return;
      suspendedRef.current = suspended;

      const term = termInstanceRef.current;
      if (suspended) {
        if (term) term.options.cursorBlink = false;
        commands.terminalSetVisible(sessionId, false).catch(() => {});
      } else {
        if (term) term.options.cursorBlink = true;
        commands.terminalSetVisible(sessionId, true).catch(() => {});
        if (needsFitRef.current) {
          needsFitRef.current = false;
          doFitRef.current?.();
        }
        term?.focus();
      }
    };

    let mo: MutationObserver | null = null;
    if (visibilityTarget) {
      mo = new MutationObserver(() => {
        const newHidden = visibilityTarget.style.visibility === "hidden";
        if (newHidden !== cssHidden) {
          cssHidden = newHidden;
          apply();
        }
      });
      mo.observe(visibilityTarget, { attributes: true, attributeFilter: ["style"] });
    }

    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.target === container) {
          const newOffscreen = !e.isIntersecting;
          if (newOffscreen !== offscreen) {
            offscreen = newOffscreen;
            apply();
          }
        }
      }
    }, { threshold: 0 });
    io.observe(container);

    // Sync initial state in case we mounted into a hidden parent.
    apply();

    return () => {
      mo?.disconnect();
      io.disconnect();
    };
  }, [sessionId]);

  // Resync after a window resize finishes. Focused panel fits immediately
  // so the user sees its layout settle first; other visible panels go
  // through requestIdleCallback (fallback: setTimeout). Suspended panels
  // mark themselves dirty and wait for the suspension state machine above
  // to drain the deferred fit when they become visible again.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWindowResizeEnd = () => {
      if (suspendedRef.current) {
        needsFitRef.current = true;
        return;
      }
      const isFocused = container.contains(document.activeElement);
      needsFitRef.current = false;
      if (isFocused) {
        doFitRef.current?.();
        return;
      }
      const runDeferred = () => {
        // Re-check at fire time — by now the panel may have been suspended
        // (e.g. tile view closed, tab switched). Mark dirty instead so the
        // suspension state machine fits when it's next shown.
        if (suspendedRef.current) {
          needsFitRef.current = true;
          return;
        }
        doFitRef.current?.();
      };
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
      if (typeof ric === "function") {
        ric(runDeferred, { timeout: 200 });
      } else {
        setTimeout(runDeferred, 0);
      }
    };
    window.addEventListener("window-resize-end", onWindowResizeEnd);
    window.addEventListener("tile-toggle-end", onWindowResizeEnd);
    return () => {
      window.removeEventListener("window-resize-end", onWindowResizeEnd);
      window.removeEventListener("tile-toggle-end", onWindowResizeEnd);
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    startSpawnRef.current = null;
    spawnStartedRef.current = false;

    const xtermTheme = XTERM_THEMES[resolveTheme(themeMode)];
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
      // WCAG AA — xterm auto-adjusts foreground luminance when an app
      // requests a fg/bg combo with worse contrast (e.g. Claude CLI tool-call
      // panels painting ANSI white bg over its default light foreground).
      minimumContrastRatio: 4.5,
      // OSC 8 hyperlinks (Claude CLI emits these around clickable references).
      // Without this xterm's default does nothing on click.
      linkHandler: {
        activate: (_event, uri) => { shellOpen(uri); },
      },
    });

    // Unicode support — critical for Claude Code's UI which uses
    // box-drawing chars, emoji, and other wide/combining characters
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    // Plain-text URL detection (regex). Skip on Claude tabs — Claude wraps
    // its clickable references in OSC 8, which the linkHandler above already
    // covers. Loading both providers makes every Claude link open twice.
    if (!isClaude) {
      term.loadAddon(new WebLinksAddon((_event, uri) => {
        shellOpen(uri);
      }));
    }

    termInstanceRef.current = term;

    // WebGL renderer lifecycle. xterm v6 has a built-in DOM renderer; the
    // WebglAddon takes over when loaded and yields back to DOM on dispose.
    // We re-create on context loss (the addon emits onContextLoss when WebKit
    // drops the canvas's GL context — typical triggers: per-process context
    // budget exhaustion at ~16 contexts on macOS, and DOM reparenting).
    // attachWebgl() is idempotent against rapid before/after-reparent pairs:
    // if a previous addon is still present, it's disposed first.
    const attachWebgl = () => {
      if (aborted) return;
      detachWebgl();
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // Drop the dead addon; xterm falls back to DOM until the next
          // attach. Schedule a re-attach on the next frame so the GPU
          // process has a chance to free the lost context first — attaching
          // synchronously inside the loss handler tends to trigger an
          // immediate second loss.
          detachWebgl();
          requestAnimationFrame(() => attachWebgl());
        });
        term.loadAddon(addon);
        webglRef.current = addon;
      } catch {
        // No WebGL support, or per-process context limit reached and the
        // browser refused this allocation. Stay on the DOM renderer; the
        // user sees the same output, just at the DOM renderer's cost.
        webglRef.current = null;
      }
    };
    const detachWebgl = () => {
      const current = webglRef.current;
      if (!current) return;
      webglRef.current = null;
      try { current.dispose(); } catch { /* already disposed */ }
    };

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
      if (event.payload.length > 0) {
        setClaudeResumeIndicator(null);
      }
      term.write(event.payload);
    });

    const unlistenExit = listen(`pty-exit-${sessionId}`, () => {
      setClaudeResumeIndicator(null);
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

    // Send input to backend. Claude CLI activity is tracked via its lifecycle
    // hooks (UserPromptSubmit/Stop) rather than raw Enter keypresses, because
    // startup prompts such as "trust this folder" also use Enter.
    const dataDisposable = term.onData((data) => {
      commands.terminalWrite(sessionId, data).catch(() => {});
    });

    let aborted = false;
    // While suspended (tab hidden or parked in the runner pool), fits are
    // wasted work — defer until the suspension state machine drains
    // needsFitRef on the next visibility transition.
    const isHidden = () => suspendedRef.current;
    const doFit = () => {
      if (aborted) return;
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
    doFitRef.current = doFit;
    const resizeObserver = new ResizeObserver(() => {
      // Skip expensive fit + IPC + PTY redraw while the user is mid-drag,
      // or while we're hidden. We re-sync on the corresponding *-resize-end
      // event (for sidebar/window) or on visibility change (for hidden).
      if (document.body.dataset.resizingSidebar) {
        needsFitRef.current = true;
        return;
      }
      if (document.body.dataset.resizingWindow) {
        needsFitRef.current = true;
        return;
      }
      if (document.body.dataset.resizingTile) {
        needsFitRef.current = true;
        return;
      }
      if (isHidden()) {
        needsFitRef.current = true;
        return;
      }
      doFit();
    });
    const onSidebarResizeEnd = () => {
      if (aborted) return;
      if (isHidden()) {
        needsFitRef.current = true;
        return;
      }
      needsFitRef.current = false;
      doFit();
    };
    window.addEventListener("sidebar-resize-end", onSidebarResizeEnd);

    // Reparent lifecycle. TileView and SidebarRunners physically move the
    // outer wrapper (`<div id="claude-term-…">` / `<div id="runner-term-…">`)
    // through DOM appendChild calls. WebKit invalidates the WebGL context
    // of any canvas whose ancestor chain changes that way, leaving the
    // post-move terminal stuck on a dead context — visually blank until
    // the next forced re-render. The reparenting code dispatches these
    // events on the wrapper bracketing each move so we can dispose the
    // addon before the move and re-create it on the next frame, by which
    // point layout has settled at the new location. Reattach is intentionally
    // queued/staggered: creating several WebGL renderers in the same frame is
    // a noticeable tile-view open/close hitch on WebKit.
    const reparentTarget = container.parentElement?.parentElement;
    const refreshDomRenderer = () => {
      (term as unknown as { refresh?: (start: number, end: number) => void }).refresh?.(0, Math.max(0, term.rows - 1));
    };
    const onBeforeReparent = () => {
      webglWasActiveBeforeReparentRef.current = webglRef.current !== null;
      detachWebgl();
    };
    const onAfterReparent = () => {
      needsFitRef.current = true;
      refreshDomRenderer();
      if (!webglWasActiveBeforeReparentRef.current) return;
      enqueueTerminalWebglReattach(() => {
        if (aborted) return;
        attachWebgl();
      });
    };
    reparentTarget?.addEventListener(TERMINAL_BEFORE_REPARENT, onBeforeReparent);
    reparentTarget?.addEventListener(TERMINAL_AFTER_REPARENT, onAfterReparent);

    // Wait for bundled JetBrains Mono to load before opening the terminal
    // so xterm.js measures character cell widths with the correct font.
    const init = async () => {
      const preloadFont = fontFamily || 'JetBrains Mono';
      await document.fonts.load(`${fontSize}px '${preloadFont}'`).catch(() => {});
      if (aborted) return;

      term.open(container);
      attachWebgl();
      resizeObserver.observe(container);
      fitAddon.fit();

      // Seed the last-sent size so the ResizeObserver's initial-observation
      // callback (which fires once with the same dimensions we're spawning
      // at) is skipped — no redundant ConPTY resize, no scrollback pollution.
      lastSentSizeRef.current = { rows: term.rows, cols: term.cols };

      const focusIfVisible = () => {
        if (!aborted && !suspendedRef.current) term.focus();
      };

      const markStarted = () => {
        if (isClaude) {
          useAppStore.getState().clearCliTabResumeOnLaunch(sessionId);
        }
      };

      const startSpawn = async () => {
        if (aborted || spawnStartedRef.current) return;
        spawnStartedRef.current = true;
        if (isClaude && throttleSpawn) {
          setClaudeResumeIndicator("queued");
        }

        // Re-fit at the actual start time. Deferred restored tabs may have
        // been hidden or moved into tile view since xterm was first opened.
        fitAddon.fit();
        const rows = term.rows > 0 ? term.rows : 24;
        const cols = term.cols > 0 ? term.cols : 80;
        lastSentSizeRef.current = { rows, cols };

        const exists = await commands.terminalExists(sessionId).catch(() => false);
        if (aborted) return;

        if (exists) {
          const bufferedOutput = sessionOutputBuffers.get(sessionId);
          if (bufferedOutput) {
            term.write(bufferedOutput);
            setClaudeResumeIndicator(null);
          }
          commands.terminalResize(sessionId, rows, cols).catch(() => {});
          markStarted();
          focusIfVisible();
          return;
        }

        if (isClaude && !throttleSpawn) {
          setClaudeResumeIndicator("resuming");
        }

        const spawn = async () => {
          if (aborted) return;
          if (isClaude && throttleSpawn) {
            setClaudeResumeIndicator("resuming");
          }
          // If this spawn sat in the restored-Claude queue, the terminal may
          // have been resized or reparented since startSpawn() first ran.
          // Measure again immediately before creating the PTY.
          fitAddon.fit();
          const spawnRows = term.rows > 0 ? term.rows : rows;
          const spawnCols = term.cols > 0 ? term.cols : cols;
          lastSentSizeRef.current = { rows: spawnRows, cols: spawnCols };
          if (isClaude) {
            await commands.terminalSpawnClaude(sessionId, cwd, command, spawnRows, spawnCols, resumeSessionId, resumeLatest);
          } else {
            await commands.terminalSpawn(sessionId, cwd, command, spawnRows, spawnCols);
          }
        };

        const spawnPromise = isClaude && throttleSpawn
          ? enqueueRestoredClaudeSpawn(spawn)
          : spawn();

        spawnPromise
          .then(() => {
            if (aborted) return;
            // Keep the overlay visible after the PTY has spawned; Claude Code
            // can still spend noticeable time loading/resuming before it emits
            // the first bytes. The pty-output listener clears it on first
            // output, which is the point the terminal becomes useful.
            markStarted();
            focusIfVisible();
          })
          .catch((e) => {
            spawnStartedRef.current = false;
            if (!aborted) {
              setClaudeResumeIndicator(null);
              term.write(`\x1b[31mFailed to spawn: ${e}\x1b[0m\r\n`);
            }
          });
      };

      startSpawnRef.current = () => { startSpawn().catch(() => {}); };
      if (!deferSpawnRef.current) {
        startSpawnRef.current();
      }
    };
    init();

    return () => {
      aborted = true;
      resizeObserver.disconnect();
      window.removeEventListener("sidebar-resize-end", onSidebarResizeEnd);
      reparentTarget?.removeEventListener(TERMINAL_BEFORE_REPARENT, onBeforeReparent);
      reparentTarget?.removeEventListener(TERMINAL_AFTER_REPARENT, onAfterReparent);
      detachWebgl();
      dataDisposable.dispose();
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
      doFitRef.current = null;
      startSpawnRef.current = null;
      spawnStartedRef.current = false;
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
    term.options.theme = XTERM_THEMES[resolveTheme(themeMode)];
  }, [themeMode]);

  const menuLeft = contextMenu ? Math.min(contextMenu.x, window.innerWidth - 170) : 0;
  const menuTop = contextMenu ? Math.min(contextMenu.y, window.innerHeight - 140) : 0;
  const claudeResumeIsResume = !!resumeSessionId || resumeLatest;
  const claudeResumeTitle = claudeResumeIsResume ? "Resuming Claude CLI…" : "Starting Claude CLI…";

  const clearClaudeNotification = () => {
    if (isClaude) {
      useAppStore.getState().clearClaudeIdleStatus(sessionId);
    }
  };

  return (
    <>
      <div
        className="bg-bg-primary"
        data-kind={kind}
        onPointerDown={clearClaudeNotification}
        onFocus={clearClaudeNotification}
        style={{
          position: "absolute",
          inset: 0,
          padding: "4px 0 0 8px",
        }}
      >
        {/* Visual padding stays on the outer wrapper. FitAddon only reads
            padding from the .xterm element, so padding on the measured
            parent would clip the last row. */}
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {claudeResumeIndicator && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-bg-primary/85 px-4 text-center backdrop-blur-[1px] pointer-events-none"
            role="status"
            aria-live="polite"
          >
            <div className="flex max-w-xs flex-col items-center gap-2 rounded-lg border border-border-primary bg-bg-secondary/95 px-4 py-3 shadow-xl">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
              <div className="text-[length:var(--app-font-12)] font-medium text-text-primary">{claudeResumeTitle}</div>
            </div>
          </div>
        )}
      </div>
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
