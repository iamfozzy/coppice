import { Tooltip } from "./Tooltip";

export function TileViewToggleButton({
  active = false,
  onClick,
  tooltip,
  align = "left",
}: {
  active?: boolean;
  onClick: () => void;
  tooltip: string;
  align?: "center" | "left" | "right";
}) {
  return (
    <Tooltip text={tooltip} align={align}>
      <button
        type="button"
        onClick={onClick}
        className={`w-7 h-7 flex items-center justify-center rounded-md border border-border-primary/60 transition-colors ${
          active
            ? "text-accent hover:text-accent-hover hover:bg-accent/10"
            : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
          <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
    </Tooltip>
  );
}
