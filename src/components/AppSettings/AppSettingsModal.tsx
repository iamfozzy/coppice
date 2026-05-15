import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/appStore";
import type { AppSettings, McpServerEntry, ThemeMode, DefaultSessionMode } from "../../lib/types";
import { SUPPORTED_MODELS } from "../../lib/supportedModels";
import { GitHubAuthSection } from "./GitHubAuthSection";
import { normalizeAppFontSize } from "../../lib/fontScale";
import { resolveDefaultSessionMode } from "../../lib/defaultSessionMode";
import { THEME_OPTIONS } from "../../lib/theme";
import {
  piGetModels,
  piOAuthLogin,
  piOAuthCheck,
  claudeAuthLogin,
  mcpGetCatalog,
  mcpInstallCatalogEntry,
  mcpOauthStart,
  mcpOauthRevoke,
  mcpGetAuthStatus,
  mcpTestConnection,
  type McpCatalogEntry,
  type McpAuthStatus,
} from "../../lib/commands";

const CLAUDE_EFFORT_OPTIONS: Array<{ value: AppSettings["agent_default_effort"]; label: string }> = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

const PI_THINKING_OPTIONS: Array<{ value: AppSettings["agent_default_effort"]; label: string }> = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

const defaultSettings: AppSettings = {
  editor_command: "",
  claude_command: "",
  terminal_font_family: "",
  terminal_font_size: 0,
  app_font_size: 16,
  terminal_emulator: "",
  shell: "",
  terminal_compact_prompt: true,
  theme: "dim",
  window_decorations: true,
  notification_sound: true,
  notification_popup: true,
  default_claude_mode: "claude",
  claude_cli_statusline_enabled: true,
  claude_cli_statusline_git: true,
  claude_cli_statusline_colors: true,
  claude_cli_notifications: true,
  claude_cli_fullscreen: true,
  claude_cli_terminal_progress: true,
  agent_default_model: "",
  agent_default_effort: "high",
  agent_default_extended_context: false,
  agent_api_key: "",
  agent_api_key_custom_only: false,
  agent_base_url: "",
  agent_base_url_custom_only: false,
  agent_small_fast_model: "",
  agent_subagent_model: "",
  agent_bash_max_output: 0,
  agent_task_max_output: 0,
  mcp_servers: {},
  agent_backend: "claude",
  pi_default_provider: "anthropic",
  pi_default_model: "claude-sonnet-4-20250514",
  pi_enable_web_access: true,
  pi_enable_subagent: true,
  pi_api_keys: {},
  pi_configured_providers: ["anthropic"],
};

