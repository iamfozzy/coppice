import { useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";

interface Props {
  cwd: string;
  file: string;
  mode: "uncommitted" | "pr";
  baseBranch?: string;
}

// Map file extensions to Monaco language IDs
function getLanguage(file: string): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
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
  return map[ext] ?? "plaintext";
}

export function DiffViewer({ cwd, file, mode, baseBranch }: Props) {
  const appSettings = useAppStore((s) => s.appSettings);
  const [original, setOriginal] = useState<string>("");
  const [modified, setModified] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        if (mode === "uncommitted") {
          // Original = HEAD version, Modified = working tree
          const [orig, mod] = await Promise.all([
            commands.getFileContent(cwd, file, "HEAD").catch(() => ""),
            commands.getFileContent(cwd, file).catch(() => ""),
          ]);
          if (!cancelled) {
            setOriginal(orig);
            setModified(mod);
          }
        } else {
          // PR mode: Original = merge-base version, Modified = HEAD version
          const base = await commands.getMergeBase(cwd, baseBranch).catch(() => "");
          if (base) {
            const [orig, mod] = await Promise.all([
              commands.getFileContent(cwd, file, base).catch(() => ""),
              commands.getFileContent(cwd, file, "HEAD").catch(() => ""),
            ]);
            if (!cancelled) {
              setOriginal(orig);
              setModified(mod);
            }
          } else {
            if (!cancelled) {
              setOriginal("");
              setModified(await commands.getFileContent(cwd, file, "HEAD").catch(() => ""));
            }
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [cwd, file, mode, baseBranch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-tertiary text-sm">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-error text-sm">
        {error}
      </div>
    );
  }

  const language = getLanguage(file);

  return (
    <div className="h-full flex flex-col">
      {/* File header */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-secondary border-b border-border-primary shrink-0">
        <span className="text-xs text-text-primary font-medium font-mono">{file}</span>
        <span className="text-[11px] text-text-tertiary">
          {mode === "pr" ? `vs ${baseBranch ?? "main"}` : "uncommitted changes"}
        </span>
      </div>

      {/* Monaco Diff Editor */}
      <div className="flex-1 min-h-0">
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          theme="coppice-dark"
          options={{
            readOnly: mode === "pr",
            renderSideBySide: true,
            minimap: { enabled: true },
            fontFamily: appSettings?.terminal_font_family
              ? `'${appSettings.terminal_font_family}', 'JetBrains Mono', monospace`
              : "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontSize: appSettings?.terminal_font_size || 12,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderOverviewRuler: true,
            diffWordWrap: "off",
            originalEditable: false,
          }}
          beforeMount={(monaco) => {
            // Disable all diagnostics so imports etc don't show errors
            monaco.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({
              noSemanticValidation: true,
              noSyntaxValidation: true,
            });
            monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
              noSemanticValidation: true,
              noSyntaxValidation: true,
            });
            // Disable JSON validation too
            monaco.languages.json?.jsonDefaults?.setDiagnosticsOptions({
              validate: false,
            });

            // Atom One Dark inspired theme
            monaco.editor.defineTheme("coppice-dark", {
              base: "vs-dark",
              inherit: true,
              rules: [
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
              ],
              colors: {
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
              },
            });
          }}
        />
      </div>
    </div>
  );
}
