use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use crate::services::pty_manager::PtyManager;
use crate::services::{mcp_oauth, shell_env};
use crate::settings::McpServerEntry;
use crate::settings::{AppSettings, SettingsState};

#[tauri::command]
pub fn terminal_spawn(
    pty: State<'_, PtyManager>,
    settings: State<'_, SettingsState>,
    app: AppHandle,
    session_id: String,
    cwd: String,
    command: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<(), String> {
    let shell_override = {
        let s = settings.0.lock().unwrap();
        if s.shell.is_empty() { None } else { Some(s.shell.clone()) }
    };
    pty.spawn(
        &session_id,
        &cwd,
        command.as_deref(),
        rows.unwrap_or(24),
        cols.unwrap_or(80),
        &app,
        shell_override.as_deref(),
    )
}

#[tauri::command]
pub fn terminal_spawn_claude(
    pty: State<'_, PtyManager>,
    settings: State<'_, SettingsState>,
    app: AppHandle,
    session_id: String,
    cwd: String,
    command: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
    resume_session_id: Option<String>,
    resume_latest: Option<bool>,
) -> Result<(), String> {
    let app_settings = {
        let s = settings.0.lock().unwrap();
        s.clone()
    };
    let shell_override = if app_settings.shell.is_empty() {
        None
    } else {
        Some(app_settings.shell.clone())
    };

    let session_files = write_claude_cli_session_files(&app, &session_id, &cwd, &app_settings)?;
    let base_command = command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("claude");
    let command_with_resume = inject_claude_resume_arg(
        base_command,
        resume_session_id.as_deref(),
        resume_latest.unwrap_or(false),
    );
    let command_with_settings = inject_claude_cli_args(
        &command_with_resume,
        &session_files.settings_path,
        session_files.mcp_config_path.as_deref(),
    );

    pty.spawn(
        &session_id,
        &cwd,
        Some(&command_with_settings),
        rows.unwrap_or(24),
        cols.unwrap_or(80),
        &app,
        shell_override.as_deref(),
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCliNotificationPayload {
    /// Coppice tab/session id (not Claude Code's conversation id).
    session_id: String,
    notification_type: String,
    /// Claude Code's conversation session id, when present in hook payloads.
    claude_session_id: Option<String>,
    /// False for bookkeeping-only hooks used to capture session ids when
    /// the user disabled Claude CLI notifications.
    notify_user: bool,
}

struct ClaudeCliSessionFiles {
    settings_path: PathBuf,
    mcp_config_path: Option<PathBuf>,
}

fn write_claude_cli_session_files(app: &AppHandle, session_id: &str, cwd: &str, settings: &AppSettings) -> Result<ClaudeCliSessionFiles, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("coppice"))
        .join("claude-cli-sessions");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create Claude CLI cache dir: {e}"))?;

    let statusline_path = dir.join("coppice-claude-statusline.mjs");
    // Always rewrite this tiny helper so app updates can improve the default
    // statusline without requiring users to clear the cache directory.
    let statusline_script = COPPICE_STATUSLINE_SCRIPT
        .replace("__COPPICE_STATUSLINE_GIT__", if settings.claude_cli_statusline_git { "true" } else { "false" })
        .replace("__COPPICE_STATUSLINE_COLORS__", if settings.claude_cli_statusline_colors { "true" } else { "false" });
    fs::write(&statusline_path, statusline_script)
        .map_err(|e| format!("Failed to write Claude statusline script: {e}"))?;

    let node = shell_env::resolve_node_binary().unwrap_or("node");
    let statusline_command = format!(
        "{} {}",
        shell_quote_arg(node),
        shell_quote_arg(&path_to_string(&statusline_path)?),
    );
    let mut session_settings = json!({
        "preferredNotifChannel": if settings.claude_cli_notifications { "terminal_bell" } else { "notifications_disabled" },
        "terminalProgressBarEnabled": settings.claude_cli_terminal_progress,
    });

    let mut mcp_config_path: Option<PathBuf> = None;
    if let Some((port, token)) = start_claude_cli_hook_server(app) {
        let mcp_url = format!("http://127.0.0.1:{port}/coppice-mcp-tool");
        if let Ok(mcp_script) = resolve_agent_bridge_resource(app, "coppice-cli-mcp.mjs") {
            let mut mcp_servers = build_claude_cli_mcp_servers(settings);
            mcp_servers.insert(
                "coppice".to_string(),
                json!({
                    "type": "stdio",
                    "command": node,
                    "args": [mcp_script],
                    "alwaysLoad": true,
                    "env": {
                        "COPPICE_MCP_URL": mcp_url,
                        "COPPICE_MCP_TOKEN": token,
                        "COPPICE_MCP_CWD": cwd,
                    }
                }),
            );

            // Claude Code reads MCP servers from an MCP config file passed via
            // --mcp-config (not from the --settings file on current releases).
            // Keep the generated file per-session so the local auth token never
            // touches a project .mcp.json or the user's global config.
            let path = dir.join(format!("{session_id}.mcp.json"));
            let mcp_json = serde_json::to_string_pretty(&json!({ "mcpServers": mcp_servers }))
                .map_err(|e| format!("Failed to encode Claude CLI MCP config: {e}"))?;
            fs::write(&path, mcp_json)
                .map_err(|e| format!("Failed to write Claude CLI MCP config: {e}"))?;
            restrict_file_permissions(&path);
            mcp_config_path = Some(path);
        }
    }

    if settings.claude_cli_fullscreen {
        session_settings["tui"] = json!("fullscreen");
    }

    if settings.claude_cli_statusline_enabled {
        session_settings["statusLine"] = json!({
            "type": "command",
            "command": statusline_command,
            "padding": 0,
            "refreshInterval": 10,
        });
    }

    if let Some((port, token)) = start_claude_cli_hook_server(app) {
        let notify = if settings.claude_cli_notifications { "1" } else { "0" };
        let hook_url = format!("http://127.0.0.1:{port}/claude-cli-notify/{session_id}?token={token}&notify={notify}");
        let mut hooks = json!({
            // More reliable "turn finished" signal: this fires whenever a
            // response stops. We always install it so Coppice can capture the
            // Claude Code session id for future app-restart resume; the
            // notify query param controls whether it also lights up UI alerts.
            "Stop": [{
                "hooks": [{ "type": "http", "url": hook_url }]
            }],
            "StopFailure": [{
                "matcher": "",
                "hooks": [{ "type": "http", "url": hook_url }]
            }]
        });
        if settings.claude_cli_notifications {
            hooks["Notification"] = json!([{
                "matcher": "",
                "hooks": [{ "type": "http", "url": hook_url }]
            }]);
        }
        session_settings["hooks"] = hooks;
    }

    let settings_path = dir.join(format!("{session_id}.settings.json"));
    let json = serde_json::to_string_pretty(&session_settings)
        .map_err(|e| format!("Failed to encode Claude CLI session settings: {e}"))?;
    fs::write(&settings_path, json)
        .map_err(|e| format!("Failed to write Claude CLI session settings: {e}"))?;
    restrict_file_permissions(&settings_path);
    Ok(ClaudeCliSessionFiles { settings_path, mcp_config_path })
}

static CLAUDE_CLI_HOOK_SERVER: OnceLock<Option<(u16, String)>> = OnceLock::new();

fn start_claude_cli_hook_server(app: &AppHandle) -> Option<(u16, String)> {
    CLAUDE_CLI_HOOK_SERVER
        .get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
            let port = listener.local_addr().ok()?.port();
            let token = uuid::Uuid::new_v4().to_string();
            let server_token = token.clone();
            let app = app.clone();

            thread::spawn(move || {
                for incoming in listener.incoming() {
                    let Ok(mut stream) = incoming else { continue };
                    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
                    let req = read_http_request(&mut stream).unwrap_or_default();
                    let (status, content_type, body) = handle_claude_cli_hook_request(&req, &server_token, &app);
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                }
            });

            Some((port, token))
        })
        .clone()
}

