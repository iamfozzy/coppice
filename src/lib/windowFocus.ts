// Shared window-focus state. App.tsx installs the Tauri focus listener on
// mount and keeps this flag in sync; other modules (notification gating in
// the Zustand store) read it via isWindowFocused() without needing their
// own Tauri API dependency.
//
// Defaults to true — Tauri windows launch focused, and if the initial
// onFocusChanged event hasn't fired yet we'd rather over-show indicators
// than miss real idle transitions.

import { useEffect, useState } from "react";

let focused = true;
const listeners = new Set<(value: boolean) => void>();

export function setWindowFocused(value: boolean) {
  if (focused === value) return;
  focused = value;
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // ignore listener errors
    }
  }
}

export function isWindowFocused(): boolean {
  return focused;
}

/** Subscribe to focus changes. Returns an unsubscribe fn. */
export function subscribeWindowFocus(listener: (value: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React hook: returns the current window focus state and re-renders on change.
 * Useful for pausing background polling when the window is in the background. */
export function useWindowFocused(): boolean {
  const [value, setValue] = useState<boolean>(focused);
  useEffect(() => subscribeWindowFocus(setValue), []);
  return value;
}
