import type { ThemeMode } from "./types";

export type ConcreteThemeMode = Exclude<ThemeMode, "system">;

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; hint: string }> = [
  { value: "system", label: "System", hint: "Follows your OS appearance setting" },
  { value: "dark", label: "Dark", hint: "Coppice dark" },
  { value: "dim", label: "Dim", hint: "Soft slate dark" },
  { value: "atom", label: "Atom One", hint: "Atom One Dark" },
  { value: "github", label: "GitHub Dark", hint: "GitHub-inspired dark" },
  { value: "tokyo", label: "Tokyo Night", hint: "Modern blue night palette" },
  { value: "catppuccin", label: "Catppuccin", hint: "Mocha-inspired pastel dark" },
  { value: "dracula", label: "Dracula", hint: "Classic purple dark" },
  { value: "nord", label: "Nord", hint: "Arctic blue-gray" },
  { value: "gruvbox", label: "Gruvbox", hint: "Warm retro dark" },
  { value: "solarized", label: "Solarized Dark", hint: "Low-contrast solarized dark" },
  { value: "solarized-light", label: "Solarized Light", hint: "Low-contrast solarized light" },
  { value: "light", label: "Light", hint: "Coppice light" },
];

/** Resolve "system" to the actual theme based on OS preference. */
export function resolveTheme(mode: ThemeMode): ConcreteThemeMode {
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

export function getMonacoThemeName(mode: ThemeMode): string {
  return `coppice-${resolveTheme(mode)}`;
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
  // Mid-tone instead of near-white: apps that fill panels with ANSI white bg
  // (e.g. Claude CLI tool-call expansions) render as a subtle elevated panel
  // rather than a bright slab. minimumContrastRatio rescales any fg that
  // becomes unreadable against this darker shade.
  white: "#3f3f46",
  brightBlack: "#71717a",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fde047",
  brightBlue: "#818cf8",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#fafafa",
};

export const XTERM_DIM = {
  background: "#171921",
  foreground: "#dfe1e8",
  cursor: "#dfe1e8",
  selectionBackground: "#6366f150",
  black: "#171921",
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#eab308",
  blue: "#6366f1",
  magenta: "#a855f7",
  cyan: "#06b6d4",
  white: "#3a3d4d",
  brightBlack: "#646882",
  brightRed: "#f87171",
  brightGreen: "#4ade80",
  brightYellow: "#fde047",
  brightBlue: "#818cf8",
  brightMagenta: "#c084fc",
  brightCyan: "#22d3ee",
  brightWhite: "#f0f1f5",
};

export const XTERM_ATOM = {
  background: "#1e2127",
  foreground: "#d4d8e0",
  cursor: "#528bff",
  selectionBackground: "#3e445180",
  black: "#1e2127",
  red: "#e86671",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#d4d8e0",
  brightBlack: "#5c6370",
  brightRed: "#f07178",
  brightGreen: "#a9d488",
  brightYellow: "#f0d07e",
  brightBlue: "#74baf7",
  brightMagenta: "#d07ef7",
  brightCyan: "#68d8d6",
  brightWhite: "#e8eaf0",
};

export const XTERM_GITHUB = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#2f81f7",
  selectionBackground: "#264f7850",
  black: "#0d1117",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

export const XTERM_TOKYO = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#7aa2f7",
  selectionBackground: "#33467c80",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff899d",
  brightGreen: "#9fe044",
  brightYellow: "#faba4a",
  brightBlue: "#8db0ff",
  brightMagenta: "#c7a9ff",
  brightCyan: "#a4daff",
  brightWhite: "#c0caf5",
};

export const XTERM_CATPPUCCIN = {
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  cursor: "#f5e0dc",
  selectionBackground: "#585b7080",
  black: "#181825",
  red: "#f38ba8",
  green: "#a6e3a1",
  yellow: "#f9e2af",
  blue: "#89b4fa",
  magenta: "#cba6f7",
  cyan: "#94e2d5",
  white: "#bac2de",
  brightBlack: "#6c7086",
  brightRed: "#eba0ac",
  brightGreen: "#a6e3a1",
  brightYellow: "#f9e2af",
  brightBlue: "#89b4fa",
  brightMagenta: "#f5c2e7",
  brightCyan: "#94e2d5",
  brightWhite: "#cdd6f4",
};

export const XTERM_DRACULA = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  selectionBackground: "#44475a80",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#8be9fd",
  magenta: "#bd93f9",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