fn handle_claude_cli_hook_request(req: &str, token: &str, app: &AppHandle) -> (&'static str, &'static str, String) {
    let Some(first_line) = req.lines().next() else { return ("400 Bad Request", "text/plain", "bad request".to_string()) };
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("");
    if method != "POST" {
        return ("405 Method Not Allowed", "text/plain", "method not allowed".to_string());
    }

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let body = req.split("\r\n\r\n").nth(1).unwrap_or("");

    if path == "/coppice-mcp-tool" {
        let token_ok = bearer_token_ok(req, token)
            || query
                .split('&')
                .filter_map(|part| part.split_once('='))
                .any(|(k, v)| k == "token" && v == token);
        if !token_ok {
            return json_http("403 Forbidden", serde_json::json!({ "ok": false, "error": "forbidden" }));
        }
        return handle_coppice_mcp_http(body, app);
    }

    let Some(session_id) = path.strip_prefix("/claude-cli-notify/") else {
        return ("404 Not Found", "text/plain", "not found".to_string());
    };
    let mut token_ok = false;
    let mut notify_user = false;
    for (k, v) in query.split('&').filter_map(|part| part.split_once('=')) {
        if k == "token" && v == token {
            token_ok = true;
        } else if k == "notify" && v == "1" {
            notify_user = true;
        }
    }
    if !token_ok || session_id.is_empty() {
        return ("403 Forbidden", "text/plain", "forbidden".to_string());
    }

    let hook_payload = serde_json::from_str::<serde_json::Value>(body).ok();
    let notification_type = hook_payload
        .as_ref()
        .and_then(|v| {
            v.get("notification_type")
                .or_else(|| v.get("notificationType"))
                .or_else(|| v.get("hook_event_name"))
                .or_else(|| v.get("type"))
                .and_then(|value| value.as_str().map(str::to_string))
        })
        .unwrap_or_else(|| "notification".to_string());
    let claude_session_id = hook_payload.as_ref().and_then(extract_claude_session_id);

    let _ = app.emit(
        "claude-cli-notification",
        ClaudeCliNotificationPayload {
            session_id: session_id.to_string(),
            notification_type,
            claude_session_id,
            notify_user,
        },
    );
    ("204 No Content", "text/plain", String::new())
}

