export interface SupportedModel {
  value: string;
  label: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

/** Concrete Claude models supported by the Claude Agent SDK UI. */
export const CLAUDE_MODELS: SupportedModel[] = [
  { value: "claude-opus-4-7", label: "Opus 4.7", provider: "anthropic" },
  { value: "claude-opus-4-6", label: "Opus 4.6", provider: "anthropic" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6", provider: "anthropic" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5", provider: "anthropic" },
];

/** @deprecated Use CLAUDE_MODELS instead. Kept for backward compatibility. */
export const SUPPORTED_MODELS: SupportedModel[] = CLAUDE_MODELS;

/** Returns true if the given model value supports the 1M context beta as an
 *  opt-in. Opus 4.7 is excluded because it has 1M as a native capability —
 *  no toggle / beta header / `[1m]` suffix is required. */
export function modelSupports1MContext(model: string | undefined | null): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return false;
  // Opus 4.7 has native 1M context — no toggle needed.
  if (m.includes("opus-4-7")) return false;
  return (
    m.includes("opus-4-6") ||
    m.includes("sonnet-4-6") ||
    m.includes("opus-4") ||
    m.includes("sonnet-4")
  );
}
