//! Tauri commands that wrap the MCP OAuth service and expose a curated
//! catalog of well-known servers (Atlassian Rovo, GitHub).
//!
//! Frontend flow for adding a catalog server:
//!
//!   1. `mcp_get_catalog()` populates the picker.
//!   2. User chooses an entry → frontend calls `mcp_install_catalog_entry(id)`,
//!      which writes the server config (without tokens) to settings and
//!      returns the inserted entry.
//!   3. Frontend calls `mcp_oauth_start(name)` — Coppice does discovery +
//!      dynamic registration, opens the browser, and emits `mcp-oauth-event`
//!      events as the flow progresses.
//!   4. On success, settings.toml has `oauth.connected = true` and the
//!      encrypted local secret store holds the token set. Subsequent
//!      `agent_start` calls inject `Authorization: Bearer …` into the MCP
//!      server's headers.

use std::collections::HashMap;
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::services::mcp_oauth;
use crate::settings::{save_settings, McpOAuthState, McpServerEntry, SettingsState};

// ─── Catalog ───────────────────────────────────────────────────────────────

/// A catalog entry is a Coppice-curated preset that fills in the URL,
/// transport, and any non-secret OAuth scopes for a popular MCP server.
///
/// `auth` is one of:
///   - `"oauth"`        — Coppice runs the full discovery + DCR + PKCE
///                        flow on Connect.
///   - `"static-bearer"` — Server requires a user-supplied token in
///                        `Authorization: Bearer …`. The catalog row
///                        prompts for the token inline and (optionally)
///                        opens `token_url` to generate one.
///   - `"none"`         — No auth handled by Coppice (rare; user must
///                        configure headers themselves).
#[derive(Debug, Clone, Serialize)]
pub struct McpCatalogEntry {
    pub id: &'static str,
    pub display_name: &'static str,
    pub description: &'static str,
    pub server_type: &'static str,
    pub url: &'static str,
    pub default_name: &'static str,
    pub auth: &'static str,
    pub scopes: &'static [&'static str],
    pub homepage: &'static str,
    /// For `auth = "static-bearer"`: a deep-link URL where the user can
    /// generate the required token (e.g. github.com/settings/tokens/new
    /// with scopes pre-selected).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_url: Option<&'static str>,
    /// For `auth = "static-bearer"`: short hint shown next to the input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_help: Option<&'static str>,
}

// Curated catalog. URLs reflect each provider's current Streamable HTTP
// endpoint (the SSE endpoints are deprecated or unsupported as of mid-2026):
//   - Atlassian Rovo: SSE at /v1/sse is sunset 2026-06-30; clients must use
//     /v1/mcp (Streamable HTTP).
//   - GitHub: official remote MCP at api.githubcopilot.com (Streamable HTTP).
const CATALOG: &[McpCatalogEntry] = &[
    McpCatalogEntry {
        id: "atlassian-rovo",
        display_name: "Atlassian Rovo",
        description: "Search Jira issues, read & edit Confluence pages, transition tickets. Uses Streamable HTTP at /v1/mcp (the legacy /v1/sse endpoint is being retired by Atlassian on 2026-06-30).",
        server_type: "http",
        url: "https://mcp.atlassian.com/v1/mcp",
        default_name: "atlassian",
        auth: "oauth",
        scopes: &[
            "read:jira-work",
            "write:jira-work",
            "read:jira-user",
            "read:confluence-content.all",
            "write:confluence-content",
            "offline_access",
        ],
        homepage: "https://www.atlassian.com/platform/remote-mcp-server",
        token_url: None,
        token_help: None,
    },
    McpCatalogEntry {
        // GitHub doesn't support dynamic client registration
        // (github/github-mcp-server#1404), so the automated OAuth flow can't
        // complete. Instead, we treat it as a "static-bearer" entry: the
        // catalog UI prompts the user for a Personal Access Token and writes
        // it directly into the server's headers. `token_url` deep-links to
        // GitHub's PAT generation page with scopes pre-selected.
        id: "github",
        display_name: "GitHub",
        description: "Issues, PRs, code search, repo metadata via the official GitHub MCP server.",
        server_type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        default_name: "github",
        auth: "static-bearer",
        scopes: &[],
        homepage: "https://github.com/github/github-mcp-server",
        token_url: Some(
            "https://github.com/settings/tokens/new?scopes=repo,read:org,read:user&description=Coppice%20MCP",
        ),
        token_help: Some("Personal Access Token — scopes: repo, read:org, read:user"),
    },
];

