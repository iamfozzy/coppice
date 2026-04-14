import { useState, useEffect, useRef, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";
import type { PrComment } from "../../lib/commands";

interface Props {
  cwd: string;
  file: string;
  mode: "uncommitted" | "pr";
  baseBranch?: string;
  comments?: PrComment[];
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

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function createCommentZoneNode(lineComments: PrComment[]): HTMLDivElement {
  const container = document.createElement("div");
  container.style.cssText = `
    padding: 0;
    margin: 0 0 0 60px;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
  `;

  for (const comment of lineComments) {
    const resolved = comment.is_resolved;
    const card = document.createElement("div");
    card.style.cssText = `
      padding: 6px 10px;
      margin: 2px 12px 2px 0;
      border-left: 2px solid ${resolved ? "#98c379" : "#528bff"};
      background: ${resolved ? "rgba(152,195,121,0.06)" : "rgba(82,139,255,0.06)"};
      border-radius: 0 4px 4px 0;
      opacity: ${resolved ? "0.5" : "1"};
    `;

    const header = document.createElement("div");
    header.style.cssText =
      "display: flex; align-items: center; gap: 6px; margin-bottom: 3px;";
    header.innerHTML = `
      <strong style="color: #e5c07b; font-size: 11px;">${escapeHtml(comment.author)}</strong>
      ${resolved ? '<span style="color: #98c379; font-size: 10px;">Resolved</span>' : ""}
    `;

    const body = document.createElement("div");
    body.style.cssText = `
      color: #9da5b4;
      font-size: 11px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 60px;
      overflow: hidden;
    `;
    body.textContent = comment.body;

    // Expand/collapse for long comments
    const toggle = document.createElement("button");
    toggle.style.cssText = `
      color: #5c6370;
      font-size: 10px;
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 0 0 0;
      display: none;
    `;
    toggle.textContent = "Show more";

    // Check if content overflows after layout
    requestAnimationFrame(() => {
      if (body.scrollHeight > body.clientHeight + 1) {
        toggle.style.display = "inline";
      }
    });

    let expanded = false;
    toggle.addEventListener("click", () => {
      expanded = !expanded;
      body.style.maxHeight = expanded ? "none" : "60px";
      toggle.textContent = expanded ? "Show less" : "Show more";
    });

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(toggle);
    container.appendChild(card);
  }

  return container;
}

export function DiffViewer({ cwd, file, mode, baseBranch, comments }: Props) {
  const appSettings = useAppStore((s) => s.appSettings);
  const [original, setOriginal] = useState<string>("");
  const [modified, setModified] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const diffEditorRef = useRef<monacoEditor.IStandaloneDiffEditor | null>(null);
  const zoneIdsRef = useRef<string[]>([]);
  const decorationsRef =
    useRef<monacoEditor.IEditorDecorationsCollection | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);

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

  // Render inline comments as view zones in the modified editor
  const renderCommentZones = useCallback(() => {
    const diffEditor = diffEditorRef.current;
    const monaco = monacoRef.current;
    if (!diffEditor || !monaco) return;

    const modifiedEditor = diffEditor.getModifiedEditor();

    // Clear previous zones
    if (zoneIdsRef.current.length > 0) {
      modifiedEditor.changeViewZones((accessor) => {
        for (const id of zoneIdsRef.current) {
          accessor.removeZone(id);
        }
      });
      zoneIdsRef.current = [];
    }

    // Clear previous decorations
    if (decorationsRef.current) {
      decorationsRef.current.clear();
      decorationsRef.current = null;
    }

    const lineComments = comments?.filter((c) => c.line) ?? [];
    if (lineComments.length === 0) return;

    // Group comments by line
    const byLine = new Map<number, PrComment[]>();
    for (const c of lineComments) {
      const group = byLine.get(c.line!) ?? [];
      group.push(c);
      byLine.set(c.line!, group);
    }

    // Add view zones
    const newZoneIds: string[] = [];
    modifiedEditor.changeViewZones((accessor) => {
      for (const [line, group] of byLine) {
        const domNode = createCommentZoneNode(group);

        // Estimate height: header(22) + body(min 18, max 66) + toggle(18) per comment + spacing
        const heightInPx = group.reduce((h, c) => {
          const bodyLines = c.body.split("\n").length;
          return h + 22 + Math.min(bodyLines * 16, 66) + 18;
        }, 8);

        const id = accessor.addZone({
          afterLineNumber: line,
          heightInPx: Math.max(heightInPx, 50),
          domNode,
          suppressMouseDown: false,
        });
        newZoneIds.push(id);
      }
    });
    zoneIdsRef.current = newZoneIds;

    // Add line decorations
    const decorations = [...byLine.entries()].map(([line, group]) => {
      const hasUnresolved = group.some((c) => !c.is_resolved);
      return {
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: true,
          className: hasUnresolved
            ? "pr-comment-line-unresolved"
            : "pr-comment-line-resolved",
          glyphMarginClassName: hasUnresolved
            ? "pr-comment-glyph-unresolved"
            : "pr-comment-glyph-resolved",
          overviewRuler: {
            color: hasUnresolved ? "#528bff" : "#98c379",
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      };
    });
    decorationsRef.current = modifiedEditor.createDecorationsCollection(decorations);
  }, [comments]);

  // Re-render zones when comments change or editor mounts
  useEffect(() => {
    renderCommentZones();
  }, [renderCommentZones]);

  const handleMount = useCallback(
    (editor: monacoEditor.IStandaloneDiffEditor, monaco: typeof import("monaco-editor")) => {
      diffEditorRef.current = editor;
      monacoRef.current = monaco;
      // Render comments once editor is ready
      renderCommentZones();
    },
    [renderCommentZones]
  );

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
  const commentCount = comments?.filter((c) => c.line).length ?? 0;

  return (
    <div className="h-full flex flex-col">
      {/* File header */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-secondary border-b border-border-primary shrink-0">
        <span className="text-xs text-text-primary font-medium font-mono">{file}</span>
        <span className="text-[11px] text-text-tertiary">
          {mode === "pr" ? `vs ${baseBranch ?? "main"}` : "uncommitted changes"}
        </span>
        {commentCount > 0 && (
          <span className="text-[10px] text-accent px-1.5 py-0.5 bg-accent/10 rounded">
            {commentCount} comment{commentCount !== 1 ? "s" : ""}
          </span>
        )}
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
            glyphMargin: commentCount > 0,
          }}
          onMount={handleMount}
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

      {/* Inline CSS for comment decorations */}
      <style>{`
        .pr-comment-line-unresolved {
          background: rgba(82, 139, 255, 0.06) !important;
        }
        .pr-comment-line-resolved {
          background: rgba(152, 195, 121, 0.04) !important;
        }
        .pr-comment-glyph-unresolved {
          background: #528bff;
          border-radius: 50%;
          width: 6px !important;
          height: 6px !important;
          margin-left: 6px;
          margin-top: 6px;
        }
        .pr-comment-glyph-resolved {
          background: #98c379;
          border-radius: 50%;
          width: 6px !important;
          height: 6px !important;
          margin-left: 6px;
          margin-top: 6px;
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
}
