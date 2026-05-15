import { MONACO_THEME_DEFINITIONS } from "./theme";

// Map file extensions to Monaco language IDs
export function getLanguage(file: string): string {
  const name = file.split(/[/\\]/).pop()?.toLowerCase() ?? file.toLowerCase();
  const ext = name.split(".").pop() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    md: "markdown",
    rs: "rust",
    py: "python",
    rb: "ruby",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yml: "yaml",
    yaml: "yaml",
    toml: "ini",
    xml: "xml",
    svg: "xml",
    graphql: "graphql",
    dockerfile: "dockerfile",
    makefile: "makefile",
  };
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "makefile";
  return map[ext] ?? "plaintext";
}

export function configureMonaco(monaco: typeof import("monaco-editor")): void {
  const languages = monaco.languages as any;
  languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
  });
  languages.json?.jsonDefaults?.setDiagnosticsOptions({ validate: false });
  languages.css?.cssDefaults?.setOptions({ validate: false });
  languages.css?.lessDefaults?.setOptions({ validate: false });
  languages.css?.scssDefaults?.setOptions({ validate: false });
  languages.html?.htmlDefaults?.setOptions?.({ validate: false });

  monaco.editor.setModelMarkers = () => {};

  for (const [theme, definition] of Object.entries(MONACO_THEME_DEFINITIONS)) {
    monaco.editor.defineTheme(`coppice-${theme}`, {
      base: definition.base,
      inherit: true,
      rules: definition.rules,
      colors: definition.colors,
    });
  }
}