export const XTERM_NORD = {
  background: "#2e3440",
  foreground: "#eceff4",
  cursor: "#88c0d0",
  selectionBackground: "#4c566a80",
  black: "#2e3440",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#d08770",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

export const XTERM_GRUVBOX = {
  background: "#282828",
  foreground: "#ebdbb2",
  cursor: "#ebdbb2",
  selectionBackground: "#50494580",
  black: "#282828",
  red: "#cc241d",
  green: "#98971a",
  yellow: "#d79921",
  blue: "#458588",
  magenta: "#b16286",
  cyan: "#689d6a",
  white: "#a89984",
  brightBlack: "#928374",
  brightRed: "#fb4934",
  brightGreen: "#b8bb26",
  brightYellow: "#fabd2f",
  brightBlue: "#83a598",
  brightMagenta: "#d3869b",
  brightCyan: "#8ec07c",
  brightWhite: "#ebdbb2",
};

export const XTERM_SOLARIZED = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#93a1a1",
  selectionBackground: "#07364280",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

export const XTERM_SOLARIZED_LIGHT = {
  background: "#fdf6e3",
  foreground: "#073642",
  cursor: "#268bd2",
  selectionBackground: "#93a1a150",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

export const XTERM_LIGHT = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#18181b",
  selectionBackground: "#4f46e530",
  black: "#18181b",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#4338ca",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#52525b",
  brightBlack: "#6b7280",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#b45309",
  brightBlue: "#4f46e5",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#27272a",
};

export const XTERM_THEMES: Record<ConcreteThemeMode, typeof XTERM_DARK> = {
  dark: XTERM_DARK,
  dim: XTERM_DIM,
  atom: XTERM_ATOM,
  github: XTERM_GITHUB,
  tokyo: XTERM_TOKYO,
  catppuccin: XTERM_CATPPUCCIN,
  dracula: XTERM_DRACULA,
  nord: XTERM_NORD,
  gruvbox: XTERM_GRUVBOX,
  solarized: XTERM_SOLARIZED,
  "solarized-light": XTERM_SOLARIZED_LIGHT,
  light: XTERM_LIGHT,
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

function monacoColors({
  background,
  foreground,
  lineNumber,
  activeLineNumber,
  selection,
  lineHighlight,
  cursor,
  added,
  modified,
  deleted,
}: {
  background: string;
  foreground: string;
  lineNumber: string;
  activeLineNumber: string;
  selection: string;
  lineHighlight: string;
  cursor: string;
  added: string;
  modified: string;
  deleted: string;
}) {
  return {
    "editor.background": background,
    "editor.foreground": foreground,
    "editorLineNumber.foreground": lineNumber,
    "editorLineNumber.activeForeground": activeLineNumber,
    "editor.selectionBackground": selection,
    "editor.lineHighlightBackground": lineHighlight,
    "editorCursor.foreground": cursor,
    "editorGutter.addedBackground": `${added}80`,
    "editorGutter.modifiedBackground": `${modified}80`,
    "editorGutter.deletedBackground": `${deleted}80`,
    "diffEditor.insertedTextBackground": `${added}30`,
    "diffEditor.removedTextBackground": `${deleted}30`,
    "diffEditor.insertedLineBackground": `${added}20`,
    "diffEditor.removedLineBackground": `${deleted}20`,
  };
}

export const MONACO_DARK_COLORS = monacoColors({
  background: "#0a0a0b",
  foreground: "#abb2bf",
  lineNumber: "#495162",
  activeLineNumber: "#abb2bf",
  selection: "#3e4451",
  lineHighlight: "#1a1a1e",
  cursor: "#528bff",
  added: "#98c379",
  modified: "#e5c07b",
  deleted: "#e06c75",
});

export const MONACO_DIM_COLORS = monacoColors({
  background: "#171921",
  foreground: "#abb2bf",
  lineNumber: "#4a5068",
  activeLineNumber: "#abb2bf",
  selection: "#3e4460",
  lineHighlight: "#1e2029",
  cursor: "#528bff",
  added: "#98c379",
  modified: "#e5c07b",
  deleted: "#e06c75",
});

export const MONACO_ATOM_COLORS = monacoColors({
  background: "#1e2127",
  foreground: "#abb2bf",
  lineNumber: "#495162",
  activeLineNumber: "#abb2bf",
  selection: "#353a46",
  lineHighlight: "#252830",
  cursor: "#528bff",
  added: "#98c379",
  modified: "#e5c07b",
  deleted: "#e06c75",
});

export const MONACO_GITHUB_COLORS = monacoColors({
  background: "#0d1117",
  foreground: "#e6edf3",
  lineNumber: "#6e7681",
  activeLineNumber: "#e6edf3",
  selection: "#264f78",
  lineHighlight: "#161b22",
  cursor: "#2f81f7",
  added: "#3fb950",
  modified: "#d29922",
  deleted: "#ff7b72",
});

export const MONACO_TOKYO_COLORS = monacoColors({
  background: "#1a1b26",
  foreground: "#c0caf5",
  lineNumber: "#565f89",
  activeLineNumber: "#c0caf5",
  selection: "#33467c",
  lineHighlight: "#24283b",
  cursor: "#7aa2f7",
  added: "#9ece6a",
  modified: "#e0af68",
  deleted: "#f7768e",
});

export const MONACO_CATPPUCCIN_COLORS = monacoColors({
  background: "#1e1e2e",
  foreground: "#cdd6f4",
  lineNumber: "#6c7086",
  activeLineNumber: "#cdd6f4",
  selection: "#585b70",
  lineHighlight: "#313244",
  cursor: "#f5e0dc",
  added: "#a6e3a1",
  modified: "#f9e2af",
  deleted: "#f38ba8",
});

export const MONACO_DRACULA_COLORS = monacoColors({
  background: "#282a36",
  foreground: "#f8f8f2",
  lineNumber: "#6272a4",
  activeLineNumber: "#f8f8f2",
  selection: "#44475a",
  lineHighlight: "#343746",
  cursor: "#f8f8f2",
  added: "#50fa7b",
  modified: "#f1fa8c",
  deleted: "#ff5555",
});

export const MONACO_NORD_COLORS = monacoColors({
  background: "#2e3440",
  foreground: "#d8dee9",
  lineNumber: "#4c566a",
  activeLineNumber: "#eceff4",
  selection: "#4c566a",
  lineHighlight: "#3b4252",
  cursor: "#88c0d0",
  added: "#a3be8c",
  modified: "#ebcb8b",
  deleted: "#bf616a",
});

export const MONACO_GRUVBOX_COLORS = monacoColors({
  background: "#282828",
  foreground: "#ebdbb2",
  lineNumber: "#928374",
  activeLineNumber: "#ebdbb2",
  selection: "#504945",
  lineHighlight: "#32302f",
  cursor: "#ebdbb2",
  added: "#b8bb26",
  modified: "#fabd2f",
  deleted: "#fb4934",
});

export const MONACO_SOLARIZED_COLORS = monacoColors({
  background: "#002b36",
  foreground: "#839496",
  lineNumber: "#586e75",
  activeLineNumber: "#93a1a1",
  selection: "#073642",
  lineHighlight: "#073642",
  cursor: "#268bd2",
  added: "#859900",
  modified: "#b58900",
  deleted: "#dc322f",
});

export const MONACO_SOLARIZED_LIGHT_COLORS = monacoColors({
  background: "#fdf6e3",
  foreground: "#073642",
  lineNumber: "#93a1a1",
  activeLineNumber: "#073642",
  selection: "#d6cfb8",
  lineHighlight: "#eee8d5",
  cursor: "#268bd2",
  added: "#859900",
  modified: "#b58900",
  deleted: "#dc322f",
});

export const MONACO_LIGHT_COLORS = monacoColors({
  background: "#ffffff",
  foreground: "#24292e",
  lineNumber: "#babbbc",
  activeLineNumber: "#24292e",
  selection: "#c8d6f8",
  lineHighlight: "#f5f5f7",
  cursor: "#4f46e5",
  added: "#22863a",
  modified: "#e36809",
  deleted: "#d73a49",
});

export const MONACO_THEME_DEFINITIONS: Record<
  ConcreteThemeMode,
  { base: "vs" | "vs-dark"; rules: typeof MONACO_DARK_RULES; colors: ReturnType<typeof monacoColors> }
> = {
  dark: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_DARK_COLORS },
  dim: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_DIM_COLORS },
  atom: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_ATOM_COLORS },
  github: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_GITHUB_COLORS },
  tokyo: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_TOKYO_COLORS },
  catppuccin: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_CATPPUCCIN_COLORS },
  dracula: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_DRACULA_COLORS },
  nord: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_NORD_COLORS },
  gruvbox: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_GRUVBOX_COLORS },
  solarized: { base: "vs-dark", rules: MONACO_DARK_RULES, colors: MONACO_SOLARIZED_COLORS },
  "solarized-light": { base: "vs", rules: MONACO_LIGHT_RULES, colors: MONACO_SOLARIZED_LIGHT_COLORS },
  light: { base: "vs", rules: MONACO_LIGHT_RULES, colors: MONACO_LIGHT_COLORS },
};