fn extract_claude_session_id(payload: &serde_json::Value) -> Option<String> {
    for key in ["session_id", "sessionId", "conversation_id", "conversationId"] {
        if let Some(id) = payload.get(key).and_then(|v| v.as_str()) {
            if looks_like_session_id(id) {
                return Some(id.to_string());
            }
        }
    }

    // Claude Code hook payloads commonly include transcript_path; the file
    // stem is the same session UUID used by `claude --resume <id>`.
    payload
        .get("transcript_path")
        .or_else(|| payload.get("transcriptPath"))
        .and_then(|v| v.as_str())
        .and_then(|p| Path::new(p).file_stem().and_then(|s| s.to_str()))
        .filter(|id| looks_like_session_id(id))
        .map(str::to_string)
}

fn looks_like_session_id(id: &str) -> bool {
    let len = id.len();
    len >= 8
        && len <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn restrict_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn read_http_request(stream: &mut TcpStream) -> std::io::Result<String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let n = stream.read(&mut tmp)?;
        if n == 0 { break; }
        buf.extend_from_slice(&tmp[..n]);
        if header_end.is_none() {
            if let Some(pos) = find_header_end(&buf) {
                header_end = Some(pos);
                let headers = String::from_utf8_lossy(&buf[..pos]);
                content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
            }
        }
        if let Some(pos) = header_end {
            if buf.len() >= pos + 4 + content_length { break; }
        }
        if buf.len() > 1024 * 1024 { break; }
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn bearer_token_ok(req: &str, token: &str) -> bool {
    req.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else { return false };
        name.eq_ignore_ascii_case("authorization") && value.trim() == format!("Bearer {token}")
    })
}

fn json_http(status: &'static str, value: serde_json::Value) -> (&'static str, &'static str, String) {
    (status, "application/json", value.to_string())
}

fn handle_coppice_mcp_http(body: &str, app: &AppHandle) -> (&'static str, &'static str, String) {
    let parsed = match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => v,
        Err(e) => return json_http("400 Bad Request", serde_json::json!({ "ok": false, "error": format!("invalid JSON: {e}") })),
    };
    let tool_name = parsed.get("toolName").and_then(|v| v.as_str()).unwrap_or("");
    let args = parsed
        .get("args")
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Object(Default::default()));
    let cwd = parsed.get("cwd").and_then(|v| v.as_str()).unwrap_or("");
    if tool_name.is_empty() {
        return json_http("400 Bad Request", serde_json::json!({ "ok": false, "error": "toolName is required" }));
    }

    match crate::services::coppice_tools::handle_coppice_tool(tool_name, &args, app, cwd) {
        Ok(result) => json_http("200 OK", serde_json::json!({ "ok": true, "result": result })),
        Err(error) => json_http("200 OK", serde_json::json!({ "ok": false, "error": error })),
    }
}

fn build_claude_cli_mcp_servers(settings: &AppSettings) -> serde_json::Map<String, serde_json::Value> {
    let mut servers = serde_json::Map::new();
    for (name, entry) in &settings.mcp_servers {
        if name == "coppice" { continue; }
        if let Some(config) = mcp_entry_to_claude_cli_config(name, entry) {
            servers.insert(name.clone(), config);
        }
    }
    servers
}

