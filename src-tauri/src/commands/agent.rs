use crate::services::agent_manager::AgentManager;
use tauri::{AppHandle, Manager, State};

/// Resolve the path to the agent bridge script.
/// In production: <resource_dir>/agent-bridge/bridge.mjs
/// In dev: src-tauri/resources/agent-bridge/bridge.mjs
fn resolve_bridge_path(app: &AppHandle) -> Result<String, String> {
    // Try the bundled resource path first (production builds)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("agent-bridge").join("bridge.mjs");
        if bundled.exists() {
            return path_to_string(&bundled);
        }
    }

    // Fallback for dev mode — relative to the tauri source directory
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("agent-bridge")
        .join("bridge.mjs");
    if dev_path.exists() {
        return path_to_string(&dev_path);
    }

    Err("Agent bridge script not found. Ensure agent-bridge is installed.".to_string())
}

/// Convert a PathBuf to a String, using the \\?\ long-path prefix on Windows
/// to avoid MAX_PATH (260 char) issues with deeply nested node_modules, and
/// returning an error instead of silently replacing non-UTF-8 characters.
fn path_to_string(path: &std::path::Path) -> Result<String, String> {
    let s = path
        .to_str()
        .ok_or_else(|| format!("Path contains invalid UTF-8: {}", path.display()))?;

    #[cfg(target_os = "windows")]
    {
        // Already prefixed or a UNC path — return as-is
        if s.starts_with(r"\\?\") || s.starts_with(r"\\") {
            return Ok(s.to_string());
        }
        return Ok(format!(r"\\?\{}", s));
    }

    #[cfg(not(target_os = "windows"))]
    Ok(s.to_string())
}

/// Start a new agent session.
#[tauri::command]
pub fn agent_start(
    session_id: String,
    cwd: String,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
    concise_mode: Option<bool>,
    chat_mode: Option<bool>,
    extended_context: Option<bool>,
    allowed_tools: Option<Vec<String>>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    resume: Option<String>,
    api_key: Option<String>,
    prior_cost: Option<serde_json::Value>,
    images: Option<Vec<serde_json::Value>>,
    agent_manager: State<'_, AgentManager>,
    settings: State<'_, crate::settings::SettingsState>,
    app: AppHandle,
) -> Result<(), String> {
    let bridge_path = resolve_bridge_path(&app)?;

    // Build the start command JSON
    let mut options = serde_json::Map::new();
    if let Some(m) = &model {
        options.insert("model".into(), serde_json::Value::String(m.clone()));
    }
    if let Some(e) = &effort {
        options.insert("effort".into(), serde_json::Value::String(e.clone()));
    }
    if let Some(pm) = &permission_mode {
        options.insert(
            "permissionMode".into(),
            serde_json::Value::String(pm.clone()),
        );
    }
    if let Some(cm) = concise_mode {
        options.insert("conciseMode".into(), serde_json::Value::Bool(cm));
    }
    if let Some(chat) = chat_mode {
        options.insert("chatMode".into(), serde_json::Value::Bool(chat));
    }
    if let Some(ec) = extended_context {
        options.insert("extendedContext".into(), serde_json::Value::Bool(ec));
    }
    if let Some(tools) = &allowed_tools {
        let arr: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| serde_json::Value::String(t.clone()))
            .collect();
        options.insert("allowedTools".into(), serde_json::Value::Array(arr));
    }
    if let Some(mt) = max_turns {
        options.insert(
            "maxTurns".into(),
            serde_json::Value::Number(mt.into()),
        );
    }
    if let Some(mb) = max_budget_usd {
        if let Some(n) = serde_json::Number::from_f64(mb) {
            options.insert("maxBudgetUsd".into(), serde_json::Value::Number(n));
        }
    }
    if let Some(r) = &resume {
        options.insert("resume".into(), serde_json::Value::String(r.clone()));
    }
    if let Some(pc) = prior_cost {
        options.insert("priorCost".into(), pc);
    }

    // Pass API key from settings if not provided directly
    let resolved_api_key = api_key.or_else(|| {
        let s = settings.inner().get();
        let k = s.agent_api_key.clone();
        if k.is_empty() { None } else { Some(k) }
    });

    if let Some(ref key) = resolved_api_key {
        options.insert("apiKey".into(), serde_json::Value::String(key.clone()));
    }

    // Pass base URL for LiteLLM proxy support
    {
        let s = settings.inner().get();
        if !s.agent_base_url.is_empty() {
            options.insert(
                "baseUrl".into(),
                serde_json::Value::String(s.agent_base_url.clone()),
            );
        }
    }

    // Pass token-saving env overrides from settings
    {
        let s = settings.inner().get();
        if !s.agent_small_fast_model.is_empty() {
            options.insert(
                "smallFastModel".into(),
                serde_json::Value::String(s.agent_small_fast_model.clone()),
            );
        }
        if !s.agent_subagent_model.is_empty() {
            options.insert(
                "subagentModel".into(),
                serde_json::Value::String(s.agent_subagent_model.clone()),
            );
        }
        if s.agent_bash_max_output > 0 {
            options.insert(
                "bashMaxOutputLength".into(),
                serde_json::Value::Number(s.agent_bash_max_output.into()),
            );
        }
        if s.agent_task_max_output > 0 {
            options.insert(
                "taskMaxOutputLength".into(),
                serde_json::Value::Number(s.agent_task_max_output.into()),
            );
        }
    }

    // Pass MCP servers from settings
    {
        let s = settings.inner().get();
        if !s.mcp_servers.is_empty() {
            let mut servers = serde_json::Map::new();
            for (name, entry) in &s.mcp_servers {
                let mut obj = serde_json::Map::new();
                if entry.server_type == "stdio" {
                    if let Some(ref cmd) = entry.command {
                        obj.insert("command".into(), serde_json::Value::String(cmd.clone()));
                    }
                    if !entry.args.is_empty() {
                        let args: Vec<serde_json::Value> = entry
                            .args
                            .iter()
                            .map(|a| serde_json::Value::String(a.clone()))
                            .collect();
                        obj.insert("args".into(), serde_json::Value::Array(args));
                    }
                    if !entry.env.is_empty() {
                        let env_obj: serde_json::Map<String, serde_json::Value> = entry
                            .env
                            .iter()
                            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                            .collect();
                        obj.insert("env".into(), serde_json::Value::Object(env_obj));
                    }
                } else {
                    obj.insert(
                        "type".into(),
                        serde_json::Value::String(entry.server_type.clone()),
                    );
                    if let Some(ref url) = entry.url {
                        obj.insert("url".into(), serde_json::Value::String(url.clone()));
                    }
                }
                servers.insert(name.clone(), serde_json::Value::Object(obj));
            }
            options.insert("mcpServers".into(), serde_json::Value::Object(servers));
        }
    }

    let start_msg = serde_json::json!({
        "type": "start",
        "sessionId": session_id,
        "cwd": cwd,
        "prompt": prompt,
        "options": options,
        "images": images,
    });

    agent_manager.start(
        &session_id,
        &bridge_path,
        &start_msg.to_string(),
        resolved_api_key.as_deref(),
        &app,
    )
}