export function AppSettingsModal() {
  const appSettings = useAppStore((s) => s.appSettings);
  const closeAppSettings = useAppStore((s) => s.closeAppSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const [form, setForm] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [agentConfigTab, setAgentConfigTab] = useState<"cli" | "claude" | "pi">("cli");

  useEffect(() => {
    if (appSettings) {
      setForm({ ...appSettings });
    }
  }, [appSettings]);

  const defaultSessionMode = resolveDefaultSessionMode(form);

  const setDefaultSessionMode = (mode: DefaultSessionMode) => {
    setForm({
      ...form,
      default_claude_mode: mode,
      ...(mode === "terminal" ? {} : { agent_backend: mode }),
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const mode = resolveDefaultSessionMode(form);
      await saveSettings({
        ...form,
        default_claude_mode: mode,
        ...(mode === "terminal" ? {} : { agent_backend: mode }),
        app_font_size: normalizeAppFontSize(form.app_font_size),
      });
      closeAppSettings();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] bg-bg-secondary"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAppSettings();
      }}
    >
      <div className="flex h-full w-full flex-col bg-bg-secondary">
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border-primary bg-bg-secondary">
          <h2 className="text-sm font-semibold text-text-primary">App Settings</h2>
          <button
            onClick={closeAppSettings}
            className="text-text-tertiary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <p className="text-[length:var(--app-font-11)] text-text-tertiary">
            Global defaults. Leave blank to use platform defaults. Per-project settings override these.
          </p>

          <GitHubAuthSection />

          <Field
            label="Editor command"
            value={form.editor_command}
            onChange={(editor_command) => setForm({ ...form, editor_command })}
            placeholder="code"
            hint="Command to open your editor (e.g., cursor, code, codium)"
          />
          <Field
            label="Terminal font family"
            value={form.terminal_font_family}
            onChange={(terminal_font_family) => setForm({ ...form, terminal_font_family })}
            placeholder="JetBrains Mono"
            hint="Must be installed on your system"
          />
          <Field
            label="Terminal font size"
            value={form.terminal_font_size ? String(form.terminal_font_size) : ""}
            onChange={(v) => setForm({ ...form, terminal_font_size: parseInt(v) || 0 })}
            placeholder="13"
            hint="Font size in pixels. Leave blank to follow the app base font size."
          />
          <Field
            label="Base font size"
            value={String(form.app_font_size || 16)}
            onChange={(v) => setForm({ ...form, app_font_size: parseInt(v) || 16 })}
            placeholder="16"
            hint="Base UI font size in pixels (10–24). All app text scales relative to this value."
          />
          <Field
            label="Terminal emulator"
            value={form.terminal_emulator}
            onChange={(terminal_emulator) => setForm({ ...form, terminal_emulator })}
            placeholder="(auto-detect)"
            hint="For 'Open in terminal' (e.g., alacritty, kitty, ghostty)"
          />
          <Field
            label="Shell"
            value={form.shell}
            onChange={(shell) => setForm({ ...form, shell })}
            placeholder="$SHELL"
            hint="Override default shell for terminal sessions"
          />
          <Toggle
            label="Compact terminal prompt"
            checked={form.terminal_compact_prompt}
            onChange={(terminal_compact_prompt) => setForm({ ...form, terminal_compact_prompt })}
            hint="Shortens new plain terminal prompts so long worktree paths don't fill the command line."
          />
          <ThemeDropdown
            label="Theme"
            value={form.theme}
            onChange={(theme) => setForm({ ...form, theme })}
          />
          <Toggle
            label="Window decorations"
            checked={form.window_decorations}
            onChange={(window_decorations) => setForm({ ...form, window_decorations })}
            hint="Show native title bar (disable on tiling window managers)"
          />
          <Toggle
            label="Notification sound"
            checked={form.notification_sound}
            onChange={(notification_sound) => setForm({ ...form, notification_sound })}
            hint="Play a chime when an agent or Claude CLI tab needs attention"
          />
          <Toggle
            label="OS notifications"
            checked={form.notification_popup}
            onChange={(notification_popup) => setForm({ ...form, notification_popup })}
            hint="Show a system notification when an agent or Claude CLI tab needs attention"
          />

          <div className="pt-5 border-t border-border-primary space-y-5">
            <div className="space-y-1.5">
              <label className="block text-xs text-text-secondary">Default new session shortcut</label>
              <div className="flex gap-1.5">
                {([
                  ["terminal", "Claude CLI"],
                  ["claude", "Claude SDK"],
                  ["pi", "Pi Agent"],
                ] as const).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setDefaultSessionMode(mode)}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                      defaultSessionMode === mode
                        ? mode === "pi" ? "bg-purple-500 text-white" : "bg-accent text-white"
                        : "bg-bg-tertiary text-text-secondary hover:text-text-primary border border-border-primary"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="text-[length:var(--app-font-10)] text-text-tertiary">
                Controls what the tab bar <span className="font-mono">+</span> button, app header switcher, and <span className="font-mono">Cmd/Ctrl+Shift+T</span> open.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs text-text-secondary">Configure</label>
              <div className="flex border-b border-border-primary">
                {([
                  ["cli", "Claude CLI"],
                  ["claude", "Claude SDK"],
                  ["pi", "Pi Agent"],
                ] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setAgentConfigTab(tab)}
                    className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                      agentConfigTab === tab
                        ? "border-accent text-text-primary"
                        : "border-transparent text-text-tertiary hover:text-text-primary"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {agentConfigTab === "cli" && (
            <div className="space-y-5 rounded-lg border border-accent/20 bg-accent/[0.03] p-4">
              <Field
                label="Claude command"
                value={form.claude_command}
                onChange={(claude_command) => setForm({ ...form, claude_command })}
                placeholder="claude"
                hint="Claude Code CLI command. Per-project settings can override this."
              />
              <div className="space-y-3">
                <Toggle label="Coppice statusline" checked={form.claude_cli_statusline_enabled} onChange={(claude_cli_statusline_enabled) => setForm({ ...form, claude_cli_statusline_enabled })} hint="Show a compact colored statusline in Claude CLI tabs." />
                {form.claude_cli_statusline_enabled && (
                  <div className="ml-5 space-y-3 border-l border-border-primary pl-3">
                    <Toggle label="Statusline colors" checked={form.claude_cli_statusline_colors} onChange={(claude_cli_statusline_colors) => setForm({ ...form, claude_cli_statusline_colors })} hint="Use ANSI colors in the Coppice statusline." />
                    <Toggle label="Git info in statusline" checked={form.claude_cli_statusline_git} onChange={(claude_cli_statusline_git) => setForm({ ...form, claude_cli_statusline_git })} hint="Show branch and changed-file counts. Cost, username, and account are never shown." />
                  </div>
                )}
              </div>
              <div className="space-y-3">
                <Toggle label="CLI notifications" checked={form.claude_cli_notifications} onChange={(claude_cli_notifications) => setForm({ ...form, claude_cli_notifications })} hint="Use Claude Code notification hooks and terminal bell fallback to alert Coppice when CLI tabs need attention." />
                <Toggle label="Fullscreen TUI" checked={form.claude_cli_fullscreen} onChange={(claude_cli_fullscreen) => setForm({ ...form, claude_cli_fullscreen })} hint="Use Claude Code's fullscreen renderer to avoid duplicate redraws in scrollback." />
                <Toggle label="Terminal progress" checked={form.claude_cli_terminal_progress} onChange={(claude_cli_terminal_progress) => setForm({ ...form, claude_cli_terminal_progress })} hint="Let Claude Code emit terminal progress updates; Coppice displays them on the tab." />
              </div>
            </div>
          )}

          {/* Claude Agent settings */}
          {agentConfigTab === "claude" && (
            <div className="space-y-4 rounded-lg border border-accent/20 bg-accent/[0.03] p-4">
              <ClaudeAuthSection />
              <div className="flex items-center gap-2">
                <div className="flex-1 border-t border-border-primary" />
                <span className="text-[length:var(--app-font-10)] text-text-tertiary">or use an API key</span>
                <div className="flex-1 border-t border-border-primary" />
              </div>
              <Field
                label="Anthropic API key"
                value={form.agent_api_key}
                onChange={(agent_api_key) => setForm({ ...form, agent_api_key })}
                placeholder="sk-ant-..."
                hint="Your Anthropic API key for the Agent SDK"
              />
              <Field
                label="Base URL"
                value={form.agent_base_url}
                onChange={(agent_base_url) => setForm({ ...form, agent_base_url })}
                placeholder="https://api.anthropic.com"
                hint="API endpoint. Set to your LiteLLM proxy (e.g. http://localhost:4000) to use other models like GPT-4o or Gemini via the same agentic flow."
              />
              {form.agent_base_url && (
                <Toggle
                  label="Use proxy for custom models only"
                  checked={form.agent_base_url_custom_only}
                  onChange={(agent_base_url_custom_only) =>
                    setForm({ ...form, agent_base_url_custom_only })
                  }
                  hint="When enabled, Claude models go direct to Anthropic while custom models (e.g. openai/gpt-4o) route through the proxy."
                />
              )}
              {form.agent_api_key && (
                <Toggle
                  label="Use API key for custom models only"
                  checked={form.agent_api_key_custom_only}
                  onChange={(agent_api_key_custom_only) =>
                    setForm({ ...form, agent_api_key_custom_only })
                  }
                  hint="When enabled, Claude models use the default SDK key while custom models (e.g. openai/gpt-4o) use this API key."
                />
              )}
              <ModelCombobox
                label="Default model"
                value={form.agent_default_model}
                onChange={(agent_default_model) => setForm({ ...form, agent_default_model })}
                presets={[
                  { value: "", label: "(SDK default)" },
                  ...SUPPORTED_MODELS,
                ]}
                hint="Pick a Claude preset or type a custom model (e.g. openai/gpt-4o for LiteLLM)."
                placeholder="(SDK default)"
              />
              <SettingsEffortDropdown
                label="Default effort"
                value={form.agent_default_effort}
                onChange={(agent_default_effort) => setForm({ ...form, agent_default_effort })}
                options={CLAUDE_EFFORT_OPTIONS}
                hint="Controls how much effort the agent puts into responses"
              />
              <Field
                label="Small/fast model override"
                value={form.agent_small_fast_model}
                onChange={(agent_small_fast_model) => setForm({ ...form, agent_small_fast_model })}
                placeholder="(SDK default — Haiku)"
                hint="Model used for lightweight tool calls. Set to your primary model to prevent Haiku switching, or leave blank for SDK default."
              />
              <Field
                label="Subagent model"
                value={form.agent_subagent_model}
                onChange={(agent_subagent_model) => setForm({ ...form, agent_subagent_model })}
                placeholder="(SDK default — Sonnet)"
                hint="Model for Task (subagent) tool calls. Use 'haiku' for cheaper subagents, 'inherit' to match parent model."
              />
              <Field
                label="Bash max output length"
                value={form.agent_bash_max_output ? String(form.agent_bash_max_output) : ""}
                onChange={(v) => setForm({ ...form, agent_bash_max_output: parseInt(v) || 0 })}
                placeholder="30000"
                hint="Max characters of Bash tool output kept in context (SDK default: 30000). Lower values reduce token usage."
              />
              <Field
                label="Task max output length"
                value={form.agent_task_max_output ? String(form.agent_task_max_output) : ""}
                onChange={(v) => setForm({ ...form, agent_task_max_output: parseInt(v) || 0 })}
                placeholder="30000"
                hint="Max characters of Task (subagent) output returned to parent context (SDK default: 30000)."
              />
            </div>
          )}

          {/* Pi Agent settings */}
          {agentConfigTab === "pi" && (
            <div className="space-y-5 rounded-lg border border-purple-400/20 bg-purple-500/[0.04] p-4">
              <PiSettingsSection form={form} setForm={setForm} />
            </div>
          )}

          {/* MCP settings */}
          <div className="space-y-4 rounded-lg border border-border-primary bg-bg-primary/30 p-4">
            <McpServersEditor
              servers={form.mcp_servers}
              onChange={(mcp_servers) => setForm({ ...form, mcp_servers })}
            />
          </div>

        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end px-6 py-4 border-t border-border-primary gap-2 bg-bg-secondary">
          <button
            onClick={closeAppSettings}
            className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded transition-colors"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

const API_KEY_PLACEHOLDERS: Record<string, string> = {
  anthropic: "sk-ant-...",
  openai: "sk-...",
  google: "AIza...",
  "google-vertex": "AIza...",
  deepseek: "sk-...",
  mistral: "...",
  groq: "gsk_...",
  cerebras: "csk-...",
  xai: "xai-...",
  openrouter: "sk-or-...",
  fireworks: "fw_...",
  "github-copilot": "ghu_... or ghp_...",
  huggingface: "hf_...",
  "azure-openai-responses": "...",
};

const API_KEY_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  huggingface: "HF_TOKEN",
  "kimi-coding": "KIMI_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
};

/** Pretty-print a provider slug: "openai" → "OpenAI", "amazon-bedrock" → "Amazon Bedrock" */
function formatProvider(slug: string): string {
  const overrides: Record<string, string> = {
    openai: "OpenAI", xai: "xAI", deepseek: "DeepSeek", openrouter: "OpenRouter",
    "amazon-bedrock": "Bedrock", "azure-openai-responses": "Azure OpenAI",
    "google-vertex": "Vertex AI", "github-copilot": "Copilot",
    "cloudflare-ai-gateway": "CF Gateway", "cloudflare-workers-ai": "CF Workers",
    "openai-codex": "Codex", "vercel-ai-gateway": "Vercel AI",
  };
  return overrides[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** Well-known Pi providers — always shown even before a session is started. */
const PI_KNOWN_PROVIDERS = [
  "anthropic", "openai", "google", "deepseek", "mistral",
  "groq", "cerebras", "xai", "openrouter", "fireworks",
  "amazon-bedrock", "google-vertex", "github-copilot", "azure-openai-responses",
];

// ── Claude Code auth section ──

function ClaudeAuthSection() {
  const cachedAuth = useAppStore((s) => s.claudeAuthInfo);
  const refreshClaudeAuth = useAppStore((s) => s.refreshClaudeAuth);
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">(
    cachedAuth?.loggedIn ? "success" : "idle"
  );
  const [message, setMessage] = useState(() => {
    if (!cachedAuth?.loggedIn) return "";
    return cachedAuth.email
      ? `Signed in as ${cachedAuth.email}${cachedAuth.orgName ? ` (${cachedAuth.orgName})` : ""}`
      : "Signed in to Claude";
  });

  // Background refresh on mount — cached value shows instantly, CLI updates if stale
  useEffect(() => {
    refreshClaudeAuth();
  }, []);

  useEffect(() => {
    if (!cachedAuth) return;
    if (cachedAuth.loggedIn) {
      setStatus("success");
      setMessage(
        cachedAuth.email
          ? `Signed in as ${cachedAuth.email}${cachedAuth.orgName ? ` (${cachedAuth.orgName})` : ""}`
          : "Signed in to Claude"
      );
    } else if (status !== "pending" && status !== "error") {
      setStatus("idle");
      setMessage("");
    }
  }, [cachedAuth]);

  const handleLogin = async () => {
    setStatus("pending");
    setMessage("Opening browser for authentication...");
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<string>("claude-auth-event", (event) => {
        try {
          const msg = JSON.parse(event.payload);
          if (msg.type === "success") {
            setStatus("success");
            setMessage("Signed in to Claude");
            refreshClaudeAuth();
            unlisten();
          } else if (msg.type === "error") {
            setStatus("error");
            setMessage(msg.message || "Login failed");
            unlisten();
          } else if (msg.type === "progress") {
            setMessage(msg.message || "Waiting for authorization...");
          }
        } catch {}
      });
      await claudeAuthLogin();
    } catch (err) {
      setStatus("error");
      setMessage(String(err));
    }
  };

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleLogin}
          disabled={status === "pending"}
          className={`px-3 py-1.5 text-[length:var(--app-font-11)] font-medium rounded transition-colors ${
            status === "success"
              ? "bg-green-500/15 text-green-400 border border-green-500/30"
              : status === "pending"
                ? "bg-purple-500/10 text-purple-400 border border-purple-500/30 animate-pulse"
                : "bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500/20"
          }`}
        >
          {status === "pending" ? "Waiting for authorization..." :
           status === "success" ? "✓ Signed in" :
           "Login with Claude subscription"}
        </button>
      </div>
      {message && (
        <p className={`mt-1.5 text-[length:var(--app-font-10)] ${
          status === "error" ? "text-red-400" :
          status === "success" ? "text-green-400/70" :
          "text-text-tertiary"
        }`}>
          {message}
        </p>
      )}
      {status !== "success" && status !== "pending" && (
        <p className="mt-1 text-[length:var(--app-font-10)] text-text-tertiary">
          Uses your Claude Pro/Max/Team subscription — no API key needed
        </p>
      )}
    </div>
  );
}

