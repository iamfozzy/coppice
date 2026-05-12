use crate::services::agent_manager::AgentManager;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};

/// Resolve the path to an agent bridge script by filename.
/// In production: <resource_dir>/agent-bridge/<filename>
/// In dev: src-tauri/resources/agent-bridge/<filename>
fn resolve_bridge_path_for(app: &AppHandle, filename: &str) -> Result<String, String> {
    // Try the bundled resource path first (production builds)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("agent-bridge").join(filename);
        if bundled.exists() {
            return path_to_string(&bundled);
        }
    }

    // Fallback for dev mode — relative to the tauri source directory
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("agent-bridge")
        .join(filename);
    if dev_path.exists() {
        return path_to_string(&dev_path);
    }

    Err(format!(
        "Agent bridge script '{}' not found. Ensure agent-bridge is installed.",
        filename
    ))
}

/// Resolve the path to the agent bridge script (Claude or Pi based on settings).
fn resolve_bridge_path(app: &AppHandle) -> Result<String, String> {
    resolve_bridge_path_for(app, "bridge.mjs")
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
    backend: Option<String>,
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
    let settings_snapshot = settings.inner().get();
    let selected_backend = backend.unwrap_or_else(|| settings_snapshot.agent_backend.clone());

    // Select bridge script based on the session backend
    let bridge_path = match selected_backend.as_str() {
        "pi" => resolve_bridge_path_for(&app, "pi-bridge.mjs")?,
        _ => resolve_bridge_path_for(&app, "bridge.mjs")?,
    };

    // Build the start command JSON
    let mut options = serde_json::Map::new();
    if let Some(m) = &model {
        options.insert("model".into(), serde_json::Value::String(m.clone()));
    }
    if let Some(e) = &effort {
        options.insert("effort".into(), serde_json::Value::String(e.clone()));
        // Pi bridge also reads thinkingLevel directly for its native levels
        options.insert("thinkingLevel".into(), serde_json::Value::String(e.clone()));
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

    // Pass API key from settings if not provided directly.
    // When `agent_api_key_custom_only` is true, only use the configured key
    // for non-Claude models (custom models like openai/gpt-4o). Claude models
    // fall back to the default SDK key.
    let resolved_api_key = api_key.or_else(|| {
        let k = settings_snapshot.agent_api_key.clone();
        if k.is_empty() {
            return None;
        }
        if settings_snapshot.agent_api_key_custom_only {
            let is_claude = model
                .as_ref()
                .map_or(true, |m| m.starts_with("claude"));
            if is_claude {
                return None;
            }
        }
        Some(k)
    });

    if let Some(ref key) = resolved_api_key {
        options.insert("apiKey".into(), serde_json::Value::String(key.clone()));
    }

    // Pass base URL for LiteLLM proxy support.
    // When `agent_base_url_custom_only` is true, only route through the proxy
    // for non-Claude models (custom models like openai/gpt-4o). Claude models
    // go direct to the Anthropic API.
    {
        if !settings_snapshot.agent_base_url.is_empty() {
            let is_claude = model
                .as_ref()
                .map_or(true, |m| m.starts_with("claude"));
            let use_base_url = if settings_snapshot.agent_base_url_custom_only {
                !is_claude
            } else {
                true
            };
            if use_base_url {
                options.insert(
                    "baseUrl".into(),
                    serde_json::Value::String(settings_snapshot.agent_base_url.clone()),
                );
            }
        }
    }

    // Pass token-saving env overrides from settings
    {
        if !settings_snapshot.agent_small_fast_model.is_empty() {
            options.insert(
                "smallFastModel".into(),
                serde_json::Value::String(settings_snapshot.agent_small_fast_model.clone()),
            );
        }
        if !settings_snapshot.agent_subagent_model.is_empty() {
            options.insert(
                "subagentModel".into(),
                serde_json::Value::String(settings_snapshot.agent_subagent_model.clone()),
            );
        }
        if settings_snapshot.agent_bash_max_output > 0 {
            options.insert(
                "bashMaxOutputLength".into(),
                serde_json::Value::Number(settings_snapshot.agent_bash_max_output.into()),
            );
        }
        if settings_snapshot.agent_task_max_output > 0 {
            options.insert(
                "taskMaxOutputLength".into(),
                serde_json::Value::Number(settings_snapshot.agent_task_max_output.into()),
            );
        }
    }

    // Pass MCP servers from settings.
    //
    // For http/sse servers we merge: user-supplied static headers + a Bearer
    // token loaded from Coppice's encrypted local secret store when the server
    // has completed an OAuth flow. The lookup also refreshes the token if it's
    // about to expire — this is the single point where MCP auth is materialized.
    {
        if !settings_snapshot.mcp_servers.is_empty() {
            let mut servers = serde_json::Map::new();
            for (name, entry) in &settings_snapshot.mcp_servers {
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

                    // Build headers: start with user-supplied static headers,
                    // then overlay the OAuth Bearer token (secret-store backed,
                    // auto-refreshed) if the server has completed OAuth.
                    let mut headers_map: serde_json::Map<String, serde_json::Value> = entry
                        .headers
                        .iter()
                        .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                        .collect();
                    if entry.oauth.is_some() {
                        match crate::services::mcp_oauth::access_token_for_session(name, entry) {
                            Ok(Some(token)) => {
                                headers_map.insert(
                                    "Authorization".into(),
                                    serde_json::Value::String(format!("Bearer {}", token)),
                                );
                            }
                            Ok(None) => {
                                eprintln!(
                                    "[mcp] {}: no OAuth token available — server will start unauthenticated",
                                    name
                                );
                            }
                            Err(e) => {
                                eprintln!("[mcp] {}: failed to load OAuth token: {}", name, e);
                            }
                        }
                    }
                    if !headers_map.is_empty() {
                        obj.insert("headers".into(), serde_json::Value::Object(headers_map));
                    }
                }
                servers.insert(name.clone(), serde_json::Value::Object(obj));
            }
            options.insert("mcpServers".into(), serde_json::Value::Object(servers));
        }
    }

    // Pass Pi-specific options when using the Pi backend
    if selected_backend == "pi" {
        // Prefer the session model when present so restored tabs keep using
        // the backend/model they were created with.
        let (pi_provider, pi_model_id) = if let Some(ref m) = model {
            if m.contains('/') {
                let parts: Vec<&str> = m.splitn(2, '/').collect();
                (parts[0].to_string(), parts[1].to_string())
            } else {
                (settings_snapshot.pi_default_provider.clone(), m.clone())
            }
        } else if settings_snapshot.pi_default_model.contains('/') {
            let parts: Vec<&str> = settings_snapshot.pi_default_model.splitn(2, '/').collect();
            (parts[0].to_string(), parts[1].to_string())
        } else {
            (
                settings_snapshot.pi_default_provider.clone(),
                settings_snapshot.pi_default_model.clone(),
            )
        };
        options.insert(
            "piProvider".into(),
            serde_json::Value::String(pi_provider.clone()),
        );
        options.insert(
            "piModelId".into(),
            serde_json::Value::String(pi_model_id),
        );
        options.insert(
            "enableWebAccess".into(),
            serde_json::Value::Bool(settings_snapshot.pi_enable_web_access),
        );
        options.insert(
            "enableSubagent".into(),
            serde_json::Value::Bool(settings_snapshot.pi_enable_subagent),
        );
        // Pass per-provider API keys so the bridge can set env vars
        if !settings_snapshot.pi_api_keys.is_empty() {
            let keys_obj: serde_json::Map<String, serde_json::Value> = settings_snapshot
                .pi_api_keys
                .iter()
                .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
                .collect();
            options.insert(
                "piApiKeys".into(),
                serde_json::Value::Object(keys_obj),
            );
        }
        // For Pi mode, if no apiKey was resolved above (e.g. agent_api_key
        // is empty), fall back to the Pi provider-specific key for the
        // selected provider so the bridge always has credentials.
        if resolved_api_key.is_none() {
            let provider = pi_provider.as_str();
            if let Some(k) = settings_snapshot.pi_api_keys.get(provider) {
                if !k.is_empty() {
                    options.insert(
                        "apiKey".into(),
                        serde_json::Value::String(k.clone()),
                    );
                }
            }
            // Also fall back to the main agent_api_key for Anthropic
            if !settings_snapshot.agent_api_key.is_empty()
                && (provider == "anthropic" || provider.is_empty())
            {
                options.insert(
                    "apiKey".into(),
                    serde_json::Value::String(settings_snapshot.agent_api_key.clone()),
                );
            }
        }
    }

    // Save images to temp files so the agent can reference them by path.
    // This happens on the Rust side (synchronous) to avoid blocking the
    // bridge's async query start. Each image object gets a `tempPath` field.
    let images = {
        let mut imgs = images.unwrap_or_default();
        if !imgs.is_empty() {
            save_images_to_temp_files(&mut imgs);
        }
        if imgs.is_empty() { None } else { Some(imgs) }
    };

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
    let images = {
        let mut imgs = images.unwrap_or_default();
        if !imgs.is_empty() {
            save_images_to_temp_files(&mut imgs);
        }
        if imgs.is_empty() { None } else { Some(imgs) }
    };
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

/// Track the active OAuth process so we can kill it before starting a new one.
/// Prevents EADDRINUSE when the OAuth callback server port (53692) is still
/// held by a previous attempt that didn't complete or clean up.
static OAUTH_CHILD_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

/// Start a Pi OAuth login flow for a provider. Spawns a Node process that
/// runs the OAuth flow, streaming events via `pi-oauth-event` Tauri events.
/// Opens the browser automatically and saves credentials to ~/.pi/agent/auth.json.
#[tauri::command]
pub fn pi_oauth_login(
    provider: String,
    app: AppHandle,
) -> Result<(), String> {
    eprintln!("[pi-oauth] starting login for: {}", provider);

    // Kill any previous OAuth process that might still be holding the callback
    // port (e.g. 53692 for Anthropic). Without this, a second login attempt
    // fails with EADDRINUSE.
    if let Ok(mut pid_guard) = OAUTH_CHILD_PID.lock() {
        if let Some(old_pid) = pid_guard.take() {
            eprintln!("[pi-oauth] killing previous OAuth process (pid={})", old_pid);
            #[cfg(unix)]
            {
                // SIGTERM first (pi-oauth.mjs handles it), then SIGKILL as fallback
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &old_pid.to_string()])
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(200));
                let _ = std::process::Command::new("kill")
                    .args(["-9", &old_pid.to_string()])
                    .output();
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/PID", &old_pid.to_string()])
                    .output();
            }
        }
    }

    let node_path = crate::services::shell_env::resolve_node_binary()
        .ok_or_else(|| "Node.js not found".to_string())?;

    // Use the same path resolution as the bridge scripts — dev mode falls
    // back to the source tree because resource_dir points at target/debug/.
    let oauth_path = resolve_bridge_path_for(&app, "pi-oauth.mjs")?;
    let bridge_dir = std::path::Path::new(&oauth_path)
        .parent()
        .unwrap()
        .to_path_buf();
    eprintln!("[pi-oauth] script: {}", oauth_path);

    let mut cmd = crate::services::shell_env::user_command(node_path);
    cmd.arg(&oauth_path);
    cmd.arg(&provider);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.current_dir(&bridge_dir);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start Pi OAuth: {}", e))?;

    let child_pid = child.id();
    eprintln!("[pi-oauth] process spawned (pid={})", child_pid);

    // Store PID so the next call can kill us if needed
    if let Ok(mut pid_guard) = OAUTH_CHILD_PID.lock() {
        *pid_guard = Some(child_pid);
    }

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    // Thread: forward stderr to eprintln (visible in tauri dev console)
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[pi-oauth] {}", line);
        }
    });

    // Thread: read stdout events, open browser, emit to frontend
    let app_clone = app.clone();
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() { continue; }
            eprintln!("[pi-oauth] stdout: {}", line);

            // Open browser for auth URLs
            if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                if msg.get("type").and_then(|t| t.as_str()) == Some("auth") {
                    if let Some(url) = msg.get("url").and_then(|u| u.as_str()) {
                        if !url.is_empty() {
                            eprintln!("[pi-oauth] opening browser: {}", url);
                            let _ = crate::services::coppice_tools::open_url_in_browser(url);
                        }
                    }
                }
            }

            // Emit to frontend
            if let Err(e) = app_clone.emit("pi-oauth-event", &line) {
                eprintln!("[pi-oauth] emit error: {}", e);
            }
        }
        eprintln!("[pi-oauth] stdout closed, waiting for exit...");
        let _ = child.wait();
        // Clear PID on exit
        if let Ok(mut pid_guard) = OAUTH_CHILD_PID.lock() {
            if *pid_guard == Some(child_pid) {
                *pid_guard = None;
            }
        }
        eprintln!("[pi-oauth] process exited");
    });

    Ok(())
}

