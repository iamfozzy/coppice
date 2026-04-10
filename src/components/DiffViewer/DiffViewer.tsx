import { useState, useEffect } from "react";
import { DiffEditor } from "@monaco-editor/react";
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
            fontSize: 12,
            lineHeight: 18,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderOverviewRuler: true,
            diffWordWrap: "on",
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

            // Define dark theme matching Coppice
            monaco.editor.defineTheme("coppice-dark", {
              base: "vs-dark",
              inherit: true,
              rules: [],
              colors: {
                "editor.background": "#0a0a0b",
                "editor.foreground": "#e4e4e7",
                "editorLineNumber.foreground": "#71717a",
                "editorLineNumber.activeForeground": "#a1a1aa",
                "editor.selectionBackground": "#6366f133",
                "editor.lineHighlightBackground": "#1a1a1e",
                "editorGutter.addedBackground": "#22c55e33",
                "editorGutter.modifiedBackground": "#eab30833",
                "editorGutter.deletedBackground": "#ef444433",
                "diffEditor.insertedTextBackground": "#22c55e15",
                "diffEditor.removedTextBackground": "#ef444415",
                "diffEditor.insertedLineBackground": "#22c55e10",
                "diffEditor.removedLineBackground": "#ef444410",
              },
            });
          }}
        />
      </div>
    </div>
  );
}
