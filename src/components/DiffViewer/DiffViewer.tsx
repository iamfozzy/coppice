import { useState, useEffect, useRef, useCallback } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor as monacoEditor } from "monaco-editor";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";
import type { FilePreviewContent, PrComment } from "../../lib/commands";
import { getMonacoThemeName } from "../../lib/theme";
import { DEFAULT_APP_FONT_SIZE, getScaledFontSize } from "../../lib/fontScale";
import { configureMonaco, getLanguage } from "../../lib/monaco";

interface Props {
  cwd: string;
  file: string;
  mode: "uncommitted" | "pr";
  baseBranch?: string;
  comments?: PrComment[];
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
      <strong style="color: #e5c07b; font-size: var(--app-font-11);">${escapeHtml(comment.author)}</strong>
      ${resolved ? '<span style="color: #98c379; font-size: var(--app-font-10);">Resolved</span>' : ""}
    `;

    const body = document.createElement("div");
    body.style.cssText = `
      color: #9da5b4;
      font-size: var(--app-font-11);
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
      font-size: var(--app-font-10);
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

function dataUrl(preview: FilePreviewContent): string | null {
  if (!preview.data || !preview.mime_type) return null;
  return `data:${preview.mime_type};base64,${preview.data}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PreviewPane({ title, preview }: { title: string; preview: FilePreviewContent | null }) {
  const url = preview ? dataUrl(preview) : null;
  return (
    <div className="flex flex-col min-w-0 min-h-0 border border-border-primary rounded bg-bg-secondary/40 overflow-hidden">
      <div className="px-3 py-1.5 border-b border-border-primary text-[length:var(--app-font-11)] text-text-tertiary flex justify-between gap-3">
        <span>{title}</span>
        {preview && <span>{preview.mime_type} · {formatBytes(preview.size)}</span>}
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 overflow-auto bg-bg-primary">
        {!preview || preview.size === 0 ? (
          <span className="text-sm text-text-tertiary">No file at this revision</span>
        ) : preview.kind === "image" && url ? (
          <img src={url} alt={title} className="max-w-full max-h-full object-contain" />
        ) : preview.kind === "pdf" && url ? (
          <object data={url} type={preview.mime_type} className="w-full h-full">
            <span className="text-sm text-text-tertiary">PDF preview is not available.</span>
          </object>
        ) : preview.kind === "video" && url ? (
          <video src={url} controls className="max-w-full max-h-full" />
        ) : preview.kind === "audio" && url ? (
          <audio src={url} controls className="w-full" />
        ) : (
          <div className="text-center text-sm text-text-tertiary">
            <div className="mb-1">Binary preview is not available</div>
            {preview && <div className="text-xs">{preview.mime_type} · {formatBytes(preview.size)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export function DiffViewer({ cwd, file, mode, baseBranch, comments }: Props) {
  const appSettings = useAppStore((s) => s.appSettings);
  const themeMode = appSettings?.theme ?? "dim";
  const monacoThemeName = getMonacoThemeName(themeMode);
  const [original, setOriginal] = useState<string>("");
  const [modified, setModified] = useState<string>("");
  const [originalPreview, setOriginalPreview] = useState<FilePreviewContent | null>(null);
  const [modifiedPreview, setModifiedPreview] = useState<FilePreviewContent | null>(null);
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
        const emptyPreview: FilePreviewContent = { kind: "text", mime_type: "text/plain", text: "", size: 0 };
        if (mode === "uncommitted") {
          // Original = HEAD version, Modified = working tree
          const [orig, mod] = await Promise.all([
            commands.getFilePreview(cwd, file, "HEAD").catch(() => emptyPreview),
            commands.getFilePreview(cwd, file).catch(() => emptyPreview),
          ]);
          if (!cancelled) {
            setOriginalPreview(orig);
            setModifiedPreview(mod);
            setOriginal(orig.kind === "text" ? orig.text ?? "" : "");
            setModified(mod.kind === "text" ? mod.text ?? "" : "");
          }
        } else {
          // PR mode: Original = merge-base version, Modified = HEAD version
          const base = await commands.getMergeBase(cwd, baseBranch).catch(() => "");
          if (base) {
            const [orig, mod] = await Promise.all([
              commands.getFilePreview(cwd, file, base).catch(() => emptyPreview),
              commands.getFilePreview(cwd, file, "HEAD").catch(() => emptyPreview),
            ]);
            if (!cancelled) {
              setOriginalPreview(orig);
              setModifiedPreview(mod);
              setOriginal(orig.kind === "text" ? orig.text ?? "" : "");
              setModified(mod.kind === "text" ? mod.text ?? "" : "");
            }
          } else {
            const mod = await commands.getFilePreview(cwd, file, "HEAD").catch(() => emptyPreview);
            if (!cancelled) {
              setOriginalPreview(emptyPreview);
              setModifiedPreview(mod);
              setOriginal("");
              setModified(mod.kind === "text" ? mod.text ?? "" : "");
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
  const appFontSize = appSettings?.app_font_size ?? DEFAULT_APP_FONT_SIZE;
  const diffFontSize = appSettings?.terminal_font_size || getScaledFontSize(12, appFontSize);
  const isTextDiff = (originalPreview?.kind ?? "text") === "text" && (modifiedPreview?.kind ?? "text") === "text";

  if (!isTextDiff) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-primary border-b border-border-primary shrink-0">
          <span className="text-xs text-text-primary font-medium font-mono">{file}</span>
          <span className="text-[length:var(--app-font-11)] text-text-tertiary">
            {mode === "pr" ? `vs ${baseBranch ?? "main"}` : "uncommitted changes (vs HEAD)"}
          </span>
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-2 gap-3 p-3">
          <PreviewPane title="Original" preview={originalPreview} />
          <PreviewPane title="Modified" preview={modifiedPreview} />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* File header */}
      <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-primary border-b border-border-primary shrink-0">
        <span className="text-xs text-text-primary font-medium font-mono">{file}</span>
        <span className="text-[length:var(--app-font-11)] text-text-tertiary">
          {mode === "pr" ? `vs ${baseBranch ?? "main"}` : "uncommitted changes (vs HEAD)"}
        </span>
        {commentCount > 0 && (
          <span className="text-[length:var(--app-font-10)] text-accent px-1.5 py-0.5 bg-accent/10 rounded">
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
          theme={monacoThemeName}
          options={{
            readOnly: mode === "pr",
            renderSideBySide: true,
            minimap: { enabled: true },
            fontFamily: appSettings?.terminal_font_family
              ? `'${appSettings.terminal_font_family}', 'JetBrains Mono', monospace`
              : "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
            fontSize: diffFontSize,
            lineHeight: Math.round(diffFontSize * 1.5),
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderOverviewRuler: true,
            diffWordWrap: "off",
            originalEditable: false,
            enableSplitViewResizing: true,
            renderGutterMenu: false,
            glyphMargin: commentCount > 0,
          }}
          onMount={handleMount}
          beforeMount={configureMonaco}
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
