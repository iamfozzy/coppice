import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { SlashCommand, ImageAttachment } from "../../lib/types";
import { useAppStore } from "../../stores/appStore";

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

/** Read a File straight to base64 without any processing. */
function readAsBase64(file: File): Promise<ImageAttachment | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      if (!base64) { resolve(null); return; }
      resolve({
        data: base64,
        mediaType: file.type as ImageAttachment["mediaType"],
        fileName: file.name,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/**
 * Downscale an image so the long edge is at most `maxDim` pixels, then encode
 * as base64. Preserves the original media type (JPEG/PNG/WebP) where
 * possible. Returns null on any failure so callers can fall back.
 */
function downscaleImage(file: File, maxDim: number): Promise<ImageAttachment | null> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const longest = Math.max(img.width, img.height);
        const scale = longest > maxDim ? maxDim / longest : 1;
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) { URL.revokeObjectURL(url); reject(new Error("no 2d ctx")); return; }
        ctx.drawImage(img, 0, 0, w, h);
        const mediaType = file.type === "image/png" ? "image/png" : "image/jpeg";
        const quality = mediaType === "image/jpeg" ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(mediaType, quality);
        URL.revokeObjectURL(url);
        const base64 = dataUrl.split(",")[1];
        if (!base64) { resolve(null); return; }
        resolve({
          data: base64,
          mediaType: mediaType as ImageAttachment["mediaType"],
          fileName: file.name,
        });
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(e);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load failed")); };
    img.src = url;
  });
}

interface Props {
  sessionId: string;
  disabled: boolean;
  isAgentBusy: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  slashCommands?: SlashCommand[];
  onSend: (text: string, images?: ImageAttachment[]) => void;
}

/** Return the command name the user is currently typing, or null. */
function parseLeadingSlash(text: string): string | null {
  // Only trigger on a leading `/` with no whitespace yet — i.e. the whole input
  // so far is the command name. This matches Claude Code's picker behavior.
  if (!text.startsWith("/")) return null;
  const rest = text.slice(1);
  if (/\s/.test(rest)) return null;
  return rest;
}

