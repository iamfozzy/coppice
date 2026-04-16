import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import * as commands from "../../lib/commands";
import type { AppSettings, McpServerEntry } from "../../lib/types";

const defaultSettings: AppSettings = {
  editor_command: "",
  claude_command: "",
  terminal_font_family: "",
  terminal_font_size: 0,
  terminal_emulator: "",
  shell: "",
  window_decorations: true,
  notification_sound: true,
  notification_popup: true,
  default_claude_mode: "terminal",
  agent_default_model: "",
  agent_default_effort: "high",
  agent_node_path: "",
  agent_api_key: "",
  mcp_servers: {},
};

export function AppSettingsModal() {
  const appSettings = useAppStore((s) => s.appSettings);
  const closeAppSettings = useAppStore((s) => s.closeAppSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const [form, setForm] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  const [hooksLoading, setHooksLoading] = useState(false);

  useEffect(() => {
    if (appSettings) {
      setForm({ ...appSettings });
    }
  }, [appSettings]);

  // Check hook installation status when the modal opens.
  useEffect(() => {
    commands.checkClaudeHooksInstalled().then(setHooksInstalled).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveSettings(form);
      closeAppSettings();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeAppSettings();
      }}
    >
      <div className="bg-bg-secondary border border-border-primary rounded-lg w-[520px] max-h-[85vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
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
        <div className="px-5 py-4 space-y-4">
          <p className="text-[11px] text-text-tertiary">
            Global defaults. Leave blank to use platform defaults. Per-project settings override these.
          </p>

          <Field
            label="Editor command"
            value={form.editor_command}
            onChange={(editor_command) => setForm({ ...form, editor_command })}
            placeholder="code"
            hint="Command to open your editor (e.g., cursor, code, codium)"
          />
          <Field
            label="Claude command"
            value={form.claude_command}
            onChange={(claude_command) => setForm({ ...form, claude_command })}
            placeholder="claude"
            hint="Default Claude Code command for all projects"
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
            hint="Font size in pixels"
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
            label="Window decorations"
            checked={form.window_decorations}
            onChange={(window_decorations) => setForm({ ...form, window_decorations })}
            hint="Show native title bar (disable on tiling window managers)"
          />
          <Toggle
            label="Notification sound"
            checked={form.notification_sound}
            onChange={(notification_sound) => setForm({ ...form, notification_sound })}
            hint="Play a chime when Claude finishes and is waiting for input"
          />
          <Toggle
            label="OS notifications"
            checked={form.notification_popup}
            onChange={(notification_popup) => setForm({ ...form, notification_popup })}
            hint="Show a system notification when Claude finishes (visible even when Coppice is minimized)"
          />

          {/* Claude mode selector */}
          <div className="pt-2 border-t border-border-primary">
            <label className="block text-xs text-text-secondary mb-1">Claude mode</label>
            <div className="flex gap-1">
              {(["terminal", "agent"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setForm({ ...form, default_claude_mode: mode })}
                  className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                    form.default_claude_mode === mode
                      ? "bg-accent text-white"
                      : "bg-bg-tertiary text-text-secondary hover:text-text-primary border border-border-primary"
                  }`}
                >
                  {mode === "terminal" ? "Terminal (CLI)" : "Agent (SDK)"}
                </button>
              ))}
            </div>
            <p className="mt-0.5 text-[10px] text-text-tertiary">
              {form.default_claude_mode === "terminal"
                ? "Runs Claude Code CLI in a PTY terminal (requires claude CLI installed)"
                : "Runs Claude via the Agent SDK with an interactive UI (requires API key)"}
            </p>
          </div>

          {/* Agent SDK settings — only shown when agent mode is selected */}
          {form.default_claude_mode === "agent" && (
            <div className="space-y-4 pl-2 border-l-2 border-accent/30">
              <Field
                label="Anthropic API key"
                value={form.agent_api_key}
                onChange={(agent_api_key) => setForm({ ...form, agent_api_key })}
                placeholder="sk-ant-..."
                hint="Your Anthropic API key for the Agent SDK"
              />
              <Field
                label="Default model"
                value={form.agent_default_model}
                onChange={(agent_default_model) => setForm({ ...form, agent_default_model })}
                placeholder="claude-sonnet-4-20250514"
                hint="Model to use for agent sessions (e.g., claude-sonnet-4-20250514, claude-opus-4-20250514)"
              />
              <div>
                <label className="block text-xs text-text-secondary mb-1">Default effort</label>
                <div className="flex gap-1">
                  {(["low", "medium", "high", "max"] as const).map((level) => (
                    <button
                      key={level}
                      type="button"
                      onClick={() => setForm({ ...form, agent_default_effort: level })}
                      className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors ${
                        form.agent_default_effort === level
                          ? "bg-accent text-white"
                          : "bg-bg-tertiary text-text-secondary hover:text-text-primary border border-border-primary"
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
                <p className="mt-0.5 text-[10px] text-text-tertiary">Controls how much effort the agent puts into responses</p>
              </div>
              <Field
                label="Node.js path"
                value={form.agent_node_path}
                onChange={(agent_node_path) => setForm({ ...form, agent_node_path })}
                placeholder="(auto-detect)"
                hint="Path to node binary — only needed if node isn't on your PATH"
              />
              <McpServersEditor
                servers={form.mcp_servers}
                onChange={(mcp_servers) => setForm({ ...form, mcp_servers })}
              />
            </div>
          )}

          {/* Claude Code hooks integration */}
          <div className="pt-2 border-t border-border-primary">
            <label className="block text-xs text-text-secondary mb-1">Claude Code integration</label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={hooksLoading || hooksInstalled === null}
                onClick={async () => {
                  setHooksLoading(true);
                  try {
                    if (hooksInstalled) {
                      await commands.uninstallClaudeHooks();
                      setHooksInstalled(false);
                    } else {
                      await commands.installClaudeHooks();
                      setHooksInstalled(true);
                    }
                  } catch {
                    // leave state unchanged
                  } finally {
                    setHooksLoading(false);
                  }
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  hooksInstalled
                    ? "bg-bg-tertiary text-text-secondary hover:text-text-primary border border-border-primary"
                    : "bg-accent hover:bg-accent-hover text-white"
                } disabled:opacity-40`}
              >
                {hooksLoading
                  ? "..."
                  : hooksInstalled
                    ? "Remove hooks"
                    : "Install hooks"}
              </button>
              <span className="text-[10px] text-text-tertiary">
                {hooksInstalled === null
                  ? "Checking..."
                  : hooksInstalled
                    ? "Hooks installed — Claude notifies Coppice instantly when it stops"
                    : "Not installed — using heuristic idle detection"}
              </span>
            </div>
            <p className="mt-1 text-[10px] text-text-tertiary">
              Adds Stop and Notification hooks to ~/.claude/settings.json for instant,
              deterministic idle detection. Safe to use alongside your own hooks.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-4 border-t border-border-primary gap-2">
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
      {hint && <p className="mt-0.5 text-[10px] text-text-tertiary">{hint}</p>}
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
      {hint && <p className="mt-0.5 ml-10 text-[10px] text-text-tertiary">{hint}</p>}
    </div>
  );
}

