import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AgentBackend, McpServerEntry, McpServerStatus } from "../../lib/types";
import type { SupportedModel } from "../../lib/supportedModels";
import { mcpGetAuthStatus, type McpAuthStatus } from "../../lib/commands";
import { Tooltip } from "./Tooltip";

export type HeaderOption = {
  value: string;
  label: string;
  hint?: string;
};

export function ModelConfigPopover({
  tone,
  backend,
  disabled,
  tooltip,
  dropdownAlign = "right",
  providerLabel,
  providerValue,
  providerOptions,
  onProviderSelect,
  modelLabel,
  modelValue,
  modelOptions,
  onModelSelect,
}: {
  tone: AgentBackend;
  backend: AgentBackend;
  disabled?: boolean;
  tooltip?: string;
  dropdownAlign?: "left" | "right";
  providerLabel: string;
  providerValue: string;
  providerOptions: HeaderOption[];
  onProviderSelect: (value: string) => void | Promise<void>;
  modelLabel: string;
  modelValue: string;
  modelOptions: HeaderOption[];
  onModelSelect: (value: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toneButtonClass = tone === "pi"
    ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
    : "bg-orange-500/10 text-orange-400 border-orange-500/20";

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const button = (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      disabled={disabled}
      className={`w-7 h-7 flex items-center justify-center rounded-md border transition-colors ${toneButtonClass} ${disabled ? "opacity-50" : "hover:brightness-125"}`}
      aria-label="Default model"
    >
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 1v4M4.5 3L8 5l3.5-2M1 6l7 4 7-4M1 10l7 4 7-4" />
      </svg>
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      {tooltip ? <Tooltip text={tooltip}>{button}</Tooltip> : button}
      {open && (
        <div className={`absolute top-8 z-20 w-60 rounded-md border border-border-primary bg-bg-secondary shadow-xl p-1.5 ${dropdownAlign === "left" ? "left-0" : "right-0"}`}>
          <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border-primary/60 bg-bg-primary/40 px-2 py-1.5">
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-tertiary">
              <path d="M8 1v4M4.5 3L8 5l3.5-2M1 6l7 4 7-4M1 10l7 4 7-4" />
            </svg>
            <div className="min-w-0 text-[length:var(--app-font-10)] font-medium text-text-primary truncate">
              {backend === "pi" ? `${providerLabel} · ${modelLabel}` : modelLabel}
            </div>
          </div>

          {backend === "pi" && (
            <InlineChipGroup
              label="Provider"
              tone={tone}
              selectedValue={providerValue}
              options={providerOptions}
              onSelect={onProviderSelect}
            />
          )}

          <InlineOptionList
            label="Model"
            tone={tone}
            selectedValue={modelValue}
            options={modelOptions}
            onSelect={(value) => {
              setOpen(false);
              return onModelSelect(value);
            }}
            emptyLabel={backend === "pi" ? "No models available" : "SDK default"}
          />
        </div>
      )}
    </div>
  );
}

function getMcpConnectionState(
  status?: string,
): "configured" | "connected" | "error" | "pending" | "disconnected" {
  if (!status) return "configured";
  if (status === "connected") return "connected";
  if (status === "disconnected") return "disconnected";
  if (status === "expired") return "pending";
  if (/^error/i.test(status)) return "error";
  if (status === "not_configured") return "configured";
  return "pending";
}

function formatMcpEndpoint(entry?: McpServerEntry, name?: string): string {
  if (!entry) return name === "coppice" ? "IDE tools (worktree, terminal, file, scratchpad)" : "Session-reported server";
  if (entry.server_type === "stdio") {
    const command = entry.command || "<command>";
    const args = entry.args?.join(" ") || "";
    return [command, args].filter(Boolean).join(" ");
  }
  return entry.url || "<url>";
}

export function McpStatusPopover({
  configuredServers,
  sessionServers = [],
  disabled,
  dropdownAlign = "right",
}: {
  configuredServers: Record<string, McpServerEntry>;
  sessionServers?: McpServerStatus[];
  disabled?: boolean;
  dropdownAlign?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [authStatuses, setAuthStatuses] = useState<Record<string, McpAuthStatus>>({});
  const ref = useRef<HTMLDivElement>(null);
  const configuredEntries = Object.entries(configuredServers);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Poll OAuth auth status from the secret store so the toolbar can show
  // connected/disconnected without waiting for an agent session to start.
  // Cheap (one file read + a few HashMap lookups). Refresh on mcp-oauth
  // events so the dot flips green the moment a flow finishes.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await mcpGetAuthStatus();
        if (cancelled) return;
        const map: Record<string, McpAuthStatus> = {};
        for (const s of list) map[s.name] = s;
        setAuthStatuses(map);
      } catch (err) {
        // Silent — the store may be empty or transiently locked.
        if (!cancelled) console.debug("mcpGetAuthStatus:", err);
      }
    };
    refresh();
    const id = setInterval(refresh, 30000);
    let unlisten: (() => void) | undefined;
    listen("mcp-oauth-event", () => {
      void refresh();
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(id);
      if (unlisten) unlisten();
    };
  }, []);

  // Live session status takes priority over the cached OAuth status —
  // a session that fails the connect handshake is what the user actually
  // cares about. Pre-session, fall back to the OAuth-flow status.
  const sessionStatusByName = new Map(sessionServers.map((server) => [server.name, server.status]));
  const hasLiveStatus = sessionServers.length > 0;

  // Servers without an `oauth` field don't participate in the OAuth-status
  // tally — they're either stdio or use static auth, neither of which we
  // can inspect ahead of time. They still show in the popover with a
  // neutral "configured" badge.
  function preSessionStatus(name: string, entry: McpServerEntry): string | undefined {
    const auth = authStatuses[name];
    if (!auth) return undefined;
    if (auth.status === "not_configured") {
      // No OAuth — surface "configured" so the badge stays neutral instead
      // of looking like an error.
      return entry.server_type === "stdio" ? undefined : undefined;
    }
    return auth.status;
  }

  // Always show the built-in Coppice IDE server. Before a session starts it
  // appears as "built-in"; once the bridge reports status it shows live.
  const coppiceRow = {
    name: "coppice",
    entry: undefined,
    status: "connected" as const,
    isOauth: false,
  };

  const rows: Array<{ name: string; entry?: McpServerEntry; status?: string; isOauth: boolean }> =
    [coppiceRow,
    ...configuredEntries.map(([name, entry]) => ({
      name,
      entry,
      status: sessionStatusByName.get(name) ?? preSessionStatus(name, entry),
      isOauth: !!entry.oauth,
    }))];
  for (const server of sessionServers) {
    if (server.name !== "coppice" && !(server.name in configuredServers)) {
      rows.push({ name: server.name, entry: undefined, status: server.status, isOauth: false });
    }
  }

  const totalCount = rows.length;
  const oauthRows = rows.filter((r) => r.isOauth);
  const connectedCount = rows.filter((row) => row.status === "connected").length;
  const errorCount = rows.filter((row) => getMcpConnectionState(row.status) === "error").length;
  const pendingCount = rows.filter((row) => getMcpConnectionState(row.status) === "pending").length;
  const disconnectedCount = rows.filter(
    (row) => getMcpConnectionState(row.status) === "disconnected",
  ).length;

  // Toolbar tone reflects the strongest signal available. With a live
  // session: green if everything connected, red if all dead, amber mixed.
  // Without a session: same logic but using OAuth status — and only count
  // OAuth-enabled servers when deciding "all good", since a stdio-only
  // setup has no fail state to surface.
  let toneClass: string;
  let badgeText: string;
  let summary: string;
  if (hasLiveStatus) {
    if (errorCount === 0 && connectedCount === totalCount) {
      toneClass = "border-green-500/20 bg-green-500/10 text-green-400 hover:bg-green-500/15";
    } else if (connectedCount > 0) {
      toneClass = "border-amber-500/20 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15";
    } else {
      toneClass = "border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/15";
    }
    badgeText = `${connectedCount}/${totalCount}`;
    summary = `${connectedCount}/${totalCount} MCP server${totalCount === 1 ? "" : "s"} connected`;
  } else if (oauthRows.length > 0) {
    const oauthConnected = oauthRows.filter((r) => r.status === "connected").length;
    const oauthBroken = oauthRows.filter(
      (r) =>
        getMcpConnectionState(r.status) === "disconnected" ||
        getMcpConnectionState(r.status) === "error",
    ).length;
    if (oauthBroken === 0 && oauthConnected === oauthRows.length) {
      toneClass = "border-green-500/20 bg-green-500/10 text-green-400 hover:bg-green-500/15";
    } else if (oauthConnected > 0) {
      toneClass = "border-amber-500/20 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15";
    } else {
      toneClass = "border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/15";
    }
    badgeText = `${oauthConnected}/${oauthRows.length}`;
    summary = `${oauthConnected}/${oauthRows.length} OAuth MCP server${oauthRows.length === 1 ? "" : "s"} connected${
      oauthRows.length < totalCount ? ` (${totalCount - oauthRows.length} other)` : ""
    }`;
  } else {
    toneClass =
      "border-border-primary/25 bg-bg-tertiary/40 text-text-secondary hover:bg-bg-hover hover:text-text-primary";
    badgeText = `${rows.length}`;
    summary = `${rows.length} MCP server${rows.length === 1 ? "" : "s"} configured`;
  }

  const button = (
    <button
      type="button"
      onClick={() => setOpen((value) => !value)}
      disabled={disabled}
      className={`h-7 min-w-8 px-2 flex items-center justify-center gap-1.5 rounded-md border transition-colors ${toneClass} ${disabled ? "opacity-50" : ""}`}
      aria-label={summary}
    >
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2.5" y="2.5" width="11" height="4" rx="1.2" />
        <rect x="2.5" y="9.5" width="11" height="4" rx="1.2" />
        <path d="M5.5 4.5h.01M8 4.5h.01M5.5 11.5h.01M8 11.5h.01" />
      </svg>
      <span className="text-[length:var(--app-font-10)] font-medium tabular-nums leading-none">{badgeText}</span>
    </button>
  );

  return (
    <div className="relative" ref={ref}>
      <Tooltip text={summary}>{button}</Tooltip>
      {open && (
        <div className={`absolute top-8 z-20 w-72 rounded-md border border-border-primary bg-bg-secondary shadow-xl p-1.5 ${dropdownAlign === "left" ? "left-0" : "right-0"}`}>
          <div className="mb-2 rounded-md border border-border-primary/60 bg-bg-primary/40 px-2 py-1.5">
            <div className="flex items-center gap-1.5 text-[length:var(--app-font-10)] font-medium text-text-primary">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-tertiary">
                <rect x="2.5" y="2.5" width="11" height="4" rx="1.2" />
                <rect x="2.5" y="9.5" width="11" height="4" rx="1.2" />
                <path d="M5.5 4.5h.01M8 4.5h.01M5.5 11.5h.01M8 11.5h.01" />
              </svg>
              <span className="truncate">MCP servers</span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-[length:var(--app-font-9)] text-text-tertiary">
              <span>Configured {configuredEntries.length}</span>
              <span>Connected {connectedCount}</span>
              {errorCount > 0 && <span>Errors {errorCount}</span>}
              {pendingCount > 0 && <span>Pending {pendingCount}</span>}
              {disconnectedCount > 0 && <span>Need auth {disconnectedCount}</span>}
            </div>
            {!hasLiveStatus && (
              <div className="mt-1 text-[length:var(--app-font-9)] text-text-tertiary">
                {oauthRows.length > 0
                  ? "Showing OAuth status. Live session status appears once an agent starts."
                  : "Connection status appears after an agent session starts."}
              </div>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto space-y-1">
            {rows.map((row) => {
              const state = getMcpConnectionState(row.status);
              const badgeClass =
                state === "connected"
                  ? "bg-green-500/10 text-green-400"
                  : state === "error"
                    ? "bg-red-500/10 text-red-400"
                    : state === "pending"
                      ? "bg-amber-500/10 text-amber-400"
                      : state === "disconnected"
                        ? "bg-red-500/10 text-red-300"
                        : "bg-bg-tertiary text-text-secondary";
              const statusLabel = row.status || (row.isOauth ? "configured" : "configured");
              const transport = row.entry?.server_type || (row.name === "coppice" ? "built-in" : "unknown");
              const endpoint = formatMcpEndpoint(row.entry, row.name);
              return (
                <div key={row.name} className="rounded-md border border-border-primary/60 bg-bg-primary/20 px-2 py-1.5">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[length:var(--app-font-10)] font-medium text-text-primary">{row.name}</div>
                      <div className="mt-0.5 text-[length:var(--app-font-9)] text-text-tertiary">{transport}</div>
                      <div className="truncate text-[length:var(--app-font-9)] text-text-tertiary" title={endpoint}>{endpoint}</div>
                    </div>
                    <div className={`shrink-0 rounded px-1.5 py-0.5 text-[length:var(--app-font-9)] font-medium ${badgeClass}`} title={statusLabel}>
                      {statusLabel}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function InlineChipGroup({
  label,
  tone,
  selectedValue,
  options,
  onSelect,
}: {
  label: string;
  tone: AgentBackend;
  selectedValue: string;
  options: HeaderOption[];
  onSelect: (value: string) => void | Promise<void>;
}) {
  const toneActiveClass = tone === "pi"
    ? "border-purple-500/30 bg-purple-500/10 text-purple-400"
    : "border-orange-500/30 bg-orange-500/10 text-orange-400";

  return (
    <div className="mb-2">
      <label className="mb-1 block px-1 text-[length:var(--app-font-9)] uppercase tracking-wide text-text-tertiary">{label}</label>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = option.value === selectedValue;
          return (
            <button
              key={option.value}
              type="button"
              title={option.hint ? `${option.label} — ${option.hint}` : option.label}
              onClick={() => { void onSelect(option.value); }}
              className={`max-w-full rounded-md border px-2 py-1 text-[length:var(--app-font-10)] transition-colors ${active ? toneActiveClass : "border-border-primary bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
            >
              <span className="block truncate">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InlineOptionList({
  label,
  tone,
  selectedValue,
  options,
  onSelect,
  emptyLabel,
}: {
  label: string;
  tone: AgentBackend;
  selectedValue: string;
  options: HeaderOption[];
  onSelect: (value: string) => void | Promise<void>;
  emptyLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const showSearch = true;

  const filtered = search
    ? options.filter((o) => {
        const q = search.toLowerCase();
        return o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q);
      })
    : options;

  const toneActiveClass = tone === "pi"
    ? "bg-purple-500/10 text-purple-400"
    : "bg-orange-500/10 text-orange-400";

  useEffect(() => {
    if (showSearch && searchRef.current) searchRef.current.focus();
  }, [showSearch]);

  return (
    <div>
      <label className="mb-1 block px-1 text-[length:var(--app-font-9)] uppercase tracking-wide text-text-tertiary">{label}</label>
      <div className="rounded-md border border-border-primary bg-bg-tertiary/40">
        {showSearch && (
          <div className="px-1.5 pt-1.5 pb-1">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="w-full px-2 py-1 text-[length:var(--app-font-10)] bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
            />
          </div>
        )}
        <div className="max-h-48 overflow-y-auto py-0.5">
          {filtered.length > 0 ? filtered.map((option) => {
            const active = option.value === selectedValue;
            return (
              <button
                key={option.value || "__empty__"}
                type="button"
                title={option.hint ? `${option.label} — ${option.hint}` : option.label}
                onClick={() => { void onSelect(option.value); }}
                className={`w-full px-2.5 py-1 text-left transition-colors ${active ? toneActiveClass : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
              >
                <div className="truncate text-[length:var(--app-font-10)] font-medium">{option.label || emptyLabel || "Select"}</div>
                {option.hint && (
                  <div className="truncate text-[length:var(--app-font-9)] text-text-tertiary">{option.hint}</div>
                )}
              </button>
            );
          }) : (
            <div className="px-2.5 py-1.5 text-[length:var(--app-font-10)] text-text-tertiary">{search ? "No matches" : (emptyLabel || "No options")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export function stripPiProviderPrefix(value: string): string {
  return value.includes("/") ? value.split("/").slice(1).join("/") : value;
}

export function formatPiProvider(slug: string): string {
  const overrides: Record<string, string> = {
    openai: "OpenAI",
    xai: "xAI",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter",
    "amazon-bedrock": "Bedrock",
    "azure-openai-responses": "Azure OpenAI",
    "google-vertex": "Vertex AI",
    "github-copilot": "Copilot",
    "cloudflare-ai-gateway": "CF Gateway",
    "cloudflare-workers-ai": "CF Workers",
    "openai-codex": "Codex",
    "vercel-ai-gateway": "Vercel AI",
  };
  return overrides[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

const PI_FALLBACK_MODELS: Record<string, SupportedModel[]> = {
  anthropic: [
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", provider: "anthropic", contextWindow: 200000, reasoning: true },
    { value: "claude-opus-4-20250515", label: "Claude Opus 4", provider: "anthropic", contextWindow: 200000, reasoning: true },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", provider: "anthropic", contextWindow: 200000, reasoning: true },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o", provider: "openai", contextWindow: 128000 },
    { value: "gpt-4o-mini", label: "GPT-4o Mini", provider: "openai", contextWindow: 128000 },
    { value: "o3", label: "o3", provider: "openai", contextWindow: 200000, reasoning: true },
    { value: "o4-mini", label: "o4 Mini", provider: "openai", contextWindow: 200000, reasoning: true },
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "google", contextWindow: 1048576, reasoning: true },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "google", contextWindow: 1048576, reasoning: true },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek Chat", provider: "deepseek", contextWindow: 65536 },
    { value: "deepseek-reasoner", label: "DeepSeek Reasoner", provider: "deepseek", contextWindow: 65536, reasoning: true },
  ],
  mistral: [
    { value: "mistral-large-latest", label: "Mistral Large", provider: "mistral", contextWindow: 131072 },
    { value: "codestral-latest", label: "Codestral", provider: "mistral", contextWindow: 262144 },
  ],
  groq: [
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", provider: "groq", contextWindow: 131072 },
  ],
  xai: [
    { value: "grok-3-fast", label: "Grok 3 Fast", provider: "xai", contextWindow: 131072, reasoning: true },
    { value: "grok-3-mini-fast", label: "Grok 3 Mini Fast", provider: "xai", contextWindow: 131072, reasoning: true },
  ],
  openrouter: [
    { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", provider: "openrouter", contextWindow: 200000 },
    { value: "openai/gpt-4o", label: "GPT-4o", provider: "openrouter", contextWindow: 128000 },
    { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", contextWindow: 1048576 },
  ],
};

export function getPiModelsForProvider(provider: string, models: SupportedModel[]): SupportedModel[] {
  const sdkModels = models.filter((model) => model.provider === provider);
  return sdkModels.length > 0 ? sdkModels : (PI_FALLBACK_MODELS[provider] || []);
}