/// Send a follow-up message to an active agent session.
#[tauri::command]
pub fn agent_send_input(
    session_id: String,
    text: String,
    images: Option<Vec<serde_json::Value>>,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "input",
        "text": text,
        "images": images,
    });
    agent_manager.send(&session_id, &msg.to_string())
}

/// Interrupt an active agent session.
#[tauri::command]
pub fn agent_interrupt(
    session_id: String,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    agent_manager.send(&session_id, r#"{"type":"interrupt"}"#)
}

/// Respond to a tool permission request.
#[tauri::command]
pub fn agent_tool_response(
    session_id: String,
    call_id: String,
    behavior: String,
    message: Option<String>,
    updated_input: Option<serde_json::Value>,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let mut msg = serde_json::json!({
        "type": "tool_response",
        "callId": call_id,
        "behavior": behavior,
        "message": message.unwrap_or_default(),
    });
    if let Some(input) = updated_input {
        msg["updatedInput"] = input;
    }
    agent_manager.send(&session_id, &msg.to_string())
}

/// Respond to an AskUserQuestion request.
#[tauri::command]
pub fn agent_ask_response(
    session_id: String,
    call_id: String,
    answers: serde_json::Value,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "ask_response",
        "callId": call_id,
        "answers": answers,
    });
    agent_manager.send(&session_id, &msg.to_string())
}

/// Change the model for an active agent session.
#[tauri::command]
pub fn agent_set_model(
    session_id: String,
    model: String,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "set_model",
        "model": model,
    });
    agent_manager.send(&session_id, &msg.to_string())
}

/// Change the permission mode for an active agent session.
#[tauri::command]
pub fn agent_set_permission_mode(
    session_id: String,
    mode: String,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "set_permission_mode",
        "mode": mode,
    });
    agent_manager.send(&session_id, &msg.to_string())
}