function McpServersEditor({
  servers,
  onChange,
}: {
  servers: Record<string, McpServerEntry>;
  onChange: (servers: Record<string, McpServerEntry>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState<"stdio" | "sse" | "http">("stdio");
  const [editCommand, setEditCommand] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editEnv, setEditEnv] = useState("");

  const entries = Object.entries(servers);

  const handleAdd = () => {
    const name = editName.trim();
    if (!name) return;
    const entry: McpServerEntry = { server_type: editType };
    if (editType === "stdio") {
      entry.command = editCommand.trim() || undefined;
      const args = editArgs.trim();
      if (args) entry.args = args.split(/\s+/);
      const envPairs = editEnv.trim();
      if (envPairs) {
        entry.env = {};
        for (const line of envPairs.split("\n")) {
          const eq = line.indexOf("=");
          if (eq > 0) {
            entry.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        }
      }
    } else {
      entry.url = editUrl.trim() || undefined;
    }
    onChange({ ...servers, [name]: entry });
    setAdding(false);
    setEditName("");
    setEditCommand("");
    setEditArgs("");
    setEditUrl("");
    setEditEnv("");
  };

  const handleRemove = (name: string) => {
    const next = { ...servers };
    delete next[name];
    onChange(next);
  };

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">MCP Servers</label>
      <p className="text-[10px] text-text-tertiary mb-2">
        Additional MCP servers available to agent sessions. These are merged with servers from Claude Code settings.
      </p>

      {entries.length > 0 && (
        <div className="space-y-1.5 mb-2">
          {entries.map(([name, entry]) => (
            <div
              key={name}
              className="flex items-center gap-2 px-2.5 py-1.5 bg-bg-tertiary border border-border-primary rounded text-xs"
            >
              <span className="font-mono font-medium text-text-primary">{name}</span>
              <span className="px-1.5 py-0.5 rounded bg-bg-secondary border border-border-primary text-[10px] text-text-tertiary">
                {entry.server_type}
              </span>
              <span className="text-text-tertiary truncate flex-1">
                {entry.server_type === "stdio"
                  ? [entry.command, ...(entry.args || [])].join(" ")
                  : entry.url || ""}
              </span>
              <button
                type="button"
                className="text-text-tertiary hover:text-error transition-colors shrink-0"
                onClick={() => handleRemove(name)}
                title="Remove"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
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
                  className={`px-2 py-1 text-[10px] transition-colors ${
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
                placeholder="Arguments (space-separated, e.g., -y @some/mcp-server)"
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
            <input
              type="text"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              placeholder="URL (e.g., http://localhost:3001/sse)"
              className="w-full px-2 py-1 text-xs bg-bg-primary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent font-mono"
            />
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleAdd}
              disabled={!editName.trim()}
              className="px-2.5 py-1 text-xs rounded bg-accent hover:bg-accent-hover disabled:opacity-40 text-white transition-colors"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="px-2.5 py-1 text-xs rounded text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-bg-tertiary border border-border-primary text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M5 1v8M1 5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          Add MCP Server
        </button>
      )}
    </div>
  );
}
