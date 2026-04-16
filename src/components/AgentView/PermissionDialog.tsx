import type { AgentPendingPermission } from "../../lib/types";

interface Props {
  pending: AgentPendingPermission;
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionDialog({ pending, onAllow, onDeny }: Props) {
  return (
    <div className="mx-4 mb-3 border border-warning/30 bg-warning/5 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-warning/10 border-b border-warning/20">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1l6 12H1L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className="text-warning" />
          <line x1="7" y1="5.5" x2="7" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="text-warning" />
          <circle cx="7" cy="10.5" r="0.7" fill="currentColor" className="text-warning" />
        </svg>
        <span className="text-xs font-medium text-warning">Permission Required</span>
      </div>

      <div className="px-3 py-2 space-y-2">
        <div className="text-xs">
          <span className="text-text-tertiary">Tool: </span>
          <span className="font-mono text-text-primary font-medium">{pending.toolName}</span>
        </div>

        <pre className="text-[11px] font-mono text-text-secondary bg-bg-tertiary rounded px-2 py-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
          {JSON.stringify(pending.toolInput, null, 2)}
        </pre>

        <div className="flex items-center gap-2 pt-1">
          <button
            className="px-3 py-1 text-xs rounded bg-accent hover:bg-accent-hover text-white transition-colors"
            onClick={onAllow}
          >
            Allow
          </button>
          <button
            className="px-3 py-1 text-xs rounded bg-bg-tertiary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
            onClick={onDeny}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