/// Request the list of slash commands from an active agent session.
/// The bridge responds asynchronously via an `agent-event` with `type: "commands"`.
#[tauri::command]
pub fn agent_list_commands(
    session_id: String,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    agent_manager.send(&session_id, r#"{"type":"list_commands"}"#)
}

/// Close an agent session.
#[tauri::command]
pub fn agent_close(
    session_id: String,
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    agent_manager.close(&session_id)
}

/// Check if an agent session exists.
#[tauri::command]
pub fn agent_exists(
    session_id: String,
    agent_manager: State<'_, AgentManager>,
) -> bool {
    agent_manager.exists(&session_id)
}

/// Check if the agent infrastructure is available (node + bridge script).
#[tauri::command]
pub fn agent_check_available(app: AppHandle) -> Result<AgentAvailability, String> {
    // Resolve node to its real binary path. This sidesteps version-manager
    // shims (asdf/nvm/fnm/volta) that would otherwise fail inside a GUI-
    // launched .app bundle where cwd is `/` and no profile env is set.
    let node_path = match crate::services::shell_env::resolve_node_binary() {
        Some(p) => p,
        None => {
            return Ok(AgentAvailability {
                available: false,
                reason: Some(
                    "Node.js not found. Install Node.js 18+ and ensure it is \
                     available in your login shell.".into(),
                ),
            });
        }
    };

    let node_ok = crate::services::shell_env::user_command(node_path)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !node_ok {
        return Ok(AgentAvailability {
            available: false,
            reason: Some(format!(
                "Node.js binary at {} did not respond to --version.",
                node_path
            )),
        });
    }

    // Check bridge script
    match resolve_bridge_path(&app) {
        Ok(_) => Ok(AgentAvailability {
            available: true,
            reason: None,
        }),
        Err(e) => Ok(AgentAvailability {
            available: false,
            reason: Some(e),
        }),
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AgentAvailability {
    pub available: bool,
    pub reason: Option<String>,
}

/// Read an image file from disk and return it as a base64-encoded string with
/// its MIME type. Used by the frontend to convert native file drops into image
/// attachments for the agent SDK.
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<ImageFileData, String> {
    use std::path::Path;

    let file_path = Path::new(&path);
    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err(format!("Unsupported image format: .{ext}")),
    };

    let bytes = std::fs::read(file_path)
        .map_err(|e| format!("Failed to read image file: {e}"))?;

    // 20 MB limit
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("Image file exceeds 20 MB size limit".to_string());
    }

    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();

    Ok(ImageFileData {
        data,
        media_type: media_type.to_string(),
        file_name,
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ImageFileData {
    pub data: String,
    pub media_type: String,
    pub file_name: String,
}

/// A slash command discovered from `.claude/commands/*.md` directories.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSlashCommand {
    pub name: String,
    pub description: String,
    pub argument_hint: String,
}

/// Scan `~/.claude/commands/` and `<cwd>/.claude/commands/` for `.md` files and
/// return them as slash commands. This allows the frontend to show project
/// commands before the SDK bridge session has started.
#[tauri::command]
pub fn get_project_commands(cwd: String) -> Result<Vec<ProjectSlashCommand>, String> {
    use std::path::{Path, PathBuf};

    let mut commands = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let home = dirs::home_dir().unwrap_or_default();
    let project_claude = Path::new(&cwd).join(".claude");
    let user_claude = home.join(".claude");

    // Scan .claude/commands/ directories for flat *.md files (project-local first)
    let command_dirs: Vec<PathBuf> = vec![
        project_claude.join("commands"),
        user_claude.join("commands"),
    ];

    for dir in &command_dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let name = match path.file_stem().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !seen.insert(name.clone()) {
                continue;
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let first_line = content
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            commands.push(ProjectSlashCommand {
                name,
                description: first_line,
                argument_hint: "$ARGUMENTS".to_string(),
            });
        }
    }

    // Scan .claude/skills/ directories for <name>/SKILL.md (project-local first)
    let skill_dirs: Vec<PathBuf> = vec![
        project_claude.join("skills"),
        user_claude.join("skills"),
    ];

    for dir in &skill_dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !seen.insert(name.clone()) {
                continue;
            }
            let skill_file = path.join("SKILL.md");
            let content = match std::fs::read_to_string(&skill_file) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let first_line = content
                .lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            commands.push(ProjectSlashCommand {
                name,
                description: first_line,
                argument_hint: "$ARGUMENTS".to_string(),
            });
        }
    }

    Ok(commands)
}
