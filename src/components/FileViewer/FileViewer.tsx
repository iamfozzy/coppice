import { useEffect, useState } from "react";
import { Editor } from "@monaco-editor/react";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";
import type { FilePreviewContent } from "../../lib/commands";
import { getMonacoThemeName } from "../../lib/theme";
import { DEFAULT_APP_FONT_SIZE, getScaledFontSize } from "../../lib/fontScale";
import { configureMonaco, getLanguage } from "../../lib/monaco";

interface Props {
  cwd: string;
  file: string;
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

function PreviewContent({ preview, file }: { preview: FilePreviewContent; file: string }) {
  const url = dataUrl(preview);

  if (preview.kind === "image" && url) {
    return <img src={url} alt={file} className="max-w-full max-h-full object-contain" />;
  }

  if (preview.kind === "pdf" && url) {
    return (
      <object data={url} type={preview.mime_type} className="w-full h-full">
        <span className="text-sm text-text-tertiary">PDF preview is not available.</span>
      </object>
    );
  }

  if (preview.kind === "video" && url) {
    return <video src={url} controls className="max-w-full max-h-full" />;
  }

  if (preview.kind === "audio" && url) {
    return <audio src={url} controls className="w-full max-w-xl" />;
  }

  return (
    <div className="text-center text-sm text-text-tertiary">
      <div className="mb-1">Binary preview is not available</div>
      <div className="text-xs">{preview.mime_type} · {formatBytes(preview.size)}</div>
    </div>
  );
}

export function FileViewer({ cwd, file }: Props) {
  const appSettings = useAppStore((s) => s.appSettings);
  const themeMode = appSettings?.theme ?? "dim";
  const monacoThemeName = getMonacoThemeName(themeMode);
  const [preview, setPreview] = useState<FilePreviewContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    commands.getFilePreview(cwd, file)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [cwd, file]);

  const appFontSize = appSettings?.app_font_size ?? DEFAULT_APP_FONT_SIZE;
  const editorFontSize = appSettings?.terminal_font_size || getScaledFontSize(12, appFontSize);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-1.5 bg-bg-primary border-b border-border-primary shrink-0">
        <span className="text-xs text-text-primary font-medium font-mono truncate">{file}</span>
        {preview && (
          <span className="text-[length:var(--app-font-11)] text-text-tertiary shrink-0">
            {preview.mime_type} · {formatBytes(preview.size)}
          </span>
        )}
        <button
          className="ml-auto text-[length:var(--app-font-11)] text-text-tertiary hover:text-text-primary px-2 py-0.5 rounded hover:bg-bg-hover"
          onClick={() => commands.openWorktreeFileInEditor(cwd, file)}
        >
          Open in editor
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="h-full flex items-center justify-center text-text-tertiary text-sm">Loading...</div>
        ) : error ? (
          <div className="h-full flex items-center justify-center text-error text-sm">{error}</div>
        ) : preview?.kind === "text" ? (
          <Editor
            value={preview.text ?? ""}
            language={getLanguage(file)}
            theme={monacoThemeName}
            beforeMount={configureMonaco}
            options={{
              readOnly: true,
              minimap: { enabled: true },
              fontFamily: appSettings?.terminal_font_family
                ? `'${appSettings.terminal_font_family}', 'JetBrains Mono', monospace`
                : "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
              fontSize: editorFontSize,
              lineHeight: Math.round(editorFontSize * 1.5),
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: "off",
            }}
          />
        ) : preview ? (
          <div className="h-full flex items-center justify-center p-4 overflow-auto bg-bg-primary">
            <PreviewContent preview={preview} file={file} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