/** Providers that support OAuth login (no API key needed). */
const OAUTH_PROVIDERS = new Set(["anthropic", "github-copilot", "openai-codex"]);

function PiAuthSection({ provider, form, setForm }: {
  provider: string;
  form: AppSettings;
  setForm: (f: AppSettings) => void;
}) {
  const [oauthStatus, setOauthStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [oauthMessage, setOauthMessage] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const supportsOAuth = OAUTH_PROVIDERS.has(provider);

  useEffect(() => {
    if (!supportsOAuth) return;
    piOAuthCheck().then((providers) => {
      if (providers[provider]) {
        setOauthStatus("success");
        setOauthMessage(`Logged in to ${formatProvider(provider)}`);
      }
    }).catch(() => {});
  }, [provider]);

  const currentKey = provider === "anthropic"
    ? form.agent_api_key || ""
    : (form.pi_api_keys || {})[provider] || "";

  const handleOAuthLogin = async () => {
    setOauthStatus("pending");
    setOauthMessage("Starting login...");
    setDeviceCode("");
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<string>("pi-oauth-event", (event) => {
        try {
          const msg = JSON.parse(event.payload);
          if (msg.type === "auth") {
            // Device code flow — show the code to the user
            if (msg.instructions) {
              setDeviceCode(msg.instructions);
            }
            setOauthMessage("Waiting for authorization in browser...");
          } else if (msg.type === "progress") {
            setOauthMessage(msg.message);
          } else if (msg.type === "success") {
            setOauthStatus("success");
            setOauthMessage(`Logged in to ${formatProvider(provider)}`);
            setDeviceCode("");
            // Clear the API key for this provider — OAuth credentials in
            // ~/.pi/agent/auth.json take over. If we leave the old key,
            // it gets sent as an env var and overrides the OAuth token.
            if (provider === "anthropic") {
              setForm({ ...form, agent_api_key: "" });
            } else {
              const keys = { ...(form.pi_api_keys || {}) };
              delete keys[provider];
              setForm({ ...form, pi_api_keys: keys });
            }
            unlisten();
          } else if (msg.type === "error") {
            setOauthStatus("error");
            setOauthMessage(msg.message);
            setDeviceCode("");
            unlisten();
          }
        } catch {}
      });
      await piOAuthLogin(provider);
    } catch (err) {
      setOauthStatus("error");
      setOauthMessage(String(err));
    }
  };

  return (
    <div className="space-y-3">
      {/* OAuth login button for supported providers */}
      {supportsOAuth && (
        <div>
          <button
            type="button"
            onClick={handleOAuthLogin}
            disabled={oauthStatus === "pending"}
            className={`px-3 py-1.5 text-[length:var(--app-font-11)] font-medium rounded transition-colors ${
              oauthStatus === "success"
                ? "bg-green-500/15 text-green-400 border border-green-500/30"
                : oauthStatus === "pending"
                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/30 animate-pulse"
                  : "bg-purple-500/10 text-purple-400 border border-purple-500/30 hover:bg-purple-500/20"
            }`}
          >
            {oauthStatus === "pending" ? "Waiting for authorization..." :
             oauthStatus === "success" ? "✓ Logged in" :
             `Login with ${formatProvider(provider)} subscription`}
          </button>

          {/* Device code — shown prominently for GitHub Copilot device flow */}
          {deviceCode && (
            <div className="mt-2.5 p-3 rounded bg-bg-tertiary border border-purple-500/30">
              <p className="text-[length:var(--app-font-11)] text-text-secondary mb-1">
                Enter this code in your browser:
              </p>
              <p className="text-lg font-mono font-bold text-purple-400 tracking-widest select-all">
                {deviceCode.replace(/^Enter code:\s*/i, "")}
              </p>
            </div>
          )}

          {oauthMessage && !deviceCode && oauthStatus !== "idle" && (
            <p className={`mt-1 text-[length:var(--app-font-10)] ${
              oauthStatus === "error" ? "text-red-400" :
              oauthStatus === "success" ? "text-green-400" : "text-text-tertiary"
            }`}>
              {oauthMessage}
            </p>
          )}
          <p className="mt-1.5 text-[length:var(--app-font-10)] text-text-tertiary">
            {oauthStatus === "idle"
              ? "Uses your existing subscription — no API key needed."
              : oauthStatus === "pending"
                ? "Complete authorization in your browser, then return here."
                : "Credentials saved to ~/.pi/agent/auth.json"}
          </p>
        </div>
      )}

      {/* Divider between OAuth and API key */}
      {supportsOAuth && (
        <div className="flex items-center gap-2">
          <div className="flex-1 border-t border-border-primary" />
          <span className="text-[length:var(--app-font-10)] text-text-tertiary">or use an API key</span>
          <div className="flex-1 border-t border-border-primary" />
        </div>
      )}

      {/* Manual API key input */}
      <div>
        <input
          type="password"
          value={currentKey}
          onChange={(e) => {
            if (provider === "anthropic") {
              setForm({ ...form, agent_api_key: e.target.value });
            } else {
              setForm({
                ...form,
                pi_api_keys: { ...(form.pi_api_keys || {}), [provider]: e.target.value },
              });
            }
          }}
          placeholder={API_KEY_PLACEHOLDERS[provider] || "API key"}
          className="w-full px-2.5 py-1.5 text-xs bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary font-mono"
        />
        <p className="mt-1 text-[length:var(--app-font-10)] text-text-tertiary">
          {provider === "anthropic"
            ? "Shared with Claude Agent mode. Also set via ANTHROPIC_API_KEY env var."
            : `Set via ${API_KEY_ENV_VARS[provider] || "environment variable"} or enter here.`}
        </p>
      </div>
    </div>
  );
}

