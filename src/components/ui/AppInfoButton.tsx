import { useEffect, useState } from "react";
import { getName, getVersion } from "@tauri-apps/api/app";
import { formatAppVersion, openAppReleasePage, useAppUpdateInfo } from "../../lib/appUpdate";
import { agentSdkVersions } from "../../lib/agentSdkVersions";
import { Tooltip } from "./Tooltip";

interface AppInfoState {
  name: string;
  version: string;
}

const DEFAULT_INFO: AppInfoState = {
  name: "Coppice",
  version: "—",
};

export function AppUpdateButton({
  align = "left",
}: {
  align?: "center" | "left" | "right";
}) {
  const appUpdate = useAppUpdateInfo();

  if (appUpdate?.status !== "available") return null;

  const latestVersion = formatAppVersion(appUpdate.latestVersion);

  return (
    <Tooltip text={`New version available: ${latestVersion}`} align={align}>
      <button
        type="button"
        onClick={() => void openAppReleasePage(appUpdate.releaseUrl)}
        className="relative w-7 h-7 flex items-center justify-center rounded-md border border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15 transition-colors"
        aria-label={`Open GitHub Releases to download ${latestVersion}`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 2.25v5.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M4.9 5.6L7 7.7l2.1-2.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M3 10.25h8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
        <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400 ring-2 ring-bg-secondary" />
      </button>
    </Tooltip>
  );
}

export function AppInfoButton({
  align = "left",
}: {
  align?: "center" | "left" | "right";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Tooltip text="About Coppice" align={align}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-7 h-7 flex items-center justify-center rounded-md border border-border-primary/60 text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          aria-label="About Coppice"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7 6v3.25" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="7" cy="4.1" r="0.7" fill="currentColor" />
          </svg>
        </button>
      </Tooltip>

      {open && <AppInfoModal onClose={() => setOpen(false)} />}
    </>
  );
}

function AppInfoModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfoState>(DEFAULT_INFO);
  const appUpdate = useAppUpdateInfo();

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([
      getName(),
      getVersion(),
    ]).then((results) => {
      if (cancelled) return;
      setInfo({
        name: results[0].status === "fulfilled" ? results[0].value : DEFAULT_INFO.name,
        version: results[1].status === "fulfilled" ? results[1].value : DEFAULT_INFO.version,
      });
    }).catch(() => {});

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelled = true;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200]"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="bg-bg-secondary border border-border-primary rounded-xl w-[420px] max-w-[calc(100vw-2rem)] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary bg-bg-secondary">
          <h2 className="text-sm font-semibold text-text-primary">About Coppice</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary transition-colors"
            aria-label="Close about modal"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-5">
          <div className="flex items-center gap-4">
            <img src="/icon.png" alt="Coppice logo" className="w-14 h-14 rounded-xl shrink-0" />
            <div className="min-w-0">
              <div className="text-lg font-semibold text-text-primary">{info.name}</div>
              <div className="text-sm text-text-secondary">A desktop app for managing git worktrees, terminals, and AI agents.</div>
            </div>
          </div>

          <div className="mt-5 rounded-lg border border-border-primary overflow-hidden">
            <InfoRow label="Version" value={info.version} />
            <InfoRow label="Claude Agent SDK" value={agentSdkVersions.claudeAgentSdk} />
            <InfoRow label="Pi SDK" value={agentSdkVersions.piSdk} />
          </div>

          {appUpdate?.status === "available" && (
            <button
              type="button"
              onClick={() => void openAppReleasePage(appUpdate.releaseUrl)}
              className="mt-4 w-full rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-left hover:bg-amber-500/15 transition-colors"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text-primary">Update available</div>
                  <div className="mt-0.5 text-xs text-text-secondary">
                    {formatAppVersion(appUpdate.currentVersion || info.version)} → {formatAppVersion(appUpdate.latestVersion)}
                  </div>
                </div>
                <span className="shrink-0 text-xs font-medium text-amber-200">View</span>
              </div>
            </button>
          )}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:opacity-90 transition-opacity"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b last:border-b-0 border-border-primary bg-bg-primary/30">
      <span className="text-xs text-text-tertiary">{label}</span>
      <span className={`text-xs text-text-primary text-right ${mono ? "font-mono" : "font-medium"}`}>
        {value}
      </span>
    </div>
  );
}
