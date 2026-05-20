export const TERMINAL_PRESET_ICONS = [
  { id: "terminal", label: "Terminal" },
  { id: "play", label: "Play" },
  { id: "package", label: "Package" },
  { id: "server", label: "Server" },
  { id: "database", label: "Database" },
  { id: "bot", label: "Bot" },
  { id: "code", label: "Code" },
  { id: "wrench", label: "Wrench" },
  { id: "rocket", label: "Rocket" },
] as const;

export type TerminalPresetIconId = typeof TERMINAL_PRESET_ICONS[number]["id"];

export function normalizeTerminalPresetIcon(icon: string | null | undefined): TerminalPresetIconId {
  return TERMINAL_PRESET_ICONS.some((option) => option.id === icon)
    ? icon as TerminalPresetIconId
    : "terminal";
}

export function TerminalPresetIcon({ icon, className }: { icon: string | null | undefined; className?: string }) {
  const normalized = normalizeTerminalPresetIcon(icon);
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 14 14",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.3,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
  };

  switch (normalized) {
    case "play":
      return <svg {...common}><path d="M4 2.5v9l7-4.5-7-4.5z" /></svg>;
    case "package":
      return <svg {...common}><path d="M2 4l5-2 5 2v6l-5 2-5-2V4z" /><path d="M2 4l5 2 5-2M7 6v6" /></svg>;
    case "server":
      return <svg {...common}><rect x="2" y="2" width="10" height="4" rx="1" /><rect x="2" y="8" width="10" height="4" rx="1" /><path d="M4 4h.01M4 10h.01" /></svg>;
    case "database":
      return <svg {...common}><ellipse cx="7" cy="3.5" rx="4.5" ry="1.8" /><path d="M2.5 3.5v6.8c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V3.5" /><path d="M2.5 7c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" /></svg>;
    case "bot":
      return <svg {...common}><rect x="3" y="5" width="8" height="6" rx="1.5" /><path d="M7 2.5V5M4.5 8h.01M9.5 8h.01M5.5 11.5h3" /></svg>;
    case "code":
      return <svg {...common}><path d="M5 4L2.5 7 5 10M9 4l2.5 3L9 10M8 2.5l-2 9" /></svg>;
    case "wrench":
      return <svg {...common}><path d="M9.7 2.3a3 3 0 0 0 2 3.9l-5.5 5.5a1.6 1.6 0 0 1-2.3-2.3l5.5-5.5a3 3 0 0 0 .3-1.6z" /></svg>;
    case "rocket":
      return <svg {...common}><path d="M8 2.2c1.4-.6 2.8-.5 3.8 0 .5 1 .6 2.4 0 3.8-.6 1.5-2.1 3-4.3 4.3L3.7 6.5C5 4.3 6.5 2.8 8 2.2z" /><path d="M4 9.5l-1.5 2M10 4l.01.01M4.5 6H2.8L2 6.8M8 9.5v1.7l-.8.8" /></svg>;
    case "terminal":
    default:
      return <svg {...common}><path d="M2 4l4 3-4 3M7 10h5" /></svg>;
  }
}