/** Fallback models per provider — shown before a Pi session populates the full list. */
const PI_FALLBACK_MODELS: Record<string, Array<{ value: string; label: string; contextWindow?: number; reasoning?: boolean }>> = {
  anthropic: [
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4", contextWindow: 200000, reasoning: true },
    { value: "claude-opus-4-20250515", label: "Claude Opus 4", contextWindow: 200000, reasoning: true },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", contextWindow: 200000, reasoning: true },
  ],
  openai: [
    { value: "gpt-4o", label: "GPT-4o", contextWindow: 128000 },
    { value: "gpt-4o-mini", label: "GPT-4o Mini", contextWindow: 128000 },
    { value: "o3", label: "o3", contextWindow: 200000, reasoning: true },
    { value: "o4-mini", label: "o4 Mini", contextWindow: 200000, reasoning: true },
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", contextWindow: 1048576, reasoning: true },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1048576, reasoning: true },
  ],
  deepseek: [
    { value: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 65536 },
    { value: "deepseek-reasoner", label: "DeepSeek Reasoner", contextWindow: 65536, reasoning: true },
  ],
  mistral: [
    { value: "mistral-large-latest", label: "Mistral Large", contextWindow: 131072 },
    { value: "codestral-latest", label: "Codestral", contextWindow: 262144 },
  ],
  groq: [
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", contextWindow: 131072 },
  ],
  xai: [
    { value: "grok-3-fast", label: "Grok 3 Fast", contextWindow: 131072, reasoning: true },
    { value: "grok-3-mini-fast", label: "Grok 3 Mini Fast", contextWindow: 131072, reasoning: true },
  ],
  openrouter: [
    { value: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", contextWindow: 200000 },
    { value: "openai/gpt-4o", label: "GPT-4o", contextWindow: 128000 },
    { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", contextWindow: 1048576 },
  ],
};

function PiSettingsSection({ form, setForm }: { form: AppSettings; setForm: (f: AppSettings) => void }) {
  const piModels = useAppStore((s) => s.piAvailableModels);
  const [loading, setLoading] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [addProviderFilter, setAddProviderFilter] = useState("");
  const addProviderRef = useRef<HTMLDivElement>(null);
  const addProviderInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (piModels.length > 0) return;
    setLoading(true);
    piGetModels()
      .then((models) => {
        if (models && models.length > 0) {
          useAppStore.setState({ piAvailableModels: models });
        }
      })
      .catch((err) => console.warn("Failed to load Pi models:", err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!addProviderOpen) return;
    const handler = (e: MouseEvent) => {
      if (addProviderRef.current && !addProviderRef.current.contains(e.target as Node))
        setAddProviderOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [addProviderOpen]);

  useEffect(() => {
    if (addProviderOpen && addProviderInputRef.current) addProviderInputRef.current.focus();
  }, [addProviderOpen]);

  const configured = form.pi_configured_providers?.length > 0
    ? form.pi_configured_providers
    : ["anthropic"];

  const sdkProviders = [...new Set(piModels.map((m) => m.provider).filter(Boolean))] as string[];
  const allProviders = sdkProviders.length > 0 ? sdkProviders : PI_KNOWN_PROVIDERS;
  const unconfigured = allProviders.filter((p) => !configured.includes(p));
  const filteredUnconfigured = addProviderFilter
    ? unconfigured.filter((p) =>
        p.toLowerCase().includes(addProviderFilter.toLowerCase()) ||
        formatProvider(p).toLowerCase().includes(addProviderFilter.toLowerCase())
      )
    : unconfigured;

  const defaultProvider = form.pi_default_provider || configured[0] || "anthropic";

  const getModelsForProvider = (p: string) => {
    const sdk = piModels.filter((m) => m.provider === p);
    return sdk.length > 0
      ? sdk
      : (PI_FALLBACK_MODELS[p] || []).map((m) => ({ ...m, provider: p }));
  };

  const providerModels = getModelsForProvider(defaultProvider);
  const storedModelId = (form.pi_default_model || "").includes("/")
    ? form.pi_default_model.split("/").slice(1).join("/")
    : form.pi_default_model;
  const selectedModel = piModels.find((m) => m.value === storedModelId && m.provider === defaultProvider)
    ?? providerModels.find((m) => m.value === storedModelId);

  const addProvider = (p: string) => {
    const next = [...configured, p];
    setForm({ ...form, pi_configured_providers: next });
    setAddProviderOpen(false);
    setAddProviderFilter("");
  };

  const removeProvider = (p: string) => {
    const next = configured.filter((x) => x !== p);
    const updates: Partial<AppSettings> = { pi_configured_providers: next };
    // If removing the current default, reassign it
    if (defaultProvider === p) {
      updates.pi_default_provider = next[0] || "anthropic";
      const firstModel = piModels.find((m) => m.provider === (next[0] || "anthropic"));
      updates.pi_default_model = firstModel ? `${next[0]}/${firstModel.value}` : "";
    }
    setForm({ ...form, ...updates });
  };

  return (
    <div className="space-y-5">
      {loading && (
        <p className="text-[length:var(--app-font-10)] text-purple-400 animate-pulse">Loading models from Pi SDK...</p>
      )}

      {/* ── Default provider & model ── */}
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-secondary mb-1.5">Default provider</label>
          <PiProviderCombobox
            providers={configured}
            value={defaultProvider}
            onChange={(p) => {
              const firstModel = piModels.find((m) => m.provider === p);
              setForm({
                ...form,
                pi_default_provider: p,
                pi_default_model: firstModel ? `${p}/${firstModel.value}` : "",
              });
            }}
          />
        </div>

        <PiModelCombobox
          provider={defaultProvider}
          models={providerModels}
          value={form.pi_default_model}
          onChange={(pi_default_model) => setForm({ ...form, pi_default_model })}
        />
      </div>

      {/* ── Configured providers with per-provider auth ── */}
      <div className="pt-4 border-t border-border-primary">
        <label className="block text-xs text-text-secondary mb-1.5">Providers &amp; Authentication</label>
        <p className="text-[length:var(--app-font-10)] text-text-tertiary mb-3">
          Add providers you want to use. Each needs an API key or OAuth login.
        </p>
        <div className="space-y-2.5 mb-3">
          {configured.map((p) => (
            <PiProviderCard
              key={p}
              provider={p}
              form={form}
              setForm={setForm}
              canRemove={configured.length > 1}
              onRemove={() => removeProvider(p)}
            />
          ))}
        </div>
        {/* Add provider dropdown */}
        <div className="relative" ref={addProviderRef}>
          <button
            type="button"
            onClick={() => setAddProviderOpen(!addProviderOpen)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[length:var(--app-font-11)] rounded bg-bg-tertiary border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            Add Provider
          </button>
          {addProviderOpen && (
            <div className="absolute left-0 top-full mt-1 w-[220px] bg-bg-secondary border border-border-primary rounded-md shadow-lg z-10 overflow-hidden">
              <div className="px-2 py-1.5 border-b border-border-primary">
                <input
                  ref={addProviderInputRef}
                  type="text"
                  value={addProviderFilter}
                  onChange={(e) => setAddProviderFilter(e.target.value)}
                  placeholder="Search providers..."
                  className="w-full px-2 py-1 text-[length:var(--app-font-11)] bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
                />
              </div>
              <div className="max-h-[200px] overflow-y-auto py-1">
                {filteredUnconfigured.length > 0 ? filteredUnconfigured.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="w-full text-left px-3 py-1.5 text-[length:var(--app-font-11)] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
                    onClick={() => addProvider(p)}
                  >
                    {formatProvider(p)}
                  </button>
                )) : (
                  <p className="px-3 py-1.5 text-[length:var(--app-font-10)] text-text-tertiary">No more providers to add</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Thinking level */}
      <div className="pt-4 border-t border-border-primary">
        <SettingsEffortDropdown
          label="Thinking level"
          value={form.agent_default_effort || "medium"}
          onChange={(agent_default_effort) => setForm({ ...form, agent_default_effort })}
          options={PI_THINKING_OPTIONS}
          hint={`Controls reasoning depth. "Off" disables extended thinking. Higher levels use more tokens but produce better results.${selectedModel?.reasoning === false ? " Current model does not support extended thinking." : ""}`}
          purple
        />
      </div>

      {/* Tools section */}
      <div className="pt-4 border-t border-border-primary">
        <label className="block text-xs text-text-secondary mb-2">Tools</label>
        <Toggle
          label="Web access (search & fetch)"
          checked={form.pi_enable_web_access !== false}
          onChange={(pi_enable_web_access) => setForm({ ...form, pi_enable_web_access })}
          hint="Adds web_search and fetch_content tools via pi-web-access (supports Perplexity, Exa, Gemini)"
        />
        <Toggle
          label="Subagent (delegate to child agents)"
          checked={form.pi_enable_subagent !== false}
          onChange={(pi_enable_subagent) => setForm({ ...form, pi_enable_subagent })}
          hint="Allows the agent to spawn child sessions for parallel work, focused research, or code review"
        />
      </div>
    </div>
  );
}

/** Collapsible card for a single configured provider — shows auth inline. */
function PiProviderCard({ provider, form, setForm, canRemove, onRemove }: {
  provider: string;
  form: AppSettings;
  setForm: (f: AppSettings) => void;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [oauthConnected, setOauthConnected] = useState(false);

  const hasKey = provider === "anthropic"
    ? !!form.agent_api_key
    : !!(form.pi_api_keys || {})[provider];

  // Check OAuth status for badge display in header
  useEffect(() => {
    if (!OAUTH_PROVIDERS.has(provider)) return;
    piOAuthCheck().then((providers) => {
      if (providers[provider]) setOauthConnected(true);
    }).catch(() => {});
  }, [provider]);

  const authBadge = oauthConnected
    ? "connected"
    : hasKey
      ? "key set"
      : null;

  return (
    <div className="rounded-md border border-border-primary bg-bg-tertiary overflow-hidden">
      {/* Header row — always visible */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-bg-hover transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}>
          <path d="M2.5 1L5.5 4 2.5 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-xs font-medium text-text-primary flex-1">{formatProvider(provider)}</span>
        {authBadge && <span className="rounded-full bg-green-500/10 px-1.5 py-0.5 text-[length:var(--app-font-9)] text-green-400 shrink-0">{authBadge}</span>}
        {canRemove && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="text-text-tertiary hover:text-error transition-colors shrink-0"
            title="Remove provider"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {/* Expanded auth section */}
      {expanded && (
        <div className="px-3 pb-3 pt-3 border-t border-border-primary">
          <PiAuthSection provider={provider} form={form} setForm={setForm} />
        </div>
      )}
    </div>
  );
}

/** Dropdown for picking the default provider from the configured list. */
function PiProviderCombobox({ providers, value, onChange }: {
  providers: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (open && inputRef.current) inputRef.current.focus();
  }, [open]);

  const matched = providers.includes(value);
  const filtered = filter
    ? providers.filter((p) =>
        p.toLowerCase().includes(filter.toLowerCase()) ||
        formatProvider(p).toLowerCase().includes(filter.toLowerCase())
      )
    : providers;

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        onClick={() => { setOpen(!open); setFilter(""); }}
        className={`w-full flex items-center justify-between px-3 py-2 text-sm bg-bg-tertiary border rounded text-text-primary transition-colors ${
          open ? "border-purple-500/50" : "border-border-primary hover:border-border-secondary"
        }`}
      >
        <span>{matched ? formatProvider(value) : value || "Select provider"}</span>
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-bg-secondary border border-border-primary rounded shadow-lg overflow-hidden">
          {providers.length > 3 && (
            <div className="px-2 py-1.5 border-b border-border-primary">
              <input
                ref={inputRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter..."
                className="w-full px-2 py-1 text-[length:var(--app-font-11)] bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent"
              />
            </div>
          )}
          <div className="max-h-[200px] overflow-y-auto py-1">
            {filtered.map((p) => (
              <button
                key={p}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { onChange(p); setOpen(false); }}
                className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                  p === value
                    ? "bg-purple-500/10 text-purple-400"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                }`}
              >
                <span>{formatProvider(p)}</span>
                {p === value && (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-purple-400 shrink-0">
                    <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PiModelCombobox({ provider, models, value, onChange }: {
  provider: string;
  models: Array<{ value: string; label: string; contextWindow?: number; provider?: string }>;
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDocClick); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const storedModelId = (value || "").includes("/") ? value.split("/").slice(1).join("/") : value;
  const matchedPreset = models.find((m) => m.value === storedModelId);
  const filterText = matchedPreset ? "" : (value || "").toLowerCase();
  const filtered = filterText
    ? models.filter((m) => m.label.toLowerCase().includes(filterText) || m.value.toLowerCase().includes(filterText))
    : models;

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1.5">Model</label>
      <div className="relative" ref={wrapperRef}>
        <input
          ref={inputRef}
          type="text"
          value={matchedPreset && !inputFocused ? matchedPreset.label : value}
          onChange={(e) => {
            const val = e.target.value;
            onChange(val.includes("/") ? val : `${provider}/${val}`);
            setOpen(true);
          }}
          onFocus={() => {
            setInputFocused(true);
            setOpen(true);
            if (matchedPreset) onChange(`${provider}/${matchedPreset.value}`);
          }}
          onBlur={() => setInputFocused(false)}
          placeholder={`${provider}/model-id`}
          className={`w-full px-3 py-2 text-sm bg-bg-tertiary border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none transition-colors font-mono ${
            open ? "border-purple-500/50" : "border-border-primary hover:border-border-secondary"
          }`}
        />
        {open && filtered.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-bg-secondary border border-border-primary rounded shadow-lg max-h-60 overflow-y-auto py-1">
            {filtered.map((m) => {
              const isSelected = m.value === storedModelId;
              return (
                <button
                  key={m.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { onChange(`${provider}/${m.value}`); setOpen(false); }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left transition-colors ${
                    isSelected
                      ? "bg-purple-500/10 text-purple-400"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  <span>{m.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="mt-1 text-[length:var(--app-font-10)] text-text-tertiary">
        {models.length} models from {formatProvider(provider)}. Type to filter or enter a custom model ID.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors font-mono"
      />
      {hint && <p className="mt-0.5 text-[length:var(--app-font-10)] text-text-tertiary">{hint}</p>}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="flex items-center gap-2 cursor-pointer">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative w-8 h-[18px] rounded-full transition-colors ${
            checked ? "bg-accent" : "bg-bg-tertiary border border-border-primary"
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${
              checked ? "translate-x-[14px]" : ""
            }`}
          />
        </button>
        <span className="text-xs text-text-secondary">{label}</span>
      </label>
      {hint && <p className="mt-0.5 ml-10 text-[length:var(--app-font-10)] text-text-tertiary">{hint}</p>}
    </div>
  );
}

function ThemeDropdown({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ThemeMode;
  onChange: (v: ThemeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selected = THEME_OPTIONS.find((opt) => opt.value === value) ?? THEME_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <div className="relative" ref={wrapperRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm bg-bg-tertiary border rounded text-text-primary focus:outline-none transition-colors ${
            open ? "border-accent" : "border-border-primary hover:border-border-secondary"
          }`}
        >
          <span>{selected.label}</span>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-bg-secondary border border-border-primary rounded shadow-lg max-h-64 overflow-y-auto py-1">
            {THEME_OPTIONS.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors ${
                    isSelected
                      ? "bg-accent/15 text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block text-sm">{opt.label}</span>
                    <span className="block text-[length:var(--app-font-10)] text-text-tertiary truncate">{opt.hint}</span>
                  </span>
                  {isSelected && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-accent shrink-0">
                      <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <p className="mt-0.5 text-[length:var(--app-font-10)] text-text-tertiary">{selected.hint}</p>
    </div>
  );
}

function SettingsEffortDropdown({
  label,
  value,
  onChange,
  options,
  hint,
  purple,
}: {
  label: string;
  value: AppSettings["agent_default_effort"];
  onChange: (v: AppSettings["agent_default_effort"]) => void;
  options: Array<{ value: AppSettings["agent_default_effort"]; label: string }>;
  hint?: string;
  purple?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const activeValue = purple && value === "max" ? "xhigh" : value;
  const selected = options.find((opt) => opt.value === activeValue) ?? options[0];
  const activeClass = purple ? "bg-purple-500/10 text-purple-400" : "bg-accent/15 text-text-primary";
  const checkClass = purple ? "text-purple-400" : "text-accent";
  const openBorder = purple ? "border-purple-500/50" : "border-accent";

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <div className="relative" ref={wrapperRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm bg-bg-tertiary border rounded text-text-primary focus:outline-none transition-colors ${
            open ? openBorder : "border-border-primary hover:border-border-secondary"
          }`}
        >
          <span className="font-mono">{selected.label}</span>
          <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className={`transition-transform ${open ? "rotate-180" : ""}`}>
            <path d="M1.5 3L4 5.5 6.5 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-bg-secondary border border-border-primary rounded shadow-lg max-h-60 overflow-y-auto py-1">
            {options.map((opt) => {
              const isSelected = opt.value === activeValue;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm font-mono text-left transition-colors ${
                    isSelected
                      ? activeClass
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  <span>{opt.label}</span>
                  {isSelected && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={`${checkClass} shrink-0`}>
                      <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {hint && <p className="mt-0.5 text-[length:var(--app-font-10)] text-text-tertiary">{hint}</p>}
    </div>
  );
}

function ModelCombobox({
  label,
  value,
  onChange,
  presets,
  hint,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  presets: { value: string; label: string }[];
  hint?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Filter presets as user types (only when input has custom text)
  const matchedPreset = presets.find((p) => p.value === value);
  const filterText = matchedPreset ? "" : value.toLowerCase();
  const filteredPresets = filterText
    ? presets.filter(
        (p) =>
          p.label.toLowerCase().includes(filterText) ||
          p.value.toLowerCase().includes(filterText)
      )
    : presets;

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <div className="relative" ref={wrapperRef}>
        <input
          type="text"
          value={matchedPreset && !inputFocused ? matchedPreset.label : value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setInputFocused(true);
            setOpen(true);
            // If currently showing a preset label, switch to showing the raw value
            if (matchedPreset) {
              onChange(matchedPreset.value);
            }
          }}
          onBlur={() => setInputFocused(false)}
          placeholder={placeholder}
          className={`w-full px-3 py-1.5 text-sm bg-bg-tertiary border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none transition-colors font-mono ${
            open ? "border-accent" : "border-border-primary hover:border-border-secondary"
          }`}
        />
        {open && filteredPresets.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-bg-secondary border border-border-primary rounded shadow-lg max-h-60 overflow-y-auto py-1">
            {filteredPresets.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm font-mono text-left transition-colors ${
                    isSelected
                      ? "bg-accent/15 text-text-primary"
                      : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  }`}
                >
                  <span className={opt.value ? "" : "text-text-tertiary"}>{opt.label}</span>
                  {isSelected && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-accent shrink-0">
                      <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {hint && <p className="mt-0.5 text-[length:var(--app-font-10)] text-text-tertiary">{hint}</p>}
    </div>
  );
}

function parseMcpArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (const ch of input.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

// ─── MCP server editor ─────────────────────────────────────────────────────
//
// Three things go on here:
//   1. List installed servers with a live status badge + per-row actions
//      (Connect / Reauthorize / Test / Remove).
//   2. "Add" splits into two paths: a curated catalog (Rovo, GitHub
//      — one click + browser-driven OAuth) or a custom form for any other
//      stdio/sse/http server.
//   3. While an OAuth flow is in flight we listen to the Rust-side
//      `mcp-oauth-event` stream and surface progress inline.
//
// Catalog installs write to settings via Rust (so the OAuth flow has the
// server config in settings.toml immediately); the form's local state is
// then merged with the returned entry to keep the modal in sync.

type OauthEvent = {
  name: string;
  kind: "auth" | "progress" | "success" | "error";
  url?: string;
  message?: string;
};

function McpServersEditor({
  servers,
  onChange,
}: {
  servers: Record<string, McpServerEntry>;
  onChange: (servers: Record<string, McpServerEntry>) => void;
}) {
  const [mode, setMode] = useState<"none" | "catalog" | "custom">("none");
  const [catalog, setCatalog] = useState<McpCatalogEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, McpAuthStatus>>({});
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [installError, setInstallError] = useState<string>("");

  const refreshStatuses = useCallback(async () => {
    try {
      const list = await mcpGetAuthStatus();
      const map: Record<string, McpAuthStatus> = {};
      for (const s of list) map[s.name] = s;
      setStatuses(map);
    } catch (err) {
      console.warn("mcpGetAuthStatus:", err);
    }
  }, []);

  // Load catalog once + initial status snapshot.
  useEffect(() => {
    mcpGetCatalog().then(setCatalog).catch((e) => console.warn("mcpGetCatalog:", e));
    refreshStatuses();
  }, [refreshStatuses]);

  // Re-poll status every 8s while modal is open. Cheap (just reads the local secret store
  // entry expiry timestamps) and lets a token expiring during a flow tick
  // its badge from connected → expired without the user reopening settings.
  useEffect(() => {
    const id = setInterval(refreshStatuses, 8000);
    return () => clearInterval(id);
  }, [refreshStatuses]);

  // Refs so the long-lived event listener always sees the latest form state
  // and onChange callback without resubscribing on every form keystroke.
  const serversRef = useRef(servers);
  const onChangeRef = useRef(onChange);
  serversRef.current = servers;
  onChangeRef.current = onChange;

  // Listen for OAuth events from Rust. Updates per-server `busy` text and,
  // on success, flips the local entry's `oauth.connected` to true so the
  // badge updates without a save round-trip. Subscribed once for the life
  // of the modal.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<OauthEvent>("mcp-oauth-event", (e) => {
      const ev = e.payload;
      setBusy((prev) => {
        const next = { ...prev };
        if (ev.kind === "success" || ev.kind === "error") {
          delete next[ev.name];
        } else {
          next[ev.name] = ev.message || ev.kind;
        }
        return next;
      });
      if (ev.kind === "success") {
        const curServers = serversRef.current;
        const cur = curServers[ev.name];
        if (cur) {
          onChangeRef.current({
            ...curServers,
            [ev.name]: {
              ...cur,
              oauth: {
                ...(cur.oauth || {}),
                connected: true,
                last_auth_at: Math.floor(Date.now() / 1000),
              },
            },
          });
        }
        refreshStatuses();
      } else if (ev.kind === "error") {
        setTestResults((prev) => ({ ...prev, [ev.name]: `error: ${ev.message || "OAuth failed"}` }));
      }
    }).then((fn) => {
      unlisten = fn;
    }).catch((err) => console.warn("mcp-oauth-event listen:", err));
    return () => {
      if (unlisten) unlisten();
    };
  }, [refreshStatuses]);

  const handleRemove = async (name: string) => {
    const entry = servers[name];
    if (entry?.oauth) {
      try {
        await mcpOauthRevoke(name);
      } catch (e) {
        console.warn("mcpOauthRevoke:", e);
      }
    }
    const next = { ...servers };
    delete next[name];
    onChange(next);
  };

  const handleConnect = async (name: string) => {
    setBusy((prev) => ({ ...prev, [name]: "Starting…" }));
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      await mcpOauthStart(name);
    } catch (e) {
      setBusy((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setTestResults((prev) => ({ ...prev, [name]: `error: ${String(e)}` }));
    }
  };

  const handleTest = async (name: string) => {
    setTestResults((prev) => ({ ...prev, [name]: "Testing…" }));
    try {
      const r = await mcpTestConnection(name);
      setTestResults((prev) => ({
        ...prev,
        [name]: `${r.ok ? "ok" : "fail"}: ${r.message}`,
      }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [name]: `error: ${String(e)}` }));
    }
  };

  const handleInstallCatalog = async (
    entry: McpCatalogEntry,
    opts: { autoConnect: boolean; token?: string },
  ) => {
    setInstallError("");
    try {
      const installed = await mcpInstallCatalogEntry(entry.id, opts.token);
      onChange({ ...servers, [installed.name]: installed.entry });
      setMode("none");
      if (opts.autoConnect && entry.auth === "oauth") {
        // Small delay so the new entry is in settings.toml before we read it.
        setTimeout(() => handleConnect(installed.name), 50);
      }
      refreshStatuses();
    } catch (e) {
      setInstallError(String(e));
    }
  };

  const handleAddCustom = (entry: McpServerEntry, name: string) => {
    onChange({ ...servers, [name]: entry });
    setMode("none");
  };

  const entries = Object.entries(servers);

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">MCP Servers</label>
      <p className="text-[length:var(--app-font-10)] text-text-tertiary mb-2">
        Additional MCP servers available to Claude Agent and Pi Agent sessions. OAuth tokens are stored in Coppice's encrypted local secret store.
      </p>

      {entries.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {entries.map(([name, entry]) => (
            <McpServerRow
              key={name}
              name={name}
              entry={entry}
              status={statuses[name]}
              busy={busy[name]}
              testResult={testResults[name]}
              onConnect={() => handleConnect(name)}
              onTest={() => handleTest(name)}
              onRemove={() => handleRemove(name)}
            />
          ))}
        </div>
      )}

      {mode === "catalog" && (
        <McpCatalogPicker
          catalog={catalog}
          onInstall={handleInstallCatalog}
          onCancel={() => {
            setMode("none");
            setInstallError("");
          }}
          error={installError}
        />
      )}
      {mode === "custom" && (
        <McpCustomForm
          existingNames={new Set(Object.keys(servers))}
          onAdd={handleAddCustom}
          onCancel={() => setMode("none")}
        />
      )}

      {mode === "none" && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode("catalog")}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-accent/10 border border-accent/30 text-accent hover:bg-accent/15 transition-colors"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            Add from catalog
          </button>
          <button
            type="button"
            onClick={() => setMode("custom")}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded bg-bg-tertiary border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          >
            Add custom server
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Per-row status + actions ──────────────────────────────────────────────

function statusDotClass(status?: string): string {
  switch (status) {
    case "connected":
      return "bg-green-500";
    case "expired":
      return "bg-amber-500";
    case "disconnected":
      return "bg-text-tertiary";
    case "error":
      return "bg-red-500";
    default:
      return "bg-text-tertiary/50";
  }
}

function statusLabel(entry: McpServerEntry, status?: McpAuthStatus): string {
  if (!entry.oauth) return entry.server_type;
  if (!status) return "loading";
  return status.status;
}

function McpServerRow({
  name,
  entry,
  status,
  busy,
  testResult,
  onConnect,
  onTest,
  onRemove,
}: {
  name: string;
  entry: McpServerEntry;
  status?: McpAuthStatus;
  busy?: string;
  testResult?: string;
  onConnect: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const isOauth = !!entry.oauth;
  const isConnected = status?.status === "connected";
  const isRemote = entry.server_type !== "stdio";
  // Custom servers haven't been through OAuth yet but still get a Connect
  // button — clicking it triggers discovery + dynamic registration on the
  // fly. If the server doesn't support OAuth, we surface a clear error.
  const showConnect = isRemote;
  // A user-supplied static `Authorization` header signals intent to use
  // their own bearer token, not OAuth. Skip the badge in that case to
  // avoid implying the server isn't authenticated.
  const hasManualAuth =
    !isOauth &&
    !!entry.headers &&
    Object.keys(entry.headers).some((k) => k.toLowerCase() === "authorization");
  const showStatus = isOauth;
  const endpoint = entry.server_type === "stdio"
    ? [entry.command, ...(entry.args || [])].filter(Boolean).join(" ")
    : entry.url || "";
  const subLabel = entry.catalog_id ? `${entry.catalog_id} · ${entry.server_type}` : entry.server_type;
  const testTone = testResult?.startsWith("ok:")
    ? "text-green-500"
    : testResult?.startsWith("fail:") || testResult?.startsWith("error:")
    ? "text-red-400"
    : "text-text-tertiary";

  return (
    <div className="px-2.5 py-2 bg-bg-tertiary border border-border-primary rounded text-xs space-y-1.5">
      <div className="flex items-center gap-2">
        {showStatus && (
          <span
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${statusDotClass(status?.status)}`}
            title={statusLabel(entry, status)}
          />
        )}
        <span className="font-mono font-medium text-text-primary">{name}</span>
        <span className="px-1.5 py-0.5 rounded bg-bg-secondary border border-border-primary text-[length:var(--app-font-10)] text-text-tertiary">
          {subLabel}
        </span>
        {showStatus && (
          <span className="text-[length:var(--app-font-10)] text-text-tertiary">{statusLabel(entry, status)}</span>
        )}
        {hasManualAuth && (
          <span className="text-[length:var(--app-font-10)] text-text-tertiary" title="Static Authorization header configured">
            manual auth
          </span>
        )}
        <span className="text-text-tertiary truncate flex-1 text-[length:var(--app-font-10)]" title={endpoint}>
          {endpoint}
        </span>
        <button
          type="button"
          className="text-text-tertiary hover:text-error transition-colors shrink-0"
          onClick={onRemove}
          title={isOauth ? "Remove server (revokes OAuth tokens)" : "Remove server"}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        {showConnect && (
          <button
            type="button"
            onClick={onConnect}
            disabled={!!busy}
            className={`px-2 py-0.5 text-[length:var(--app-font-10)] rounded border transition-colors disabled:opacity-50 ${
              isConnected
                ? "bg-bg-primary border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                : "bg-accent/10 border-accent/40 text-accent hover:bg-accent/15"
            }`}
            title={isOauth
              ? (isConnected ? "Re-run OAuth flow" : "Authorize via OAuth")
              : "Try OAuth — Coppice will probe the server for its auth endpoints"}
          >
            {busy ? "…" : isConnected ? "Reauthorize" : "Connect"}
          </button>
        )}
        <button
          type="button"
          onClick={onTest}
          className="px-2 py-0.5 text-[length:var(--app-font-10)] rounded bg-bg-primary border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          Test
        </button>
        {busy && <span className="text-[length:var(--app-font-10)] text-amber-400 ml-1">{busy}</span>}
        {testResult && !busy && (
          <span className={`text-[length:var(--app-font-10)] ml-1 ${testTone} truncate max-w-[260px]`} title={testResult}>
            {testResult}
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Catalog picker ────────────────────────────────────────────────────────

function McpCatalogPicker({
  catalog,
  onInstall,
  onCancel,
  error,
}: {
  catalog: McpCatalogEntry[];
  onInstall: (entry: McpCatalogEntry, opts: { autoConnect: boolean; token?: string }) => void;
  onCancel: () => void;
  error?: string;
}) {
  return (
    <div className="space-y-2 p-2.5 bg-bg-tertiary border border-border-primary rounded">
      <div className="flex items-center justify-between">
        <div className="text-[length:var(--app-font-10)] uppercase tracking-wide text-text-tertiary">Curated MCP servers</div>
        <button
          type="button"
          onClick={onCancel}
          className="text-text-tertiary hover:text-text-primary"
          title="Cancel"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {catalog.length === 0 && (
        <div className="text-[length:var(--app-font-10)] text-text-tertiary">Loading catalog…</div>
      )}
      <div className="space-y-1.5">
        {catalog.map((entry) => (
          <McpCatalogRow key={entry.id} entry={entry} onInstall={onInstall} />
        ))}
      </div>
      {error && <div className="text-[length:var(--app-font-10)] text-red-400">{error}</div>}
    </div>
  );
}

function McpCatalogRow({
  entry,
  onInstall,
}: {
  entry: McpCatalogEntry;
  onInstall: (entry: McpCatalogEntry, opts: { autoConnect: boolean; token?: string }) => void;
}) {
  // For static-bearer entries we need a token before installing. Keep it
  // local so other rows aren't re-rendered on each keystroke. The `Add &
  // Connect` button stays disabled until the field has content.
  const [token, setToken] = useState("");
  const isStaticBearer = entry.auth === "static-bearer";
  const isOauth = entry.auth === "oauth";
  const trimmedToken = token.trim();
  const canSubmit = isStaticBearer ? !!trimmedToken : true;

  const submit = () => {
    if (!canSubmit) return;
    onInstall(entry, {
      autoConnect: isOauth,
      token: isStaticBearer ? trimmedToken : undefined,
    });
  };

  const buttonLabel = isOauth ? "Add & Connect" : isStaticBearer ? "Add with token" : "Add";

  return (
    <div className="p-2 bg-bg-primary/40 border border-border-primary rounded space-y-1.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-text-primary">{entry.display_name}</span>
            <span className="px-1 py-0.5 rounded bg-bg-secondary text-[length:var(--app-font-9)] text-text-tertiary">
              {entry.server_type}
            </span>
            {isOauth && <span className="px-1 py-0.5 rounded bg-accent/10 text-[length:var(--app-font-9)] text-accent">OAuth</span>}
            {isStaticBearer && (
              <span className="px-1 py-0.5 rounded bg-amber-500/10 text-[length:var(--app-font-9)] text-amber-400">Token</span>
            )}
          </div>
          <div className="text-[length:var(--app-font-10)] text-text-tertiary mt-0.5">{entry.description}</div>
          <div
            className="text-[length:var(--app-font-9)] text-text-tertiary/70 mt-0.5 font-mono truncate"
            title={entry.url}
          >
            {entry.url}
          </div>
        </div>
        {!isStaticBearer && (
          <button
            type="button"
            onClick={submit}
            className="shrink-0 px-2 py-1 text-[length:var(--app-font-10)] rounded bg-accent hover:bg-accent-hover text-white transition-colors"
          >
            {buttonLabel}
          </button>
        )}
      </div>

      {isStaticBearer && (
        <div className="space-y-1.5">
          {entry.token_help && (
            <div className="text-[length:var(--app-font-9)] text-text-tertiary">{entry.token_help}</div>
          )}
          <div className="flex gap-1.5">
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Paste token here"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 px-2 py-1 text-[length:var(--app-font-10)] bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!canSubmit}
              className="shrink-0 px-2 py-1 text-[length:var(--app-font-10)] rounded bg-accent hover:bg-accent-hover disabled:opacity-40 text-white transition-colors"
            >
              {buttonLabel}
            </button>
          </div>
          {entry.token_url && (
            <a
              href={entry.token_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[length:var(--app-font-10)] text-accent hover:underline"
            >
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                <path d="M5 7L11 1M11 1H7M11 1V5M9 7v3a1 1 0 01-1 1H2a1 1 0 01-1-1V4a1 1 0 011-1h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Generate token →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Custom server form ────────────────────────────────────────────────────

function McpCustomForm({
  existingNames,
  onAdd,
  onCancel,
}: {
  existingNames: Set<string>;
  onAdd: (entry: McpServerEntry, name: string) => void;
  onCancel: () => void;
}) {
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState<"stdio" | "sse" | "http">("stdio");
  const [editCommand, setEditCommand] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editEnv, setEditEnv] = useState("");
  const [editHeaders, setEditHeaders] = useState("");

  const trimmedName = editName.trim();
  const nameTaken = existingNames.has(trimmedName);
  const canAdd =
    !!trimmedName && !nameTaken && (editType === "stdio" ? !!editCommand.trim() : !!editUrl.trim());

  const handleAdd = () => {
    if (!canAdd) return;
    const entry: McpServerEntry = { server_type: editType };
    if (editType === "stdio") {
      entry.command = editCommand.trim();
      const args = editArgs.trim();
      if (args) entry.args = parseMcpArgs(args);
      const envPairs = editEnv.trim();
      if (envPairs) {
        entry.env = {};
        for (const line of envPairs.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) entry.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
        }
      }
    } else {
      entry.url = editUrl.trim() || undefined;
      const headerPairs = editHeaders.trim();
      if (headerPairs) {
        entry.headers = {};
        for (const line of headerPairs.split("\n")) {
          const colon = line.indexOf(":");
          if (colon > 0) entry.headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        }
      }
    }
    onAdd(entry, trimmedName);
  };

  return (
    <div className="space-y-2 p-2.5 bg-bg-tertiary border border-border-primary rounded">
      <div className="flex gap-2">
        <input
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          placeholder="Server name"
          className="flex-1 px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
        />
        <div className="flex rounded overflow-hidden border border-border-primary">
          {(["stdio", "sse", "http"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setEditType(t)}
              className={`px-2 py-1 text-[length:var(--app-font-10)] transition-colors ${
                editType === t
                  ? "bg-accent text-white"
                  : "bg-bg-primary text-text-secondary hover:bg-bg-hover"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      {nameTaken && (
        <div className="text-[length:var(--app-font-10)] text-red-400">A server named "{trimmedName}" already exists.</div>
      )}

      {editType === "stdio" ? (
        <>
          <input
            type="text"
            value={editCommand}
            onChange={(e) => setEditCommand(e.target.value)}
            placeholder="Command (e.g., npx)"
            className="w-full px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
          />
          <input
            type="text"
            value={editArgs}
            onChange={(e) => setEditArgs(e.target.value)}
            placeholder={'Arguments (quote values with spaces, e.g., -y @some/mcp-server "--flag=value with spaces")'}
            className="w-full px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
          />
          <textarea
            value={editEnv}
            onChange={(e) => setEditEnv(e.target.value)}
            placeholder={"Environment variables (one per line):\nSLACK_TOKEN=xoxb-...\nOTHER_VAR=value"}
            rows={2}
            className="w-full px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono resize-none"
          />
        </>
      ) : (
        <>
          <input
            type="text"
            value={editUrl}
            onChange={(e) => setEditUrl(e.target.value)}
            placeholder="URL (e.g., https://example.com/mcp/sse)"
            className="w-full px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
          />
          <textarea
            value={editHeaders}
            onChange={(e) => setEditHeaders(e.target.value)}
            placeholder={"Headers (one per line, name: value):\nAuthorization: Bearer your-static-token\nX-Org-Id: 1234"}
            rows={2}
            className="w-full px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono resize-none"
          />
          <p className="text-[length:var(--app-font-9)] text-text-tertiary">
            For OAuth-protected servers, prefer "Add from catalog" — Coppice will run the OAuth flow and store tokens in its encrypted local secret store.
          </p>
        </>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleAdd}
          disabled={!canAdd}
          className="px-2.5 py-1 text-xs rounded bg-accent hover:bg-accent-hover disabled:opacity-40 text-white transition-colors"
        >
          Add
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-2.5 py-1 text-xs rounded text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
