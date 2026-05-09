import type { AgentBackend, SlashCommand } from "./types";

/**
 * Fallback slash command list shown before the Claude SDK session starts.
 * Once the bridge init event arrives, this is replaced by the real list
 * from `query.supportedCommands()`, which includes project-level commands
 * from `.claude/commands/*.md` with their real descriptions and arg hints.
 */
export const DEFAULT_CLAUDE_SLASH_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "Start a new conversation", argumentHint: "" },
  { name: "compact", description: "Compact the conversation history", argumentHint: "[instructions]" },
  { name: "context", description: "Show context usage", argumentHint: "" },
  { name: "cost", description: "Show token usage and cost", argumentHint: "" },
  { name: "help", description: "Show available commands", argumentHint: "" },
  { name: "init", description: "Initialize a CLAUDE.md for this repo", argumentHint: "" },
  { name: "model", description: "Change the model", argumentHint: "[model]" },
  { name: "review", description: "Review a pull request", argumentHint: "[pr]" },
  { name: "status", description: "Show session status", argumentHint: "" },
];

/**
 * Fallback slash command list shown before the Pi SDK session starts.
 * Pi only exposes a subset of builtins that make sense in a GUI IDE.
 * Prompt templates from .pi/prompts/ are added once the bridge starts.
 */
export const DEFAULT_PI_SLASH_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compact the conversation history", argumentHint: "[instructions]" },
  { name: "model", description: "Change the model", argumentHint: "[model]" },
  { name: "session", description: "Show session info and stats", argumentHint: "" },
];

/** Get the appropriate default slash commands for the given backend. */
export function getDefaultSlashCommands(backend: AgentBackend): SlashCommand[] {
  return backend === "pi" ? DEFAULT_PI_SLASH_COMMANDS : DEFAULT_CLAUDE_SLASH_COMMANDS;
}

/** @deprecated Use getDefaultSlashCommands(backend) instead. */
export const DEFAULT_SLASH_COMMANDS = DEFAULT_CLAUDE_SLASH_COMMANDS;
