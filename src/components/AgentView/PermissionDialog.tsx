import type { AgentPendingPermission } from "../../lib/types";

interface Props {
  pending: AgentPendingPermission;
  onAllow: () => void;
  onDeny: () => void;
}

export function PermissionDialog({ pending, onAllow, onDeny }: Props) {
  return (
    <div className="mx-4 mb-2 border border-warning/20 bg-warning/4 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-warning/8 border-b border-warning/15">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
          <path d="M7 1l6 12H1L7 1z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" className="text-warning" />
          <line x1="7" y1="5.5" x2="7" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="text-warning" />
          <circle cx="7" cy="10.5" r="0.6" fill="currentColor" className="text-warning" />
        </svg>
        <span className="text-[11px] font-medium text-warning">Permission Required</span>
        <span className="text-[11px] text-text-tertiary font-mono ml-1">{pending.toolName}</span>
      </div>

      <div className="px-3 py-2 space-y-2">
        <pre className="text-[11px] font-mono text-text-secondary bg-bg-tertiary/50 rounded px-2.5 py-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all leading-relaxed">
          {JSON.stringify(pending.toolInput, null, 2)}
        </pre>

        <div className="flex items-center gap-2">
          <button
            className="px-3 py-1 text-[11px] font-medium rounded-md bg-accent hover:bg-accent-hover text-white transition-colors"
            onClick={onAllow}
          >
            Allow
          </button>
          <button
            className="px-3 py-1 text-[11px] font-medium rounded-md bg-bg-tertiary border border-border-primary text-text-secondary hover:bg-bg-hover transition-colors"
            onClick={onDeny}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
