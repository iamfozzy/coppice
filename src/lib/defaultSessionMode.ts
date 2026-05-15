import type { AgentBackend, AppSettings, DefaultSessionMode } from "./types";

export type ResolvedDefaultSessionMode = DefaultSessionMode;

export function resolveDefaultSessionMode(
  settings: Pick<AppSettings, "default_claude_mode" | "agent_backend"> | null | undefined,
): ResolvedDefaultSessionMode {
  const mode = settings?.default_claude_mode;
  if (mode === "terminal" || mode === "claude" || mode === "pi") return mode;
  return settings?.agent_backend === "pi" ? "pi" : "claude";
}

export function getNextDefaultSessionMode(mode: ResolvedDefaultSessionMode): ResolvedDefaultSessionMode {
  if (mode === "terminal") return "claude";
  if (mode === "claude") return "pi";
  return "terminal";
}

export function getDefaultSessionModeLabel(mode: ResolvedDefaultSessionMode): string {
  if (mode === "terminal") return "Claude CLI";
  if (mode === "pi") return "Pi Agent";
  return "Claude SDK";
}

export function getDefaultSessionModeShortLabel(mode: ResolvedDefaultSessionMode): string {
  if (mode === "terminal") return "CLI";
  if (mode === "pi") return "Pi";
  return "Cl";
}

export function isAgentDefaultSessionMode(mode: ResolvedDefaultSessionMode): mode is AgentBackend {
  return mode === "claude" || mode === "pi";
}
