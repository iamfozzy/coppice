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
    allowed_tools: Option<Vec<String>>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    resume: Option<String>,
    api_key: Option<String>,
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

    // Pass API key from settings if not provided directly
    let resolved_api_key = api_key.or_else(|| {
        let s = settings.inner().get();
        let k = s.agent_api_key.clone();
        if k.is_empty() { None } else { Some(k) }
    });

    if let Some(ref key) = resolved_api_key {
        options.insert("apiKey".into(), serde_json::Value::String(key.clone()));
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
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "input",
        "text": text,
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