export function AgentInputBar({ sessionId, disabled, isAgentBusy, autoFocus, placeholder, slashCommands, onSend }: Props) {
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  // Consume images dropped via Tauri's native drag-drop handler (App.tsx).
  const pendingImages = useAppStore((s) => s.pendingDroppedImages[sessionId]);
  useEffect(() => {
    if (pendingImages && pendingImages.length > 0) {
      setImages((prev) => [...prev, ...pendingImages]);
      useAppStore.getState().consumeDroppedImages(sessionId);
    }
  }, [pendingImages, sessionId]);

  // Focus textarea when this tab becomes visible (tab switch, worktree switch,
  // or a new worktree selection all flip `autoFocus` via the `visible` prop).
  // Defer to next frame so the browser has finished any layout work from the
  // parent's visibility toggle before we move focus.
  useEffect(() => {
    if (!autoFocus || disabled) return;
    const raf = requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, disabled]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
  }, [text]);

  const query = parseLeadingSlash(text);
  const filtered = useMemo<SlashCommand[]>(() => {
    if (query === null || !slashCommands?.length) return [];
    const q = query.toLowerCase();
    return slashCommands
      .filter((c) => c.name.toLowerCase().startsWith(q))
      .slice(0, 10);
  }, [query, slashCommands]);

  const pickerOpen = filtered.length > 0;

  // Reset the highlighted row whenever the filter changes
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  /**
   * Read a File as a base64-encoded ImageAttachment. Downscale oversized
   * images to cap token cost — Anthropic's vision pipeline gains nothing
   * above ~1568px on the long edge, and a full-resolution screenshot
   * otherwise replays on every subsequent turn at full cost.
   */
  const fileToAttachment = useCallback((file: File): Promise<ImageAttachment | null> => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) return Promise.resolve(null);
    if (file.size > MAX_IMAGE_SIZE) return Promise.resolve(null);
    // GIFs are animated — downscaling would flatten them; pass through as-is.
    if (file.type === "image/gif") return readAsBase64(file);
    return downscaleImage(file, 1568).catch(() => readAsBase64(file));
  }, []);

  /** Process dropped/pasted/selected files into image attachments. */
  const addFiles = useCallback(async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    const results = await Promise.all(fileArray.map(fileToAttachment));
    const valid = results.filter((r): r is ImageAttachment => r !== null);
    if (valid.length > 0) {
      setImages((prev) => [...prev, ...valid]);
    }
  }, [fileToAttachment]);

  /** Remove an image attachment by index. */
  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Drag-and-drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    setIsDragOver(true);
  }, [disabled]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only clear if leaving the drop zone entirely
    if (dropZoneRef.current && !dropZoneRef.current.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (disabled) return;
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [disabled, addFiles]);

  // Paste handler for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of items) {
      if (item.kind === "file" && ACCEPTED_IMAGE_TYPES.includes(item.type)) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }, [addFiles]);

  const sendText = (value: string) => {
    const trimmed = value.trim();
    if ((!trimmed && images.length === 0) || disabled) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
  };

  const applyCommand = (cmd: SlashCommand) => {
    // If the command takes arguments, insert `/name ` and let the user type.
    // Otherwise send immediately — mirrors Claude Code's one-tap behavior.
    if (cmd.argumentHint) {
      setText(`/${cmd.name} `);
      textareaRef.current?.focus();
    } else {
      sendText(`/${cmd.name}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) setText(`/${cmd.name}${cmd.argumentHint ? " " : ""}`);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = filtered[activeIndex];
        if (cmd) applyCommand(cmd);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setText("");
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText(text);
    }
  };

  // Determine button label & style based on queue state
  const showQueueButton = isAgentBusy && !disabled;

  return (
    <div
      ref={dropZoneRef}
      className="relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-accent/10 border-2 border-dashed border-accent rounded-lg pointer-events-none">
          <span className="text-accent text-sm font-medium">Drop images here</span>
        </div>
      )}

      {pickerOpen && (
        <div className="absolute bottom-full left-3 right-3 mb-1 max-h-60 overflow-y-auto rounded-lg border border-border-primary bg-bg-secondary shadow-lg z-10">
          {filtered.map((cmd, i) => (
            <button
              key={cmd.name}
              type="button"
              className={`w-full text-left px-3 py-1.5 text-[12px] font-mono flex items-baseline gap-2 ${
                i === activeIndex
                  ? "bg-accent/20 text-text-primary"
                  : "text-text-secondary hover:bg-bg-tertiary"
              }`}
              onMouseDown={(e) => {
                // Prevent textarea blur so focus stays put after selection.
                e.preventDefault();
                applyCommand(cmd);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="text-accent">/{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="text-text-tertiary">{cmd.argumentHint}</span>
              )}
              {cmd.description && (
                <span className="ml-auto text-text-tertiary truncate">
                  {cmd.description}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Image thumbnails */}
      {images.length > 0 && (
        <div className="flex gap-2 px-3 pt-2 pb-1 bg-bg-secondary overflow-x-auto">
          {images.map((img, i) => (
            <div key={i} className="relative shrink-0 group">
              <img
                src={`data:${img.mediaType};base64,${img.data}`}
                alt={img.fileName}
                className="h-16 w-16 object-cover rounded-md border border-border-primary"
              />
              <button
                type="button"
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => removeImage(i)}
                title="Remove image"
              >
                ×
              </button>
              <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[9px] px-1 truncate rounded-b-md">
                {img.fileName}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 px-3 py-2.5 bg-bg-secondary">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_IMAGE_TYPES.join(",")}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        {/* Attach image button */}
        <button
          type="button"
          className="shrink-0 self-stretch flex items-center justify-center w-8 rounded-lg text-text-tertiary hover:text-text-secondary hover:bg-bg-tertiary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          title="Attach images"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="5.5" cy="5.5" r="1.25" stroke="currentColor" strokeWidth="1.1" />
            <path d="M2 11l3-3 2 2 3-4 4 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          className="flex-1 resize-none bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-[13px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/20 transition-all font-mono leading-relaxed"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder || "Send a message..."}
          disabled={disabled}
          spellCheck={false}
        />
        <button
          className={`shrink-0 self-stretch flex items-center justify-center rounded-lg text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
            showQueueButton
              ? "bg-amber-500/80 hover:bg-amber-500 px-2.5 gap-1.5"
              : "bg-accent hover:bg-accent-hover w-8"
          }`}
          onClick={() => sendText(text)}
          disabled={disabled || (!text.trim() && images.length === 0)}
          title={showQueueButton ? "Queue (Enter)" : "Send (Enter)"}
        >
          {showQueueButton ? (
            <>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
                <path d="M6 3v3.5l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
              <span className="text-[11px] font-medium">Queue</span>
            </>
          ) : (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 7h12M8 2l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