#[tauri::command]
pub fn mcp_get_catalog() -> Vec<McpCatalogEntry> {
    CATALOG.to_vec()
}

fn catalog_lookup(id: &str) -> Option<&'static McpCatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

#[derive(Debug, Clone, Serialize)]
pub struct InstalledMcpServer {
    pub name: String,
    pub entry: McpServerEntry,
}

/// Insert a catalog entry into settings. Behaviour by `auth` type:
///
///   - `oauth`         — entry is created with empty OAuth state; the
///                       frontend then calls `mcp_oauth_start` to run the
///                       full discovery + DCR + PKCE flow.
///   - `static-bearer` — `token` is required; written verbatim into
///                       `headers["Authorization"] = "Bearer <token>"`.
///                       The server is immediately usable.
///   - `none`          — entry is created with no auth; user supplies
///                       headers manually if needed.
///
/// If the chosen name is already taken we suffix `-2`, `-3`, … so users
/// can install the same catalog twice (e.g. two Atlassian sites).
#[tauri::command]
pub fn mcp_install_catalog_entry(
    catalog_id: String,
    token: Option<String>,
    settings: State<'_, SettingsState>,
) -> Result<InstalledMcpServer, String> {
    let entry =
        catalog_lookup(&catalog_id).ok_or_else(|| format!("Unknown catalog id: {}", catalog_id))?;

    if entry.auth == "static-bearer" {
        let t = token.as_deref().unwrap_or("").trim();
        if t.is_empty() {
            return Err(format!(
                "{} requires a token. Generate one and paste it before adding.",
                entry.display_name
            ));
        }
    }

    let mut guard = settings.0.lock().map_err(|e| e.to_string())?;
    let mut name = entry.default_name.to_string();
    let mut n = 2;
    while guard.mcp_servers.contains_key(&name) {
        name = format!("{}-{}", entry.default_name, n);
        n += 1;
    }

    let mut server = McpServerEntry {
        server_type: entry.server_type.to_string(),
        command: None,
        args: Vec::new(),
        url: Some(entry.url.to_string()),
        env: HashMap::new(),
        headers: HashMap::new(),
        oauth: None,
        catalog_id: Some(entry.id.to_string()),
    };
    match entry.auth {
        "oauth" => {
            server.oauth = Some(McpOAuthState {
                scopes: entry.scopes.iter().map(|s| s.to_string()).collect(),
                ..Default::default()
            });
        }
        "static-bearer" => {
            // Trimmed-and-validated above; `token` is guaranteed Some+non-empty.
            let t = token.unwrap_or_default().trim().to_string();
            server
                .headers
                .insert("Authorization".to_string(), format!("Bearer {}", t));
        }
        _ => {}
    }
    guard.mcp_servers.insert(name.clone(), server.clone());
    save_settings(&guard)?;
    Ok(InstalledMcpServer {
        name,
        entry: server,
    })
}

// ─── OAuth flow ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct McpOAuthEvent<'a> {
    name: &'a str,
    /// One of: "auth", "progress", "success", "error".
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn emit(app: &AppHandle, event: McpOAuthEvent<'_>) {
    if let Err(e) = app.emit("mcp-oauth-event", &event) {
        eprintln!("[mcp-oauth] emit error: {}", e);
    }
}

