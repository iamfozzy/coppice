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
            return Ok(bundled.to_string_lossy().to_string());
        }
    }

    // Fallback for dev mode — relative to the tauri source directory
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("agent-bridge")
        .join("bridge.mjs");
    if dev_path.exists() {
        return Ok(dev_path.to_string_lossy().to_string());
    }

    Err("Agent bridge script not found. Ensure agent-bridge is installed.".to_string())
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

    let start_msg = serde_json::json!({
        "type": "start",
        "sessionId": session_id,
        "cwd": cwd,
        "prompt": prompt,
        "options": options,
    });

    agent_manager.spawn(
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
    agent_manager: State<'_, AgentManager>,
) -> Result<(), String> {
    let msg = serde_json::json!({
        "type": "tool_response",
        "callId": call_id,
        "behavior": behavior,
        "message": message.unwrap_or_default(),
    });
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
    // Check node
    let node_ok = crate::services::shell_env::user_command("node")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);

    if !node_ok {
        return Ok(AgentAvailability {
            available: false,
            reason: Some("Node.js not found. Install Node.js 18+ to use the Agent SDK.".into()),
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
