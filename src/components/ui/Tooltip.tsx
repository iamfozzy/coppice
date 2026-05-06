import { useState, useRef, useLayoutEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface Props {
  text: string;
  children: React.ReactNode;
  align?: "center" | "left" | "right";
  side?: "top" | "bottom";
  delay?: number;
}

/**
 * Lightweight tooltip that portals above everything.
 *
 * Uses `display: contents` so the wrapper is invisible to flex/grid layout —
 * children behave as if they were direct children of the parent container.
 * Positioning is derived from the first child element's bounding rect.
 */
export function Tooltip({ text, children, align = "center", side = "bottom", delay = 400 }: Props) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    if (!visible || !ref.current || !tipRef.current) return;
    // display:contents means the wrapper has no box — use first child for rect
    const anchorEl = (ref.current.firstElementChild as HTMLElement) ?? ref.current;
    const anchor = anchorEl.getBoundingClientRect();
    const tip = tipRef.current.getBoundingClientRect();
    const margin = 4;

    let top: number;
    if (side === "top") {
      top = anchor.top - tip.height - margin;
      if (top < margin) top = anchor.bottom + margin;
    } else {
      top = anchor.bottom + margin;
      if (top + tip.height > window.innerHeight - margin) {
        top = anchor.top - tip.height - margin;
      }
    }

    let left: number;
    if (align === "left") {
      left = anchor.left;
    } else if (align === "right") {
      left = anchor.right - tip.width;
    } else {
      left = anchor.left + anchor.width / 2 - tip.width / 2;
    }

    left = Math.max(margin, Math.min(left, window.innerWidth - tip.width - margin));
    top = Math.max(margin, top);

    setPos({ top, left });
  }, [visible, align, side]);

  return (
    <div
      ref={ref}
      style={{ display: "contents" }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="fixed z-[9999] px-2 py-1 text-[11px] text-text-primary bg-bg-tertiary border border-border-secondary rounded shadow-lg whitespace-nowrap pointer-events-none"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              opacity: pos ? 1 : 0,
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </div>
  );
}
