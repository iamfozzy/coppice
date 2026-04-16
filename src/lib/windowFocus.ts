// Shared window-focus state. App.tsx installs the Tauri focus listener on
// mount and keeps this flag in sync; other modules (notification gating in
// the Zustand store) read it via isWindowFocused() without needing their
// own Tauri API dependency.
//
// Defaults to true — Tauri windows launch focused, and if the initial
// onFocusChanged event hasn't fired yet we'd rather over-show indicators
// than miss real idle transitions.

let focused = true;

export function setWindowFocused(value: boolean) {
  focused = value;
}

export function isWindowFocused(): boolean {
  return focused;
}
