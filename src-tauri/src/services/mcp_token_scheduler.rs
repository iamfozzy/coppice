//! Background scheduler that proactively refreshes MCP OAuth tokens before
//! they expire and pushes updated `Authorization` headers to all running
//! agent bridge processes.
//!
//! Without this, a long-running agent session that outlasts its MCP bearer
//! token would get 401s from the MCP server with no automatic recovery.
//!
//! The scheduler wakes every `CHECK_INTERVAL`, iterates MCP servers with
//! OAuth, and if a token is within `REFRESH_WINDOW` of expiry it refreshes
//! via the existing `mcp_oauth::access_token_for_session` codepath (which
//! handles locking, rotating refresh tokens, and persistence). On success
//! it broadcasts an `update_mcp_headers` message to every bridge process
//! so they can reconnect with the fresh bearer token.

use std::thread;
use std::time::Duration;
use tauri::Manager;

use crate::services::agent_manager::AgentManager;
use crate::settings::SettingsState;

/// How often the scheduler checks for approaching token expiry.
const CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// Refresh tokens that expire within this many seconds. This is wider than
/// the 60s threshold used by `access_token_for_session` so that running
/// bridges get the update *before* the on-demand path's threshold.
const REFRESH_WINDOW_SECS: u64 = 120;

/// Entry point — spawned as a background thread from `lib.rs`.
pub fn run(app_handle: tauri::AppHandle) {
    loop {
        thread::sleep(CHECK_INTERVAL);
        if let Err(e) = tick(&app_handle) {
            eprintln!("[mcp-token-scheduler] tick error: {}", e);
        }
    }
}

fn tick(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let settings_state = app_handle.state::<SettingsState>();
    let settings = settings_state.get();

    // Collect servers that need a token refresh
    let mut refreshed_servers: Vec<(String, String)> = Vec::new();

    for (name, entry) in &settings.mcp_servers {
        if entry.oauth.is_none() {
            continue;
        }

        // Check if this server's token is approaching expiry
        let tokens = match crate::services::mcp_oauth::load_tokens(name) {
            Ok(Some(t)) => t,
            _ => continue,
        };

        let now = crate::services::mcp_oauth::now_unix();
        if tokens.expires_at > now + REFRESH_WINDOW_SECS {
            continue; // Token is still fresh
        }

        // Token is approaching expiry — refresh it. `access_token_for_session`
        // handles the refresh lock, token persistence, and rotating refresh
        // token semantics (Atlassian).
        match crate::services::mcp_oauth::access_token_for_session(name, entry) {
            Ok(Some(new_token)) => {
                eprintln!(
                    "[mcp-token-scheduler] refreshed token for '{}' (was expiring in {}s)",
                    name,
                    tokens.expires_at.saturating_sub(now)
                );
                refreshed_servers.push((name.clone(), new_token));
            }
            Ok(None) => {
                // No token available — nothing to do
            }
            Err(e) => {
                eprintln!(
                    "[mcp-token-scheduler] failed to refresh '{}': {}",
                    name, e
                );
            }
        }
    }

    // Broadcast updated headers to all running bridges
    if !refreshed_servers.is_empty() {
        let agent_mgr = app_handle.state::<AgentManager>();

        let mut servers = serde_json::Map::new();
        for (name, token) in &refreshed_servers {
            let mut headers = serde_json::Map::new();
            headers.insert(
                "Authorization".into(),
                serde_json::Value::String(format!("Bearer {}", token)),
            );
            let mut entry = serde_json::Map::new();
            entry.insert("headers".into(), serde_json::Value::Object(headers));
            servers.insert(name.clone(), serde_json::Value::Object(entry));
        }

        let msg = serde_json::json!({
            "type": "update_mcp_headers",
            "servers": servers,
        });

        agent_mgr.broadcast(&msg.to_string());
    }

    Ok(())
}