fn mcp_entry_to_claude_cli_config(name: &str, entry: &McpServerEntry) -> Option<serde_json::Value> {
    let server_type = entry.server_type.as_str();
    match server_type {
        "stdio" => {
            let command = entry.command.as_ref()?.clone();
            let mut obj = serde_json::Map::new();
            obj.insert("type".to_string(), json!("stdio"));
            obj.insert("command".to_string(), json!(command));
            if !entry.args.is_empty() { obj.insert("args".to_string(), json!(entry.args)); }
            if !entry.env.is_empty() { obj.insert("env".to_string(), json!(entry.env)); }
            Some(serde_json::Value::Object(obj))
        }
        "http" | "sse" => {
            let url = entry.url.as_ref()?.clone();
            let mut headers = entry.headers.clone();
            if let Ok(Some(token)) = mcp_oauth::access_token_for_session(name, entry) {
                headers.insert("Authorization".to_string(), format!("Bearer {token}"));
            }
            let mut obj = serde_json::Map::new();
            obj.insert("type".to_string(), json!(server_type));
            obj.insert("url".to_string(), json!(url));
            if !headers.is_empty() { obj.insert("headers".to_string(), json!(headers)); }
            Some(serde_json::Value::Object(obj))
        }
        _ => None,
    }
}

fn resolve_agent_bridge_resource(app: &AppHandle, filename: &str) -> Result<String, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("agent-bridge").join(filename);
        if bundled.exists() { return path_to_string(&bundled); }
    }
    let dev_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("agent-bridge")
        .join(filename);
    if dev_path.exists() { return path_to_string(&dev_path); }
    Err(format!("Agent bridge resource '{filename}' not found"))
}

fn inject_claude_resume_arg(command: &str, resume_session_id: Option<&str>, resume_latest: bool) -> String {
    if !resume_latest && resume_session_id.is_none() {
        return command.to_string();
    }
    if command_has_claude_resume_arg(command) {
        return command.to_string();
    }

    let resume_arg = if let Some(id) = resume_session_id.filter(|id| looks_like_session_id(id)) {
        format!(" --resume {}", shell_quote_arg(id))
    } else if resume_latest {
        " --continue".to_string()
    } else {
        return command.to_string();
    };

    inject_after_claude_token(command, &resume_arg)
}

fn command_has_claude_resume_arg(command: &str) -> bool {
    shell_token_ranges(command).iter().any(|(start, end)| {
        matches!(
            unquote_shell_token(&command[*start..*end]).as_str(),
            "--resume" | "--continue" | "-r" | "-c"
        )
    })
}

fn inject_after_claude_token(command: &str, arg: &str) -> String {
    let tokens = shell_token_ranges(command);
    let insert_at = tokens.iter().find_map(|(start, end)| {
        let token = unquote_shell_token(&command[*start..*end]);
        let name = Path::new(&token)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(token.as_str())
            .to_ascii_lowercase();
        if name == "claude" || name == "claude.cmd" || name == "claude.exe" {
            Some(*end)
        } else {
            None
        }
    });

    if let Some(idx) = insert_at {
        format!("{}{}{}", &command[..idx], arg, &command[idx..])
    } else {
        format!("{}{}", command, arg)
    }
}

fn inject_claude_cli_args(command: &str, settings_path: &Path, mcp_config_path: Option<&Path>) -> String {
    let mut extra_args = format!(" --settings {}", shell_quote_arg(&path_to_string_lossy(settings_path)));
    if let Some(path) = mcp_config_path {
        extra_args.push_str(" --mcp-config ");
        extra_args.push_str(&shell_quote_arg(&path_to_string_lossy(path)));
    }
    let tokens = shell_token_ranges(command);
    let insert_at = tokens
        .iter()
        .find_map(|(start, end)| {
            let token = unquote_shell_token(&command[*start..*end]);
            let name = Path::new(&token)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(token.as_str())
                .to_ascii_lowercase();
            if name == "claude" || name == "claude.cmd" || name == "claude.exe" {
                Some(*end)
            } else {
                None
            }
        });

    if let Some(idx) = insert_at {
        format!("{}{}{}", &command[..idx], extra_args, &command[idx..])
    } else {
        format!("{}{}", command, extra_args)
    }
}

fn shell_token_ranges(command: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    let mut start: Option<usize> = None;

    for (idx, ch) in command.char_indices() {
        if start.is_none() {
            if ch.is_whitespace() {
                continue;
            }
            start = Some(idx);
        }

        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' && !in_single {
            escaped = true;
            continue;
        }
        if ch == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if ch == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if ch.is_whitespace() && !in_single && !in_double {
            if let Some(s) = start.take() {
                ranges.push((s, idx));
            }
        }
    }
    if let Some(s) = start {
        ranges.push((s, command.len()));
    }
    ranges
}

