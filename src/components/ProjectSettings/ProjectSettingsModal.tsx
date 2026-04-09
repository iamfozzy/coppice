import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../stores/appStore";
import type { ProjectFormData } from "../../lib/types";

const emptyForm: ProjectFormData = {
  name: "",
  local_path: "",
  github_remote: "",
  base_branch: "main",
  setup_scripts: [],
  build_command: "",
  run_command: "",
  env_files: [],
  pr_create_skill: "",
};

export function ProjectSettingsModal() {
  const editingProject = useAppStore((s) => s.editingProject);
  const projects = useAppStore((s) => s.projects);
  const closeProjectSettings = useAppStore((s) => s.closeProjectSettings);
  const createProject = useAppStore((s) => s.createProject);
  const updateProject = useAppStore((s) => s.updateProject);
  const deleteProjectAction = useAppStore((s) => s.deleteProject);

  const isNew = editingProject === "new";
  const existingProject = !isNew
    ? projects.find((p) => p.id === editingProject)
    : null;

  const [form, setForm] = useState<ProjectFormData>(emptyForm);
  const [setupScriptsText, setSetupScriptsText] = useState("");
  const [envFilesText, setEnvFilesText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (existingProject) {
      setForm({
        name: existingProject.name,
        local_path: existingProject.local_path,
        github_remote: existingProject.github_remote,
        base_branch: existingProject.base_branch || "main",
        setup_scripts: existingProject.setup_scripts,
        build_command: existingProject.build_command,
        run_command: existingProject.run_command,
        env_files: existingProject.env_files,
        pr_create_skill: existingProject.pr_create_skill || "",
      });
      setSetupScriptsText(existingProject.setup_scripts.join("\n"));
      setEnvFilesText(existingProject.env_files.join("\n"));
    }
  }, [existingProject]);

  const handleSave = async () => {
    setSaving(true);
    const data: ProjectFormData = {
      ...form,
      setup_scripts: setupScriptsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
      env_files: envFilesText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      if (isNew) {
        await createProject(data);
      } else if (existingProject) {
        await updateProject(existingProject.id, data);
      }
      closeProjectSettings();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (existingProject) {
      await deleteProjectAction(existingProject.id);
      closeProjectSettings();
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeProjectSettings();
      }}
    >
      <div className="bg-bg-secondary border border-border-primary rounded-lg w-[520px] max-h-[85vh] overflow-y-auto shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-primary">
          <h2 className="text-sm font-semibold text-text-primary">
            {isNew ? "New Project" : "Project Settings"}
          </h2>
          <button
            onClick={closeProjectSettings}
            className="text-text-tertiary hover:text-text-primary transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {/* Form */}
        <div className="px-5 py-4 space-y-4">
          <Field
            label="Project name"
            value={form.name}
            onChange={(name) => setForm({ ...form, name })}
            placeholder="my-project"
          />
          <PathField
            label="Local path"
            value={form.local_path}
            onChange={(local_path) => {
              setForm({ ...form, local_path });
              // Auto-fill project name from folder name if empty
              if (!form.name && local_path) {
                const name = local_path.split("/").pop() || "";
                setForm((prev) => ({
                  ...prev,
                  local_path,
                  name: prev.name || name,
                }));
              }
            }}
            placeholder="/path/to/repo"
          />
          <Field
            label="GitHub remote"
            value={form.github_remote}
            onChange={(github_remote) => setForm({ ...form, github_remote })}
            placeholder="https://github.com/owner/repo or owner/repo"
          />
          <Field
            label="Base branch"
            value={form.base_branch}
            onChange={(base_branch) => setForm({ ...form, base_branch })}
            placeholder="main"
          />
          <Field
            label="Build command"
            value={form.build_command}
            onChange={(build_command) => setForm({ ...form, build_command })}
            placeholder="npm run build"
          />
          <Field
            label="Run command"
            value={form.run_command}
            onChange={(run_command) => setForm({ ...form, run_command })}
            placeholder="npm run dev"
          />
          <TextAreaField
            label="Setup scripts (one per line)"
            value={setupScriptsText}
            onChange={setSetupScriptsText}
            placeholder={"npm install\ncp ../.env .env"}
            rows={3}
          />
          <TextAreaField
            label="Env files to copy (one per line)"
            value={envFilesText}
            onChange={setEnvFilesText}
            placeholder={".env\n.env.local"}
            rows={2}
          />
          <TextAreaField
            label="PR create skill (custom Claude command for creating PRs)"
            value={form.pr_create_skill}
            onChange={(pr_create_skill) => setForm({ ...form, pr_create_skill })}
            placeholder={'claude "Review changes and create a PR with /commit"'}
            rows={2}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border-primary">
          <div>
            {!isNew && (
              <button
                onClick={handleDelete}
                className="text-xs text-error hover:text-error/80 transition-colors"
              >
                Delete project
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={closeProjectSettings}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving || !form.name || !form.local_path}
              className="px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover disabled:opacity-40 text-white rounded transition-colors"
            >
              {saving ? "Saving..." : isNew ? "Create" : "Save"}
            </button>
          </div>
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
      />
    </div>
  );
}

function PathField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const handleBrowse = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select project folder",
    });
    if (selected) {
      onChange(selected as string);
    }
  };

  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
        />
        <button
          type="button"
          onClick={handleBrowse}
          className="px-3 py-1.5 text-xs font-medium bg-bg-tertiary border border-border-primary rounded text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0"
        >
          Browse
        </button>
      </div>
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  rows,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-3 py-1.5 text-sm bg-bg-tertiary border border-border-primary rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors resize-none font-mono"
      />
    </div>
  );
}
