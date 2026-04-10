import { useState, useEffect } from "react";
import { useAppStore } from "../../stores/appStore";
import type { AppSettings } from "../../lib/types";

const defaultSettings: AppSettings = {
  editor_command: "",
  claude_command: "",
  terminal_font_family: "",
  terminal_font_size: 0,
  terminal_emulator: "",
  shell: "",
  window_decorations: true,
};

export function AppSettingsModal() {
  const appSettings = useAppStore((s) => s.appSettings);
  const closeAppSettings = useAppStore((s) => s.closeAppSettings);
  const saveSettings = useAppStore((s) => s.saveSettings);

  const [form, setForm] = useState<AppSettings>(defaultSettings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (appSettings) {
      setForm({ ...appSettings });
    }
  }, [appSettings]);

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