/// Check which providers have OAuth credentials in ~/.pi/agent/auth.json.
/// Returns a JSON object mapping provider names to true, e.g. { "anthropic": true }.
#[tauri::command]
pub fn pi_oauth_check() -> Result<serde_json::Value, String> {
    let auth_path = dirs::home_dir()
        .ok_or_else(|| "Cannot determine home directory".to_string())?
        .join(".pi")
        .join("agent")
        .join("auth.json");

    if !auth_path.exists() {
        return Ok(serde_json::json!({}));
    }

    let contents = std::fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read auth.json: {}", e))?;

    let data: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse auth.json: {}", e))?;

    let mut result = serde_json::Map::new();
    if let Some(obj) = data.as_object() {
        for key in obj.keys() {
            result.insert(key.clone(), serde_json::Value::Bool(true));
        }
    }

    Ok(serde_json::Value::Object(result))
}

/// Query the Pi SDK's built-in model registry. Spawns a short-lived Node
/// process that imports @earendil-works/pi-ai and dumps providers + models
/// as JSON. No running session required.
#[tauri::command]
pub fn pi_get_models(app: AppHandle) -> Result<serde_json::Value, String> {
    let node_path = crate::services::shell_env::resolve_node_binary()
        .ok_or_else(|| "Node.js not found".to_string())?;

    // Resolve bridge dir using the same path logic as bridge scripts
    let bridge_path = resolve_bridge_path_for(&app, "pi-bridge.mjs")?;
    let bridge_dir = std::path::Path::new(&bridge_path)
        .parent()
        .unwrap()
        .to_path_buf();

    let script = r#"
        import { getProviders, getModels } from "@earendil-works/pi-ai";
        const result = [];
        for (const p of getProviders()) {
            try {
                for (const m of getModels(p)) {
                    result.push({
                        value: m.id,
                        label: m.name,
                        provider: p,
                        contextWindow: m.contextWindow,
                        reasoning: m.reasoning,
                    });
                }
            } catch {}
        }
        process.stdout.write(JSON.stringify(result));
    "#;

    let mut cmd = crate::services::shell_env::user_command(node_path);
    cmd.args(["--input-type=module", "-e", script]);
    cmd.current_dir(&bridge_dir);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to query Pi models: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Pi model query failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse Pi model list: {}", e))
}

