import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../stores/appStore";

const POPOVER_WIDTH = 244;
const POPOVER_HEIGHT = 124;
const VIEWPORT_MARGIN = 8;
const POINTER_OFFSET = 8;

type ClosePointerEvent = Pick<React.MouseEvent, "clientX" | "clientY" | "preventDefault" | "stopPropagation">;

interface PendingClose {
  worktreeId: string;
  tabId: string;
  label: string;
  x: number;
  y: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

/**
 * Returns a close-tab requester that asks for confirmation near the pointer
 * when the target is an actively-working agent/Claude tab.
 */
export function useAgentTabCloseConfirmation() {
  const closeTab = useAppStore((s) => s.closeTab);
  const [pendingClose, setPendingClose] = useState<PendingClose | null>(null);

  const requestCloseTab = useCallback((worktreeId: string, tabId: string, event?: ClosePointerEvent) => {
    event?.preventDefault();
    event?.stopPropagation();

    const state = useAppStore.getState();
    const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId);
    const isAgentTab = tab?.type === "agent" || tab?.type === "claude";
    const isActivelyWorking = isAgentTab && state.claudeStatusByTab[tabId] === "active";

    if (!isActivelyWorking) {
      closeTab(worktreeId, tabId);
      return;
    }

    const x = typeof event?.clientX === "number" ? event.clientX : window.innerWidth / 2;
    const y = typeof event?.clientY === "number" ? event.clientY : window.innerHeight / 2;

    setPendingClose({
      worktreeId,
      tabId,
      label: tab?.label ?? "Agent tab",
      x,
      y,
    });
  }, [closeTab]);

  const cancelClose = useCallback(() => setPendingClose(null), []);

  const confirmClose = useCallback(() => {
    if (!pendingClose) return;
    closeTab(pendingClose.worktreeId, pendingClose.tabId);
    setPendingClose(null);
  }, [closeTab, pendingClose]);

  useEffect(() => {
    if (!pendingClose) return;

    const cancel = () => setPendingClose(null);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingClose(null);
      if (event.key === "Enter") confirmClose();
    };

    window.addEventListener("resize", cancel);
    window.addEventListener("scroll", cancel, true);
    window.addEventListener("blur", cancel);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("resize", cancel);
      window.removeEventListener("scroll", cancel, true);
      window.removeEventListener("blur", cancel);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [confirmClose, pendingClose]);

  const closeConfirmation = pendingClose
    ? createPortal(
      <div
        className="fixed inset-0 z-[100]"
        onClick={cancelClose}
        onContextMenu={(event) => {
          event.preventDefault();
          cancelClose();
        }}
      >
        <div
          className="absolute w-[244px] rounded-md border border-border-primary bg-bg-secondary p-3 shadow-xl"
          style={{
            left: clamp(pendingClose.x + POINTER_OFFSET, VIEWPORT_MARGIN, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN),
            top: clamp(pendingClose.y + POINTER_OFFSET, VIEWPORT_MARGIN, window.innerHeight - POPOVER_HEIGHT - VIEWPORT_MARGIN),
          }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div className="text-xs font-semibold text-text-primary">Agent is still working</div>
          <p className="mt-1 text-[11px] leading-4 text-text-tertiary">
            Close “{pendingClose.label}” and stop this active session?
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              className="rounded px-2 py-1 text-[11px] text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary"
              onClick={cancelClose}
            >
              Cancel
            </button>
            <button
              className="rounded bg-error/15 px-2 py-1 text-[11px] text-error transition-colors hover:bg-error/25"
              onClick={confirmClose}
            >
              Close tab
            </button>
          </div>
        </div>
      </div>,
      document.body,
    )
    : null;

  return { requestCloseTab, closeConfirmation };
}