fn unquote_shell_token(token: &str) -> String {
    let trimmed = token.trim();
    if trimmed.len() >= 2 {
        let bytes = trimmed.as_bytes();
        if (bytes[0] == b'\'' && bytes[trimmed.len() - 1] == b'\'')
            || (bytes[0] == b'"' && bytes[trimmed.len() - 1] == b'"')
        {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn shell_quote_arg(arg: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn path_to_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|s| s.to_string())
        .ok_or_else(|| format!("Path is not valid UTF-8: {}", path.display()))
}

fn path_to_string_lossy(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

const COPPICE_STATUSLINE_SCRIPT: &str = r###"#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const SHOW_GIT = __COPPICE_STATUSLINE_GIT__;
const USE_COLORS = __COPPICE_STATUSLINE_COLORS__;

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  coppice: "\x1b[38;5;141m",
  model: "\x1b[38;5;81m",
  green: "\x1b[38;5;114m",
  yellow: "\x1b[38;5;222m",
  red: "\x1b[38;5;203m",
  git: "\x1b[38;5;178m",
};

function color(s, c) {
  return USE_COLORS ? `${c}${s}${ansi.reset}` : s;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function gitInfo(cwd) {
  if (!cwd) return null;
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], cwd) !== "true") return null;
    let branch = git(["branch", "--show-current"], cwd);
    if (!branch) branch = git(["rev-parse", "--short", "HEAD"], cwd);
    const lines = git(["status", "--porcelain=v1", "--branch"], cwd)
      .split(/\r?\n/)
      .filter(Boolean);
    let ahead = "";
    let staged = 0;
    let changed = 0;
    let untracked = 0;
    let conflicts = 0;
    for (const line of lines) {
      if (line.startsWith("##")) {
        const m = line.match(/\[([^\]]+)\]/);
        ahead = m ? m[1].replace(/ahead /g, "↑").replace(/behind /g, "↓") : "";
        continue;
      }
      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") untracked++;
      else {
        if (x !== " " && x !== "?") staged++;
        if (y !== " " && y !== "?") changed++;
      }
      if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) conflicts++;
    }
    return { branch, ahead, staged, changed, untracked, conflicts, dirty: staged + changed + untracked + conflicts };
  } catch {
    return null;
  }
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");
    const model = data.model?.display_name || data.model?.id || "Claude";
    const ctx = data.context_window?.used_percentage;
    const rate = data.rate_limits?.five_hour?.used_percentage;
    const cwd = data.workspace?.current_dir || data.cwd || "";
    const repo = SHOW_GIT ? gitInfo(cwd) : null;
    const bits = [color("Coppice", ansi.coppice), color(model, ansi.model)];

    if (typeof ctx === "number") {
      const c = ctx >= 85 ? ansi.red : ctx >= 65 ? ansi.yellow : ansi.green;
      bits.push(color(`${Math.round(ctx)}% ctx`, c));
    }
    if (typeof rate === "number") {
      const c = rate >= 85 ? ansi.red : rate >= 65 ? ansi.yellow : ansi.green;
      bits.push(color(`${Math.round(rate)}% limit`, c));
    }
    if (repo?.branch) {
      const gitBits = [` ${repo.branch}`];
      if (repo.ahead) gitBits.push(repo.ahead);
      if (repo.staged) gitBits.push(`+${repo.staged}`);
      if (repo.changed) gitBits.push(`~${repo.changed}`);
      if (repo.untracked) gitBits.push(`?${repo.untracked}`);
      if (repo.conflicts) gitBits.push(`!${repo.conflicts}`);
      const c = repo.conflicts ? ansi.red : repo.dirty ? ansi.yellow : ansi.git;
      bits.push(color(gitBits.join(" "), c));
    }

    // Intentionally do not show username, home path, account email, or cost.
    process.stdout.write(bits.join(color(" · ", ansi.dim)));
  } catch {
    process.stdout.write(`${color("Coppice", ansi.coppice)}${color(" · ", ansi.dim)}Claude`);
  }
});
"###;

#[tauri::command]
pub fn terminal_write(
    pty: State<'_, PtyManager>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    pty.write(&session_id, data.as_bytes())
}

#[tauri::command]
pub fn terminal_resize(
    pty: State<'_, PtyManager>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    pty.resize(&session_id, rows, cols)
}

#[tauri::command]
pub fn terminal_exists(
    pty: State<'_, PtyManager>,
    session_id: String,
) -> bool {
    pty.exists(&session_id)
}

#[tauri::command]
pub fn terminal_kill(
    pty: State<'_, PtyManager>,
    session_id: String,
) -> Result<(), String> {
    pty.kill(&session_id)
}