/// Save attached images to temp files so the agent can reference them by path.
/// Mutates each image JSON object in-place, adding a `tempPath` field.
/// Returns the list of temp paths created (for logging).
fn save_images_to_temp_files(images: &mut Vec<serde_json::Value>) {
    use base64::Engine;
    use std::collections::HashMap;

    let media_type_to_ext: HashMap<&str, &str> = [
        ("image/jpeg", ".jpg"),
        ("image/png", ".png"),
        ("image/gif", ".gif"),
        ("image/webp", ".webp"),
    ]
    .into_iter()
    .collect();

    let temp_dir = std::env::temp_dir().join(format!(
        "coppice-agent-images-{}",
        uuid::Uuid::new_v4()
    ));
    if std::fs::create_dir_all(&temp_dir).is_err() {
        return;
    }

    for img in images.iter_mut() {
        let obj = match img.as_object_mut() {
            Some(o) => o,
            None => continue,
        };
        let data_str = match obj.get("data").and_then(|v| v.as_str()) {
            Some(d) => d,
            None => continue,
        };
        let media_type = match obj.get("mediaType").and_then(|v| v.as_str()) {
            Some(m) => m,
            None => continue,
        };
        let ext = media_type_to_ext.get(media_type).copied().unwrap_or(".png");

        // Sanitize the original filename: only keep alphanumeric, hyphens, underscores
        let raw_name = obj
            .get("fileName")
            .and_then(|v| v.as_str())
            .unwrap_or("image");
        // Strip extension from the raw name, sanitize, then re-add canonical ext
        let stem = raw_name.rsplit_once('.').map_or(raw_name, |(s, _)| s);
        let safe_stem: String = stem
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let safe_stem = safe_stem.trim_matches('_');
        let safe_stem = if safe_stem.is_empty() { "image" } else { safe_stem };

        let file_name = format!(
            "{}-{}{}",
            &uuid::Uuid::new_v4().to_string()[..8],
            safe_stem,
            ext
        );
        let file_path = temp_dir.join(&file_name);

        // Decode base64 and write to disk
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data_str) {
            if std::fs::write(&file_path, &bytes).is_ok() {
                obj.insert(
                    "tempPath".into(),
                    serde_json::Value::String(file_path.to_string_lossy().into_owned()),
                );
            }
        }
    }
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
    let project_pi = Path::new(&cwd).join(".pi");
    let user_pi = home.join(".pi").join("agent");

    // Scan commands/prompts directories for flat *.md files (project-local first).
    // Covers both Claude (.claude/commands/) and Pi (.pi/prompts/) conventions.
    let command_dirs: Vec<PathBuf> = vec![
        project_claude.join("commands"),
        project_pi.join("prompts"),
        user_claude.join("commands"),
        user_pi.join("prompts"),
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

    // Scan skills directories for <name>/SKILL.md (project-local first).
    // Covers both Claude (.claude/skills/) and Pi (.pi/skills/) conventions.
    let skill_dirs: Vec<PathBuf> = vec![
        project_claude.join("skills"),
        project_pi.join("skills"),
        user_claude.join("skills"),
        user_pi.join("skills"),
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

/// Track the active Claude auth process so we can kill it before starting a new one.
static CLAUDE_AUTH_CHILD_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

/// Start the Claude Code OAuth login flow. Spawns `claude auth login` as a
/// subprocess, streaming progress via `claude-auth-event` Tauri events.
/// The `claude` CLI opens a browser for the user to authenticate, then
/// stores tokens in `~/.claude/`.
#[tauri::command]
pub fn claude_auth_login(app: AppHandle) -> Result<(), String> {
    eprintln!("[claude-auth] starting login");

    // Kill any previous auth process
    if let Ok(mut pid_guard) = CLAUDE_AUTH_CHILD_PID.lock() {
        if let Some(old_pid) = pid_guard.take() {
            eprintln!(
                "[claude-auth] killing previous auth process (pid={})",
                old_pid
            );
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("kill")
                    .args(["-TERM", &old_pid.to_string()])
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(200));
                let _ = std::process::Command::new("kill")
                    .args(["-9", &old_pid.to_string()])
                    .output();
            }
            #[cfg(windows)]
            {
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/PID", &old_pid.to_string()])
                    .output();
            }
        }
    }

    // Resolve the `claude` binary. Prefer PATH lookup via login shell so we
    // pick up the user's installed version (e.g. ~/.local/bin/claude).
    let claude_bin = crate::services::shell_env::bin("claude");

    let mut cmd = crate::services::shell_env::user_command(&claude_bin);
    cmd.args(["auth", "login", "--claudeai"]);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start `claude auth login`: {}", e))?;

    let child_pid = child.id();
    eprintln!("[claude-auth] process spawned (pid={})", child_pid);

    if let Ok(mut pid_guard) = CLAUDE_AUTH_CHILD_PID.lock() {
        *pid_guard = Some(child_pid);
    }

    // Emit initial status to frontend
    let _ = app.emit(
        "claude-auth-event",
        serde_json::json!({ "type": "progress", "message": "Opening browser for authentication..." }).to_string(),
    );

    let stdout = child.stdout.take().ok_or("No stdout")?;
    let stderr = child.stderr.take().ok_or("No stderr")?;

    // Thread: forward stderr lines to log + frontend
    let app_stderr = app.clone();
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            eprintln!("[claude-auth] {}", line);
            // Surface stderr as progress (claude CLI prints status there)
            let _ = app_stderr.emit(
                "claude-auth-event",
                serde_json::json!({ "type": "progress", "message": line }).to_string(),
            );
        }
    });

    // Thread: read stdout + wait for exit
    let app_clone = app.clone();
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            eprintln!("[claude-auth] stdout: {}", line);
            let _ = app_clone.emit(
                "claude-auth-event",
                serde_json::json!({ "type": "progress", "message": line }).to_string(),
            );
        }

        // Wait for the process to exit
        let status = child.wait();
        if let Ok(mut pid_guard) = CLAUDE_AUTH_CHILD_PID.lock() {
            if *pid_guard == Some(child_pid) {
                *pid_guard = None;
            }
        }

        match status {
            Ok(s) if s.success() => {
                eprintln!("[claude-auth] login succeeded");
                let _ = app_clone.emit(
                    "claude-auth-event",
                    serde_json::json!({ "type": "success" }).to_string(),
                );
            }
            Ok(s) => {
                let msg = format!("Login failed (exit code {})", s.code().unwrap_or(-1));
                eprintln!("[claude-auth] {}", msg);
                let _ = app_clone.emit(
                    "claude-auth-event",
                    serde_json::json!({ "type": "error", "message": msg }).to_string(),
                );
            }
            Err(e) => {
                let msg = format!("Login process error: {}", e);
                eprintln!("[claude-auth] {}", msg);
                let _ = app_clone.emit(
                    "claude-auth-event",
                    serde_json::json!({ "type": "error", "message": msg }).to_string(),
                );
            }
        }
    });

    Ok(())
}

/// Check the Claude Code CLI authentication status.
/// Returns the JSON output of `claude auth status`.
#[tauri::command]
pub fn claude_auth_status() -> Result<serde_json::Value, String> {
    let claude_bin = crate::services::shell_env::bin("claude");
    let mut cmd = crate::services::shell_env::user_command(&claude_bin);
    cmd.args(["auth", "status"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to check Claude auth status: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Try to parse as JSON (claude auth status outputs JSON)
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        return Ok(parsed);
    }

    // Fallback: not logged in or claude not installed
    if !output.status.success() {
        return Ok(serde_json::json!({ "loggedIn": false }));
    }

    Ok(serde_json::json!({ "loggedIn": false, "raw": stdout.trim() }))
}