/// Start the OAuth flow for a configured server. Spawns a worker thread and
/// returns immediately; progress and completion are reported via
/// `mcp-oauth-event` Tauri events.
#[tauri::command]
pub fn mcp_oauth_start(
    name: String,
    settings: State<'_, SettingsState>,
    app: AppHandle,
) -> Result<(), String> {
    let snapshot = settings.inner().get();
    let entry = snapshot
        .mcp_servers
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("Unknown MCP server: {}", name))?;
    let server_url = entry
        .url
        .clone()
        .ok_or_else(|| "OAuth requires an http/sse server URL".to_string())?;

    let existing_oauth = entry.oauth.clone();
    let scopes: Vec<String> = existing_oauth
        .as_ref()
        .map(|o| o.scopes.clone())
        .unwrap_or_default();
    let client_name = format!(
        "Coppice ({})",
        entry.catalog_id.clone().unwrap_or_else(|| name.clone())
    );

    let app_clone = app.clone();
    let name_clone = name.clone();
    thread::spawn(move || {
        emit(
            &app_clone,
            McpOAuthEvent {
                name: &name_clone,
                kind: "progress",
                url: None,
                message: Some("Discovering authorization server…".into()),
            },
        );

        let started = match mcp_oauth::start_authorization(
            &name_clone,
            &server_url,
            &scopes,
            &client_name,
            existing_oauth.as_ref(),
        ) {
            Ok(x) => x,
            Err(e) => {
                emit(
                    &app_clone,
                    McpOAuthEvent {
                        name: &name_clone,
                        kind: "error",
                        url: None,
                        message: Some(e),
                    },
                );
                return;
            }
        };
        let (flow, oauth_state) = started;

        // Persist the discovered endpoints & client_id immediately so that if
        // the user kills Coppice mid-flow, we can reconnect without re-doing
        // discovery from scratch.
        let settings_state = app_clone.state::<SettingsState>();
        if let Err(e) = persist_oauth_state(&settings_state, &name_clone, &oauth_state, false) {
            eprintln!("[mcp-oauth] persist (pre-callback) failed: {}", e);
        }

        // Open the browser.
        emit(
            &app_clone,
            McpOAuthEvent {
                name: &name_clone,
                kind: "auth",
                url: Some(flow.auth_url.clone()),
                message: Some("Opening browser…".into()),
            },
        );
        if let Err(e) = crate::services::coppice_tools::open_url_in_browser(&flow.auth_url) {
            eprintln!("[mcp-oauth] open_url_in_browser: {}", e);
        }

        // Wait for the listener thread to capture the code and exchange it.
        match flow.completion_rx.recv_timeout(Duration::from_secs(360)) {
            Ok(Ok(_tokens)) => {
                // Mark connected in settings.
                if let Err(e) =
                    persist_oauth_state(&settings_state, &name_clone, &oauth_state, true)
                {
                    eprintln!("[mcp-oauth] persist (post-callback) failed: {}", e);
                }
                emit(
                    &app_clone,
                    McpOAuthEvent {
                        name: &name_clone,
                        kind: "success",
                        url: None,
                        message: Some("Connected.".into()),
                    },
                );
            }
            Ok(Err(e)) => {
                if e == mcp_oauth::FLOW_SUPERSEDED {
                    return;
                }
                emit(
                    &app_clone,
                    McpOAuthEvent {
                        name: &name_clone,
                        kind: "error",
                        url: None,
                        message: Some(e),
                    },
                );
            }
            Err(_) => {
                emit(
                    &app_clone,
                    McpOAuthEvent {
                        name: &name_clone,
                        kind: "error",
                        url: None,
                        message: Some("OAuth flow timed out".into()),
                    },
                );
            }
        }
    });

    Ok(())
}

/// Update the persisted OAuth state for a server. We hold the settings lock
/// only briefly, mutate, and write to disk.
fn persist_oauth_state(
    settings: &SettingsState,
    name: &str,
    oauth_state: &McpOAuthState,
    connected: bool,
) -> Result<(), String> {
    // Keep the in-memory SettingsState and settings.toml in sync. Refresh uses
    // token_endpoint/client_id/resource from SettingsState during agent_start;
    // if we only wrote the TOML, the first post-login refresh would still use
    // the empty placeholder OAuth state until Coppice restarted.
    let mut guard = settings.0.lock().map_err(|e| e.to_string())?;
    let entry = guard
        .mcp_servers
        .get_mut(name)
        .ok_or_else(|| format!("Server '{}' was removed during OAuth", name))?;
    let mut new_state = oauth_state.clone();
    new_state.connected = connected;
    if connected {
        new_state.last_auth_at = Some(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        );
    }
    entry.oauth = Some(new_state);
    save_settings(&guard)
}

/// List the live status of every configured OAuth-enabled server.
#[tauri::command]
pub fn mcp_get_auth_status(
    settings: State<'_, SettingsState>,
) -> Result<Vec<mcp_oauth::McpAuthStatus>, String> {
    let snap = settings.inner().get();
    Ok(snap
        .mcp_servers
        .iter()
        .map(|(name, entry)| mcp_oauth::status_for(name, entry))
        .collect())
}

