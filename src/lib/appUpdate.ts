import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

export interface AppUpdateInfo {
  status: "checking" | "available" | "up-to-date" | "error";
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  releaseUrl: string;
  publishedAt: string | null;
  checkedAt: number;
  error: string | null;
}

const GITHUB_OWNER = "iamfozzy";
const GITHUB_REPO = "coppice";
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const CACHE_TTL_MS = 60 * 60 * 1000;

let cachedUpdate: AppUpdateInfo | null = null;
let inflightCheck: Promise<AppUpdateInfo> | null = null;
const listeners = new Set<(value: AppUpdateInfo | null) => void>();

function emitUpdate() {
  for (const listener of listeners) {
    listener(cachedUpdate);
  }
}

function setCachedUpdate(value: AppUpdateInfo) {
  cachedUpdate = value;
  emitUpdate();
}

function normalizeVersion(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/^v/i, "");
}

function parseVersion(value: string) {
  const cleaned = normalizeVersion(value).split("+", 1)[0] ?? "";
  const [coreRaw, prereleaseRaw] = cleaned.split("-", 2);
  const core = coreRaw
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));

  while (core.length < 3) core.push(0);

  return {
    core,
    prerelease: prereleaseRaw ? prereleaseRaw.split(".") : [],
  };
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a.localeCompare(b);
}

export function compareVersions(a: string, b: string): number {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  for (let i = 0; i < Math.max(parsedA.core.length, parsedB.core.length); i += 1) {
    const delta = (parsedA.core[i] ?? 0) - (parsedB.core[i] ?? 0);
    if (delta !== 0) return delta;
  }

  const aPrerelease = parsedA.prerelease;
  const bPrerelease = parsedB.prerelease;

  if (aPrerelease.length === 0 && bPrerelease.length === 0) return 0;
  if (aPrerelease.length === 0) return 1;
  if (bPrerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(aPrerelease.length, bPrerelease.length); i += 1) {
    const aPart = aPrerelease[i];
    const bPart = bPrerelease[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    const delta = comparePrereleaseIdentifier(aPart, bPart);
    if (delta !== 0) return delta;
  }

  return 0;
}

function isFresh(value: AppUpdateInfo | null): boolean {
  return Boolean(
    value
    && (value.status === "available" || value.status === "up-to-date")
    && Date.now() - value.checkedAt < CACHE_TTL_MS,
  );
}

function checkingState(previous: AppUpdateInfo | null): AppUpdateInfo {
  return {
    status: "checking",
    currentVersion: previous?.currentVersion ?? "—",
    latestVersion: previous?.latestVersion ?? null,
    latestTag: previous?.latestTag ?? null,
    releaseUrl: previous?.releaseUrl ?? RELEASES_URL,
    publishedAt: previous?.publishedAt ?? null,
    checkedAt: Date.now(),
    error: null,
  };
}

function errorState(previous: AppUpdateInfo | null, error: unknown): AppUpdateInfo {
  return {
    status: "error",
    currentVersion: previous?.currentVersion ?? "—",
    latestVersion: previous?.latestVersion ?? null,
    latestTag: previous?.latestTag ?? null,
    releaseUrl: previous?.releaseUrl ?? RELEASES_URL,
    publishedAt: previous?.publishedAt ?? null,
    checkedAt: Date.now(),
    error: error instanceof Error ? error.message : String(error),
  };
}

async function fetchAppUpdateInfo(): Promise<AppUpdateInfo> {
  const currentVersion = normalizeVersion(await getVersion());
  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub releases check failed (${response.status})`);
  }

  const payload = await response.json() as {
    tag_name?: string;
    html_url?: string;
    published_at?: string;
  };

  const latestTag = typeof payload.tag_name === "string" ? payload.tag_name : null;
  const latestVersion = normalizeVersion(latestTag);
  if (!latestVersion) {
    throw new Error("GitHub latest release tag is missing");
  }

  return {
    status: compareVersions(latestVersion, currentVersion) > 0 ? "available" : "up-to-date",
    currentVersion,
    latestVersion,
    latestTag,
    releaseUrl: typeof payload.html_url === "string" && payload.html_url ? payload.html_url : RELEASES_URL,
    publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
    checkedAt: Date.now(),
    error: null,
  };
}

export async function checkForAppUpdate(force = false): Promise<AppUpdateInfo> {
  if (!force && cachedUpdate && cachedUpdate.status !== "checking" && isFresh(cachedUpdate)) {
    return cachedUpdate;
  }
  if (inflightCheck) return inflightCheck;

  const previous = cachedUpdate;
  setCachedUpdate(checkingState(previous));

  inflightCheck = fetchAppUpdateInfo()
    .then((value) => {
      setCachedUpdate(value);
      return value;
    })
    .catch((error) => {
      const next = errorState(previous, error);
      setCachedUpdate(next);
      return next;
    })
    .finally(() => {
      inflightCheck = null;
    });

  return inflightCheck;
}

export function useAppUpdateInfo(): AppUpdateInfo | null {
  const [info, setInfo] = useState<AppUpdateInfo | null>(() => cachedUpdate);

  useEffect(() => {
    listeners.add(setInfo);
    void checkForAppUpdate();
    return () => {
      listeners.delete(setInfo);
    };
  }, []);

  return info;
}

export function formatAppVersion(version: string | null | undefined): string {
  const normalized = normalizeVersion(version);
  return normalized ? `v${normalized}` : "—";
}

export async function openAppReleasePage(url?: string): Promise<void> {
  const destination = url || cachedUpdate?.releaseUrl || RELEASES_URL;
  try {
    await shellOpen(destination);
  } catch {
    window.open(destination, "_blank", "noopener,noreferrer");
  }
}
