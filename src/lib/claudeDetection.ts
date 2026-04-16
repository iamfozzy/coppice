// Centralized constants for Claude idle detection heuristics.
// Tunable from a single location. These are only used by the heuristic
// path — when Claude Code hooks are installed, idle detection is
// deterministic and these thresholds are bypassed.

/** After this many ms of silence, an "active" tab transitions to "idle". */
export const CLAUDE_IDLE_THRESHOLD_MS = 3000;

/**
 * Grace period after Claude's first PTY output. Ignore all activity during
 * this window so the welcome banner + initial prompt don't trigger a false
 * notification. Measured from the first byte of output (not component mount).
 */
export const CLAUDE_STARTUP_GRACE_MS = 8000;

/**
 * Minimum bytes of output within CLAUDE_ACTIVITY_WINDOW_MS to count as
 * genuinely active. Low enough that short replies (e.g. "Done.") plus the
 * prompt-box redraw still clear it.
 */
export const CLAUDE_ACTIVE_BYTE_THRESHOLD = 40;

/** Rolling window for accumulating bytes toward the active threshold. */
export const CLAUDE_ACTIVITY_WINDOW_MS = 2000;

/**
 * After a PTY resize (SIGWINCH), Claude redraws its full UI. Ignore output
 * for this many ms so background tabs don't flip "active→idle" when
 * window/sidebar resizes ripple through every mounted terminal.
 */
export const CLAUDE_RESIZE_GRACE_MS = 3000;
