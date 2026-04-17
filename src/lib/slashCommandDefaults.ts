import type { SlashCommand } from "./types";

/**
 * Fallback slash command list shown before the SDK session starts.
 * Once the bridge init event arrives, this is replaced by the real list
 * from `query.supportedCommands()`, which includes project-level commands
 * from `.claude/commands/*.md` with their real descriptions and arg hints.
 */
export const DEFAULT_SLASH_COMMANDS: SlashCommand[] = [
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
