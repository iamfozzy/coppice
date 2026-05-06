import type { ThemeMode } from "./types";

/** Resolve "system" to the actual theme based on OS preference. */
export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

/** Apply the resolved theme to the document root. */
export function applyTheme(mode: ThemeMode): void {
  const resolved = resolveTheme(mode);
  document.documentElement.setAttribute("data-theme", resolved);
}

// ── xterm theme palettes ──

export const XTERM_DARK = {
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
};

export const XTERM_LIGHT = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#18181b",
  selectionBackground: "#4f46e530",
  black: "#18181b",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#4f46e5",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#f5f5f7",
  brightBlack: "#a1a1aa",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#6366f1",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#ffffff",
};

// ── Monaco editor theme definitions ──

export const MONACO_DARK_RULES = [
  { token: "comment", foreground: "5c6370", fontStyle: "italic" },
  { token: "keyword", foreground: "c678dd" },
  { token: "keyword.control", foreground: "c678dd" },
  { token: "storage.type", foreground: "c678dd" },
  { token: "string", foreground: "98c379" },
  { token: "string.escape", foreground: "56b6c2" },
  { token: "number", foreground: "d19a66" },
  { token: "constant", foreground: "d19a66" },
  { token: "type", foreground: "e5c07b" },
  { token: "type.identifier", foreground: "e5c07b" },
  { token: "identifier", foreground: "e06c75" },
  { token: "variable", foreground: "e06c75" },
  { token: "variable.predefined", foreground: "e06c75" },
  { token: "function", foreground: "61afef" },
  { token: "tag", foreground: "e06c75" },
  { token: "attribute.name", foreground: "d19a66" },
  { token: "attribute.value", foreground: "98c379" },
  { token: "delimiter", foreground: "abb2bf" },
  { token: "delimiter.bracket", foreground: "abb2bf" },
  { token: "operator", foreground: "56b6c2" },
  { token: "regexp", foreground: "98c379" },
];

export const MONACO_DARK_COLORS = {
  "editor.background": "#0a0a0b",
  "editor.foreground": "#abb2bf",
  "editorLineNumber.foreground": "#495162",
  "editorLineNumber.activeForeground": "#abb2bf",
  "editor.selectionBackground": "#3e4451",
  "editor.lineHighlightBackground": "#1a1a1e",
  "editorCursor.foreground": "#528bff",
  "editorGutter.addedBackground": "#98c37980",
  "editorGutter.modifiedBackground": "#e5c07b80",
  "editorGutter.deletedBackground": "#e06c7580",
  "diffEditor.insertedTextBackground": "#98c37930",
  "diffEditor.removedTextBackground": "#e06c7530",
  "diffEditor.insertedLineBackground": "#98c37920",
  "diffEditor.removedLineBackground": "#e06c7520",
};

export const MONACO_LIGHT_RULES = [
  { token: "comment", foreground: "6a737d", fontStyle: "italic" },
  { token: "keyword", foreground: "d73a49" },
  { token: "keyword.control", foreground: "d73a49" },
  { token: "storage.type", foreground: "d73a49" },
  { token: "string", foreground: "22863a" },
  { token: "string.escape", foreground: "005cc5" },
  { token: "number", foreground: "005cc5" },
  { token: "constant", foreground: "005cc5" },
  { token: "type", foreground: "e36209" },
  { token: "type.identifier", foreground: "e36209" },
  { token: "identifier", foreground: "24292e" },
  { token: "variable", foreground: "24292e" },
  { token: "variable.predefined", foreground: "005cc5" },
  { token: "function", foreground: "6f42c1" },
  { token: "tag", foreground: "22863a" },
  { token: "attribute.name", foreground: "6f42c1" },
  { token: "attribute.value", foreground: "032f62" },
  { token: "delimiter", foreground: "24292e" },
  { token: "delimiter.bracket", foreground: "24292e" },
  { token: "operator", foreground: "d73a49" },
  { token: "regexp", foreground: "032f62" },
];

export const MONACO_LIGHT_COLORS = {
  "editor.background": "#ffffff",
  "editor.foreground": "#24292e",
  "editorLineNumber.foreground": "#babbbc",
  "editorLineNumber.activeForeground": "#24292e",
  "editor.selectionBackground": "#c8d6f8",
  "editor.lineHighlightBackground": "#f5f5f7",
  "editorCursor.foreground": "#4f46e5",
  "editorGutter.addedBackground": "#22863a80",
  "editorGutter.modifiedBackground": "#e3680980",
  "editorGutter.deletedBackground": "#d73a4980",
  "diffEditor.insertedTextBackground": "#22863a20",
  "diffEditor.removedTextBackground": "#d73a4920",
  "diffEditor.insertedLineBackground": "#22863a10",
  "diffEditor.removedLineBackground": "#d73a4910",
};
