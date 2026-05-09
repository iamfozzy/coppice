import { useEffect, useRef, useState } from "react";
import type { AgentBackend } from "../../lib/types";
import type { SupportedModel } from "../../lib/supportedModels";
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
            <div className="min-w-0 text-[10px] font-medium text-text-primary truncate">
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
      <label className="mb-1 block px-1 text-[9px] uppercase tracking-wide text-text-tertiary">{label}</label>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const active = option.value === selectedValue;
          return (
            <button
              key={option.value}
              type="button"
              title={option.hint ? `${option.label} — ${option.hint}` : option.label}
              onClick={() => { void onSelect(option.value); }}
              className={`max-w-full rounded-md border px-2 py-1 text-[10px] transition-colors ${active ? toneActiveClass : "border-border-primary bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-text-primary"}`}
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
      <label className="mb-1 block px-1 text-[9px] uppercase tracking-wide text-text-tertiary">{label}</label>
      <div className="rounded-md border border-border-primary bg-bg-tertiary/40">
        {showSearch && (
          <div className="px-1.5 pt-1.5 pb-1">
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="w-full px-2 py-1 text-[10px] bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
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
                <div className="truncate text-[10px] font-medium">{option.label || emptyLabel || "Select"}</div>
                {option.hint && (
                  <div className="truncate text-[9px] text-text-tertiary">{option.hint}</div>
                )}
              </button>
            );
          }) : (
            <div className="px-2.5 py-1.5 text-[10px] text-text-tertiary">{search ? "No matches" : (emptyLabel || "No options")}</div>
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