/// Drop tokens + cached client secret for a server (keeps the server config).
#[tauri::command]
pub fn mcp_oauth_revoke(name: String, settings: State<'_, SettingsState>) -> Result<(), String> {
    mcp_oauth::revoke(&name)?;
    // Mark not-connected in settings.
    let mut guard = settings.0.lock().map_err(|e| e.to_string())?;
    if let Some(entry) = guard.mcp_servers.get_mut(&name) {
        if let Some(o) = entry.oauth.as_mut() {
            o.connected = false;
            o.last_auth_at = None;
        }
    }
    save_settings(&guard)?;
    Ok(())
}

// ─── Test connection ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct McpTestResult {
    pub ok: bool,
    pub message: String,
    /// HTTP status code returned by the server, when applicable.
    pub status_code: Option<u16>,
    /// True when the failure was an authentication challenge that an OAuth
    /// flow could fix. The frontend uses this to surface a "Connect" CTA.
    pub needs_oauth: bool,
}

/// Probe an MCP server. For http/sse: do an HTTP request with the same
/// headers we'd send during a session and report the result. For stdio:
/// just validate the command resolves on PATH (we don't actually spawn it).
#[tauri::command]
pub fn mcp_test_connection(
    name: String,
    settings: State<'_, SettingsState>,
) -> Result<McpTestResult, String> {
    let snap = settings.inner().get();
    let entry = snap
        .mcp_servers
        .get(&name)
        .cloned()
        .ok_or_else(|| format!("Unknown MCP server: {}", name))?;

    if entry.server_type == "stdio" {
        let command = entry.command.clone().unwrap_or_default();
        if command.is_empty() {
            return Ok(McpTestResult {
                ok: false,
                message: "Server has no command".into(),
                status_code: None,
                needs_oauth: false,
            });
        }
        // We deliberately don't spawn the subprocess from the test button —
        // many MCP servers print to stderr and exit cleanly only when given
        // a real handshake. Instead, just confirm the command resolves.
        let resolved = which_command(&command);
        return Ok(McpTestResult {
            ok: resolved.is_some(),
            message: match resolved {
                Some(p) => format!("Command resolves at: {}", p),
                None => format!("Command not found on PATH: {}", command),
            },
            status_code: None,
            needs_oauth: false,
        });
    }

    let url = match entry.url.clone() {
        Some(u) => u,
        None => {
            return Ok(McpTestResult {
                ok: false,
                message: "Server has no URL".into(),
                status_code: None,
                needs_oauth: false,
            })
        }
    };

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .build();
    let mut req = agent.get(&url);
    for (k, v) in entry.headers.iter() {
        req = req.set(k, v);
    }
    if entry.oauth.is_some() {
        match mcp_oauth::access_token_for_session(&name, &entry) {
            Ok(Some(token)) => {
                req = req.set("Authorization", &format!("Bearer {}", token));
            }
            Ok(None) => {}
            Err(e) => {
                return Ok(McpTestResult {
                    ok: false,
                    message: format!("Could not load OAuth token: {}", e),
                    status_code: None,
                    needs_oauth: true,
                });
            }
        }
    }

    match req.call() {
        Ok(resp) => {
            let code = resp.status();
            // SSE/HTTP MCP servers return 200 (with a streaming body) when
            // they're happy. 405 is also common — they only accept POST.
            let ok = matches!(code, 200..=299 | 405);
            Ok(McpTestResult {
                ok,
                message: if ok {
                    format!("Reachable (HTTP {})", code)
                } else {
                    format!("Unexpected response: HTTP {}", code)
                },
                status_code: Some(code),
                needs_oauth: false,
            })
        }
        Err(ureq::Error::Status(code, _)) => Ok(McpTestResult {
            ok: false,
            message: format!("Server returned HTTP {}", code),
            status_code: Some(code),
            needs_oauth: code == 401 || code == 403,
        }),
        Err(e) => Ok(McpTestResult {
            ok: false,
            message: format!("Connection failed: {}", e),
            status_code: None,
            needs_oauth: false,
        }),
    }
}

fn which_command(command: &str) -> Option<String> {
    if std::path::Path::new(command).is_absolute() {
        return std::path::Path::new(command)
            .exists()
            .then(|| command.to_string());
    }
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(command);
        if candidate.exists() {
            return candidate.to_str().map(String::from);
        }
        #[cfg(target_os = "windows")]
        {
            for ext in [".exe", ".cmd", ".bat", ".ps1"] {
                let mut c = candidate.clone();
                c.set_extension(ext.trim_start_matches('.'));
                if c.exists() {
                    return c.to_str().map(String::from);
                }
            }
        }
    }
    None
}
