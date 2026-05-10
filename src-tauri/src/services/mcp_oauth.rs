//! MCP OAuth 2.1 client.
//!
//! Implements the MCP authorization spec (model-context-protocol/2025-06-18):
//!
//! 1. **Discovery (RFC 9728)** — probe the server, follow `WWW-Authenticate`
//!    `resource_metadata` to find the protected-resource document, then fetch
//!    the auth server's `/.well-known/oauth-authorization-server`.
//! 2. **Dynamic client registration (RFC 7591)** — POST a `client_name` +
//!    loopback `redirect_uris` to the registration endpoint, store the
//!    returned `client_id` in settings (and `client_secret`, if any, in the
//!    encrypted local secret store).
//! 3. **PKCE authorization code flow (OAuth 2.1)** — generate a verifier +
//!    S256 challenge, bind a one-shot loopback listener on a fixed port, open
//!    the auth URL in the user's browser, capture `code` from the callback,
//!    exchange it at the token endpoint.
//! 4. **Token storage** — access + refresh tokens are persisted in Coppice's
//!    encrypted local secret store. Settings.toml holds only non-secret state.
//! 5. **Refresh on demand** — `access_token_for_session` is called from
//!    `agent_start`; if the token expires within 60s we refresh transparently
//!    before injecting the `Authorization: Bearer …` header.

use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;

use crate::services::secret_store;
use crate::settings::{McpOAuthState, McpServerEntry};

/// Loopback redirect port. Registered with each OAuth provider as
/// `http://127.0.0.1:{LOOPBACK_PORT}/callback` so that the redirect URI is
/// fixed across re-runs. If the port is busy at flow time we surface a clean
/// error rather than guess at alternates (which would invalidate the
/// registered redirect URI).
const LOOPBACK_PORT: u16 = 33418;

const HTTP_TIMEOUT: Duration = Duration::from_secs(20);
const FLOW_TIMEOUT: Duration = Duration::from_secs(300);
pub const FLOW_SUPERSEDED: &str = "__coppice_mcp_oauth_flow_superseded__";

// ─── Public types ──────────────────────────────────────────────────────────

/// Auth-server metadata (subset of RFC 8414).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AuthServerMetadata {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    #[serde(default)]
    pub registration_endpoint: Option<String>,
    #[serde(default)]
    pub scopes_supported: Option<Vec<String>>,
}

/// Token set persisted in the encrypted local secret store.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub access_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix seconds when `access_token` becomes invalid.
    pub expires_at: u64,
    #[serde(default = "default_token_type")]
    pub token_type: String,
}

fn default_token_type() -> String {
    "Bearer".to_string()
}

/// Status reported back to the frontend for a single server.
#[derive(Debug, Clone, Serialize)]
pub struct McpAuthStatus {
    pub name: String,
    /// One of: `connected`, `disconnected`, `expired`, `error`, `not_configured`.
    pub status: String,
    /// Unix seconds when the access token expires (if known).
    pub expires_at: Option<u64>,
    pub message: Option<String>,
}

// ─── In-flight flow tracking ───────────────────────────────────────────────

struct FlowSlot {
    /// `state` parameter we issued — the callback must echo it back.
    state: String,
    code_verifier: String,
    /// Channel: listener thread sends the captured `code` (or an error string).
    /// Kept as an Option so the completion driver can take the receiver while
    /// leaving the slot in the map for cancellation by a superseding flow.
    rx: Option<std::sync::mpsc::Receiver<Result<String, String>>>,
    /// Cancellation token for the listener thread — flipping this lets the
    /// thread exit on its next poll tick, releasing the loopback port. We
    /// don't keep the `TcpListener` here because the thread needs sole
    /// ownership: only when the thread drops its handle does the OS free
    /// the port for the next flow.
    cancel: Arc<AtomicBool>,
}

impl Drop for FlowSlot {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

fn flow_slots() -> &'static Mutex<HashMap<String, FlowSlot>> {
    static SLOTS: OnceLock<Mutex<HashMap<String, FlowSlot>>> = OnceLock::new();
    SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn token_refresh_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn flow_slot_matches(server_name: &str, state: &str) -> bool {
    flow_slots()
        .lock()
        .ok()
        .and_then(|g| g.get(server_name).map(|slot| slot.state == state))
        .unwrap_or(false)
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("coppice-mcp/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn url_origin(url: &str) -> Result<String, String> {
    let (scheme, host, _path) = split_url(url)?;
    Ok(format!("{}://{}", scheme, host))
}

/// Split an http(s) URL into (scheme, host, path). The path is empty or
/// starts with '/'. Used to construct RFC 8414 well-known URLs.
fn split_url(url: &str) -> Result<(&'static str, String, String), String> {
    let (scheme, rest) = if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else {
        return Err(format!("URL must be http(s): {}", url));
    };
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if host.is_empty() {
        return Err(format!("URL has no host: {}", url));
    }
    let path_clean = path.trim_end_matches('/');
    Ok((scheme, host.to_string(), path_clean.to_string()))
}

/// Build the candidate well-known URLs for an OAuth metadata document
/// rooted at `issuer` (e.g. `https://github.com/login/oauth`). Tries:
///   1. **RFC 8414 §3.3** — `host/.well-known/<name>{path}` (the canonical
///      form when the issuer has a path component).
///   2. **Legacy "append" form** — `host{path}/.well-known/<name>` (still
///      common in the wild, e.g. for some on-prem deployments).
///   3. **Host-only** — `host/.well-known/<name>` (the issuer-is-bare case
///      and a useful fallback when servers expose the doc only at the root).
///
/// Duplicates are removed while preserving order. The list is returned in
/// the order the caller should try them.
fn well_known_urls(issuer: &str, name: &str) -> Vec<String> {
    let trimmed = issuer.trim_end_matches('/');
    let (scheme, host, path) = match split_url(trimmed) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    let mut urls: Vec<String> = Vec::new();
    if !path.is_empty() {
        // RFC 8414 §3.3 — well-known is inserted between host and path.
        urls.push(format!(
            "{}://{}/.well-known/{}{}",
            scheme, host, name, path
        ));
        // Legacy: well-known appended to the full issuer URL.
        urls.push(format!(
            "{}://{}{}/.well-known/{}",
            scheme, host, path, name
        ));
    }
    // Always try the host root — many servers publish only at the origin.
    urls.push(format!("{}://{}/.well-known/{}", scheme, host, name));
    let mut seen = std::collections::HashSet::new();
    urls.retain(|u| seen.insert(u.clone()));
    urls
}

/// Try to GET an auth-server metadata document at any of the well-known
/// locations the spec (and common variants) allow. Returns the first
/// document with both `authorization_endpoint` and `token_endpoint`.
fn fetch_auth_server_metadata(
    agent: &ureq::Agent,
    issuer: &str,
) -> Result<AuthServerMetadata, String> {
    let mut tried: Vec<String> = Vec::new();
    let mut last_error: Option<String> = None;
    let candidates: Vec<String> = well_known_urls(issuer, "oauth-authorization-server")
        .into_iter()
        .chain(well_known_urls(issuer, "openid-configuration").into_iter())
        .collect();
    if candidates.is_empty() {
        return Err(format!("Could not parse issuer URL '{}'", issuer));
    }
    for url in &candidates {
        tried.push(url.clone());
        match agent.get(url).call() {
            Ok(resp) => match resp.into_json::<AuthServerMetadata>() {
                Ok(meta)
                    if !meta.authorization_endpoint.is_empty()
                        && !meta.token_endpoint.is_empty() =>
                {
                    return Ok(meta);
                }
                Ok(_) => {
                    last_error = Some(format!("{} returned metadata missing required fields", url));
                }
                Err(e) => {
                    last_error = Some(format!("{} returned non-JSON or bad shape: {}", url, e));
                }
            },
            Err(ureq::Error::Status(code, _)) => {
                last_error = Some(format!("{} → HTTP {}", url, code));
            }
            Err(e) => {
                last_error = Some(format!("{} → {}", url, e));
            }
        }
    }
    Err(format!(
        "Could not find OAuth metadata for {}. Tried: {}. Last error: {}.",
        issuer,
        tried.join(", "),
        last_error.unwrap_or_else(|| "n/a".to_string())
    ))
}

/// Same fallback strategy as `fetch_auth_server_metadata`, but for the
/// RFC 9728 protected-resource document.
fn fetch_protected_resource(
    agent: &ureq::Agent,
    resource_url_or_origin: &str,
) -> Option<serde_json::Value> {
    // If the caller passed a URL that already looks like a well-known doc,
    // try it verbatim first.
    if resource_url_or_origin.contains("/.well-known/") {
        if let Ok(resp) = agent.get(resource_url_or_origin).call() {
            if let Ok(json) = resp.into_json::<serde_json::Value>() {
                return Some(json);
            }
        }
    }
    for url in well_known_urls(resource_url_or_origin, "oauth-protected-resource") {
        if let Ok(resp) = agent.get(&url).call() {
            if let Ok(json) = resp.into_json::<serde_json::Value>() {
                return Some(json);
            }
        }
    }
    None
}

// ─── Discovery ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct DiscoveryResult {
    pub auth_server: AuthServerMetadata,
    /// Resource indicator we should pass on the auth URL (RFC 8707). Defaults
    /// to the MCP server's origin if the resource didn't advertise one.
    pub resource: String,
    pub scopes_supported: Vec<String>,
}

/// Run the full RFC 9728 → RFC 8414 discovery dance starting from the MCP
/// server's URL. Discovery fails over multiple well-known URL forms so we
/// work with both spec-strict (RFC 8414 §3.3) servers and legacy "append"
/// servers, plus servers that expose only `openid-configuration`.
pub fn discover(server_url: &str) -> Result<DiscoveryResult, String> {
    let agent = http_agent();
    let origin = url_origin(server_url)?;

    // Step 1 — probe the server. A spec-compliant server returns 401 with
    // WWW-Authenticate pointing at its protected-resource metadata.
    let www_authenticate = match agent.get(server_url).call() {
        Ok(_) => None,
        Err(ureq::Error::Status(_, resp)) => resp.header("www-authenticate").map(|s| s.to_string()),
        Err(e) => return Err(format!("Could not reach {}: {}", server_url, e)),
    };

    // Step 2 — fetch the protected-resource metadata. We pass the absolute
    // URL the server pointed us at if WWW-Authenticate had one; otherwise
    // we let `fetch_protected_resource` try every well-known variant.
    let resource_lookup = www_authenticate
        .as_deref()
        .and_then(parse_resource_metadata_url)
        .unwrap_or_else(|| origin.clone());
    let (auth_server_issuer, scopes_supported, resource_indicator) =
        match fetch_protected_resource(&agent, &resource_lookup) {
            Some(json) => {
                let auth_servers = json
                    .get("authorization_servers")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                let first = auth_servers
                    .first()
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        "Protected-resource document didn't list any authorization_servers"
                            .to_string()
                    })?;
                let scopes = json
                    .get("scopes_supported")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let resource = json
                    .get("resource")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&origin)
                    .to_string();
                (first.to_string(), scopes, resource)
            }
            None => (origin.clone(), Vec::new(), origin.clone()),
        };

    // Step 3 — fetch the auth-server metadata, trying every well-known form
    // we know about until one of them returns a valid document. If nothing
    // works, the practical advice for the user is the same as when DCR is
    // missing — use a static API token. Surface that guidance directly.
    let mut metadata = match fetch_auth_server_metadata(&agent, &auth_server_issuer) {
        Ok(m) => m,
        Err(detail) => {
            eprintln!("[mcp-oauth] discovery failed: {}", detail);
            return Err(dcr_unsupported_message(server_url));
        }
    };

    // Backfill scopes from the auth-server doc if the resource didn't have any.
    let scopes_supported = if scopes_supported.is_empty() {
        metadata.scopes_supported.take().unwrap_or_default()
    } else {
        scopes_supported
    };

    Ok(DiscoveryResult {
        auth_server: metadata,
        resource: resource_indicator,
        scopes_supported,
    })
}

/// Parse a `WWW-Authenticate: Bearer resource_metadata="…"` header.
fn parse_resource_metadata_url(header: &str) -> Option<String> {
    let key = "resource_metadata=";
    let pos = header.find(key)?;
    let after = &header[pos + key.len()..];
    let after = after.trim_start_matches('"');
    let end = after.find('"').unwrap_or(after.len());
    Some(after[..end].to_string())
}

/// Built when the auth server doesn't advertise a `registration_endpoint`.
/// We can't complete OAuth automatically, so give the user actionable
/// guidance — server-specific where we recognise the host.
fn dcr_unsupported_message(server_url: &str) -> String {
    let host = url_origin(server_url).unwrap_or_else(|_| server_url.to_string());
    if host.contains("github") || server_url.contains("githubcopilot.com") {
        return concat!(
            "GitHub doesn't support automatic OAuth registration for MCP. ",
            "Generate a Personal Access Token at https://github.com/settings/tokens ",
            "(scopes: repo, read:org, read:user), remove this server, then re-add ",
            "via 'Add custom server' with header `Authorization: Bearer <your-token>`."
        )
        .to_string();
    }
    if host.contains("slack.com") {
        return concat!(
            "Slack's MCP server doesn't support automatic OAuth registration. ",
            "Create a Slack app, install it to your workspace, and add the bot ",
            "token via 'Add custom server' with header ",
            "`Authorization: Bearer xoxb-…`."
        )
        .to_string();
    }
    concat!(
        "This authorization server doesn't support automatic client registration. ",
        "Obtain a static API token from the provider, remove this server, then ",
        "re-add it via 'Add custom server' with header ",
        "`Authorization: Bearer <your-token>`."
    )
    .to_string()
}

// ─── Dynamic client registration (RFC 7591) ────────────────────────────────

/// Result of dynamic registration. `client_secret` is optional — public
/// (PKCE-only) clients won't get one.
pub struct RegistrationResult {
    pub client_id: String,
    pub client_secret: Option<String>,
}

pub fn register_client(
    registration_endpoint: &str,
    client_name: &str,
    redirect_uri: &str,
    scopes: &[String],
) -> Result<RegistrationResult, String> {
    let body = serde_json::json!({
        "client_name": client_name,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
        "scope": scopes.join(" "),
    });
    let resp = http_agent()
        .post(registration_endpoint)
        .set("Accept", "application/json")
        .send_json(body)
        .map_err(|e| format!("Dynamic registration failed: {}", e))?;
    let json: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("Bad registration response: {}", e))?;
    let client_id = json
        .get("client_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Registration response missing client_id".to_string())?
        .to_string();
    let client_secret = json
        .get("client_secret")
        .and_then(|v| v.as_str())
        .map(String::from);
    Ok(RegistrationResult {
        client_id,
        client_secret,
    })
}

// ─── PKCE primitives ───────────────────────────────────────────────────────

fn random_url_safe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&buf)
}

fn pkce_pair() -> (String, String) {
    let verifier = random_url_safe(64);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

// ─── Loopback callback listener ────────────────────────────────────────────

/// Bind the loopback callback port and spawn a thread that reads exactly one
/// HTTP request, validates `state`, extracts `code`, returns a "you can close
/// this tab" page, and signals via `tx`. The thread polls `cancel` and
/// exits early if the slot is replaced — that drops the listener and frees
/// the port for the next flow.
fn spawn_loopback_listener(
    expected_state: String,
    cancel: Arc<AtomicBool>,
) -> Result<std::sync::mpsc::Receiver<Result<String, String>>, String> {
    // Try a few times — a previously-cancelled flow may still be releasing
    // its socket from the kernel's TIME_WAIT, especially on Linux.
    let listener = bind_with_retry()?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking: {}", e))?;

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    thread::spawn(move || {
        let deadline = std::time::Instant::now() + FLOW_TIMEOUT;
        loop {
            if cancel.load(Ordering::Relaxed) {
                // Drop listener (return) → port released.
                return;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    // On macOS the accepted socket inherits the listener's
                    // O_NONBLOCK flag, which makes the subsequent read_line
                    // fail with EAGAIN ("Resource temporarily unavailable").
                    // Force blocking mode for the per-request handler.
                    if let Err(e) = stream.set_nonblocking(false) {
                        let _ = tx.send(Err(format!("set_nonblocking(false): {}", e)));
                        return;
                    }
                    let result = handle_callback(stream, &expected_state);
                    let _ = tx.send(result);
                    return;
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() >= deadline {
                        let _ = tx.send(Err("OAuth flow timed out (5 min)".to_string()));
                        return;
                    }
                    thread::sleep(Duration::from_millis(150));
                }
                Err(e) => {
                    let _ = tx.send(Err(format!("Listener accept: {}", e)));
                    return;
                }
            }
        }
    });
    Ok(rx)
}

fn bind_with_retry() -> Result<TcpListener, String> {
    let mut last_err: Option<std::io::Error> = None;
    for _ in 0..10 {
        match TcpListener::bind(("127.0.0.1", LOOPBACK_PORT)) {
            Ok(l) => return Ok(l),
            Err(e) => {
                last_err = Some(e);
                thread::sleep(Duration::from_millis(150));
            }
        }
    }
    Err(format!(
        "Could not bind 127.0.0.1:{} for the OAuth callback ({}). Close any process using that port and try again.",
        LOOPBACK_PORT,
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn handle_callback(mut stream: TcpStream, expected_state: &str) -> Result<String, String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| format!("read request line: {}", e))?;
    // Drain headers (we don't care about them, but the browser won't release
    // the socket until we read them).
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
    }

    // GET /callback?code=…&state=… HTTP/1.1
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    let path_and_query = parts.get(1).copied().unwrap_or("/");
    let query = path_and_query.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut params: HashMap<String, String> = HashMap::new();
    for kv in query.split('&') {
        if let Some((k, v)) = kv.split_once('=') {
            params.insert(
                k.to_string(),
                urlencoding::decode(v)
                    .map(|s| s.into_owned())
                    .unwrap_or_default(),
            );
        }
    }

    let body_ok = "<!doctype html><html><body style=\"font-family:system-ui;padding:48px;max-width:480px;margin:0 auto;text-align:center\"><h2>Connected ✓</h2><p>You can close this tab and return to Coppice.</p></body></html>";
    let body_err = "<!doctype html><html><body style=\"font-family:system-ui;padding:48px;max-width:480px;margin:0 auto;text-align:center\"><h2>Connection failed</h2><p>Return to Coppice for details.</p></body></html>";

    let result = if let Some(err) = params.get("error") {
        let msg = params
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| err.clone());
        let _ = write_response(&mut stream, 400, body_err);
        Err(format!("Authorization rejected: {}", msg))
    } else if params.get("state").map(String::as_str) != Some(expected_state) {
        let _ = write_response(&mut stream, 400, body_err);
        Err("State mismatch — possible CSRF, aborting".to_string())
    } else if let Some(code) = params.get("code") {
        let _ = write_response(&mut stream, 200, body_ok);
        Ok(code.clone())
    } else {
        let _ = write_response(&mut stream, 400, body_err);
        Err("Callback missing `code`".to_string())
    };
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
    result
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let status_text = match status {
        200 => "OK",
        400 => "Bad Request",
        _ => "Error",
    };
    let resp = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        status,
        status_text,
        body.len(),
        body
    );
    stream.write_all(resp.as_bytes())
}

// ─── Token endpoint ────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
}

fn exchange_code(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    redirect_uri: &str,
    code: &str,
    code_verifier: &str,
    resource: Option<&str>,
) -> Result<StoredTokens, String> {
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri.to_string()),
        ("client_id", client_id.to_string()),
        ("code_verifier", code_verifier.to_string()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_string()));
    }
    if let Some(resource) = resource.filter(|r| !r.is_empty()) {
        form.push(("resource", resource.to_string()));
    }
    post_token(token_endpoint, &form)
}

fn refresh_with(
    token_endpoint: &str,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
    resource: Option<&str>,
) -> Result<StoredTokens, String> {
    let mut form = vec![
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("client_id", client_id.to_string()),
    ];
    if let Some(secret) = client_secret {
        form.push(("client_secret", secret.to_string()));
    }
    if let Some(resource) = resource.filter(|r| !r.is_empty()) {
        form.push(("resource", resource.to_string()));
    }
    post_token(token_endpoint, &form)
}

fn post_token(endpoint: &str, form: &[(&str, String)]) -> Result<StoredTokens, String> {
    let pairs: Vec<(&str, &str)> = form.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let resp = http_agent()
        .post(endpoint)
        .set("Accept", "application/json")
        .send_form(&pairs)
        .map_err(|e| match e {
            ureq::Error::Status(code, r) => {
                let body = r.into_string().unwrap_or_default();
                format!("Token endpoint returned {}: {}", code, body)
            }
            other => format!("Token endpoint error: {}", other),
        })?;
    let parsed: TokenResponse = resp
        .into_json()
        .map_err(|e| format!("Bad token response: {}", e))?;
    // `expires_in` is optional in OAuth token responses. If a provider omits
    // it, don't invent a short one-hour expiry that would force needless
    // re-authentication; treat it as long-lived unless the provider tells us
    // otherwise.
    let expires_in = parsed.expires_in.unwrap_or(10 * 365 * 24 * 60 * 60);
    Ok(StoredTokens {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token,
        expires_at: now_unix() + expires_in,
        token_type: parsed.token_type.unwrap_or_else(default_token_type),
    })
}

// ─── Secret store plumbing ─────────────────────────────────────────────────
//
// Tokens and per-server client secrets live in a machine-bound encrypted
// file (`secret_store`) rather than the OS keychain — that's deliberate so
// users don't have to dismiss "Coppice wants to access your keychain"
// dialogs on every dev rebuild. See `services/secret_store.rs` for the
// security trade-offs.

fn token_key(server_name: &str) -> String {
    format!("tokens:{}", server_name)
}

fn secret_key(server_name: &str) -> String {
    format!("client_secret:{}", server_name)
}

pub fn save_tokens(server_name: &str, tokens: &StoredTokens) -> Result<(), String> {
    let json = serde_json::to_string(tokens).map_err(|e| e.to_string())?;
    secret_store::save(&token_key(server_name), &json)
}

pub fn load_tokens(server_name: &str) -> Result<Option<StoredTokens>, String> {
    let raw = match secret_store::load(&token_key(server_name))? {
        Some(s) => s,
        None => return Ok(None),
    };
    let parsed: StoredTokens =
        serde_json::from_str(&raw).map_err(|e| format!("bad stored tokens: {}", e))?;
    Ok(Some(parsed))
}

pub fn delete_tokens(server_name: &str) -> Result<(), String> {
    secret_store::delete(&token_key(server_name))
}

fn save_client_secret(server_name: &str, secret: &str) -> Result<(), String> {
    secret_store::save(&secret_key(server_name), secret)
}

fn load_client_secret(server_name: &str) -> Result<Option<String>, String> {
    secret_store::load(&secret_key(server_name))
}

fn delete_client_secret(server_name: &str) -> Result<(), String> {
    secret_store::delete(&secret_key(server_name))
}

// ─── High-level orchestration ──────────────────────────────────────────────

pub fn redirect_uri() -> String {
    format!("http://127.0.0.1:{}/callback", LOOPBACK_PORT)
}

/// Outcome of `start_authorization` — the URL to open in the browser plus a
/// handle for completion.
pub struct StartedFlow {
    pub auth_url: String,
    /// Caller polls this. Receives `Ok(StoredTokens)` on success or `Err`.
    pub completion_rx: std::sync::mpsc::Receiver<Result<StoredTokens, String>>,
}

/// Begin a full OAuth flow for `server_name`. Updates `entry.oauth` with
/// discovered endpoints + client_id and saves it to settings BEFORE opening
/// the browser, so resuming later works even if the user kills Coppice
/// mid-flow. The returned `completion_rx` resolves when the user finishes
/// (or times out / errors).
pub fn start_authorization(
    server_name: &str,
    server_url: &str,
    extra_scopes: &[String],
    client_name: &str,
    existing_oauth: Option<&McpOAuthState>,
) -> Result<(StartedFlow, McpOAuthState), String> {
    // Cancel ANY in-flight flow (not just one for this server). All flows
    // share the same loopback port, so a previously-abandoned flow for a
    // different server would otherwise still be holding it. Dropping each
    // FlowSlot trips its cancel flag; the listener thread releases the
    // port within ~150ms, which `bind_with_retry` accommodates.
    flow_slots().lock().map_err(|e| e.to_string())?.clear();

    // Discovery → registration → start listener → build URL.
    let DiscoveryResult {
        auth_server,
        resource,
        scopes_supported,
    } = discover(server_url)?;

    // Choose scopes: catalog/extra scopes first; else the server's advertised list.
    let scopes: Vec<String> = if !extra_scopes.is_empty() {
        extra_scopes.to_vec()
    } else {
        scopes_supported.clone()
    };

    // Reuse an existing dynamic client registration where possible. Re-running
    // DCR on every "Reconnect" churns provider-side client records and can
    // invalidate/lose the client secret needed for refresh. If the saved state
    // is incomplete, fall back to fresh registration.
    let stored_secret = load_client_secret(server_name).ok().flatten();
    let redirect = redirect_uri();
    let existing_client = existing_oauth.and_then(|o| {
        let has_usable_secret = !o.has_client_secret || stored_secret.is_some();
        if !o.client_id.is_empty() && has_usable_secret {
            Some((
                o.client_id.clone(),
                stored_secret.clone(),
                o.has_client_secret,
            ))
        } else {
            None
        }
    });
    let registration_endpoint = auth_server.registration_endpoint.clone();
    let (client_id, client_secret, has_client_secret) = if let Some(existing) = existing_client {
        existing
    } else {
        let endpoint = registration_endpoint
            .as_deref()
            .ok_or_else(|| dcr_unsupported_message(server_url))?;
        let registration = register_client(endpoint, client_name, &redirect, &scopes)?;
        if let Some(ref secret) = registration.client_secret {
            save_client_secret(server_name, secret)?;
        } else if stored_secret.is_some() {
            // Previous registration had a secret; clear it.
            let _ = delete_client_secret(server_name);
        }
        (
            registration.client_id,
            registration.client_secret.clone(),
            registration.client_secret.is_some(),
        )
    };

    // Listener on the loopback port — must come before opening the browser
    // so we don't race a fast user.
    let state = random_url_safe(24);
    let cancel = Arc::new(AtomicBool::new(false));
    let rx = spawn_loopback_listener(state.clone(), cancel.clone())?;
    let (verifier, challenge) = pkce_pair();

    flow_slots().lock().map_err(|e| e.to_string())?.insert(
        server_name.to_string(),
        FlowSlot {
            state: state.clone(),
            code_verifier: verifier.clone(),
            rx: Some(rx),
            cancel,
        },
    );

    // Build the authorization URL.
    let mut auth_url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&code_challenge={}&code_challenge_method=S256&state={}",
        auth_server.authorization_endpoint,
        urlencoding::encode(&client_id),
        urlencoding::encode(&redirect),
        urlencoding::encode(&challenge),
        urlencoding::encode(&state),
    );
    if !scopes.is_empty() {
        auth_url.push_str("&scope=");
        auth_url.push_str(&urlencoding::encode(&scopes.join(" ")));
    }
    if !resource.is_empty() {
        auth_url.push_str("&resource=");
        auth_url.push_str(&urlencoding::encode(&resource));
    }

    let oauth_state = McpOAuthState {
        authorization_endpoint: auth_server.authorization_endpoint.clone(),
        token_endpoint: auth_server.token_endpoint.clone(),
        resource: resource.clone(),
        registration_endpoint,
        client_id: client_id.clone(),
        has_client_secret,
        scopes,
        connected: false,
        last_auth_at: None,
    };

    // Spawn the completion driver: wait for the listener to deliver a code,
    // exchange it, and forward the StoredTokens via completion_rx.
    let (completion_tx, completion_rx) = std::sync::mpsc::channel::<Result<StoredTokens, String>>();
    let server_name_clone = server_name.to_string();
    let oauth_state_clone = oauth_state.clone();
    let redirect_clone = redirect.clone();
    let verifier_clone = verifier.clone();
    thread::spawn(move || {
        // Take the receiver while leaving the slot in the global map. That lets
        // a newer OAuth attempt cancel the listener promptly instead of being
        // blocked by the fixed callback port until this thread times out.
        let rx = match flow_slots().lock().ok().and_then(|mut g| {
            let slot = g.get_mut(&server_name_clone)?;
            if slot.code_verifier != verifier_clone || slot.state != state {
                return None;
            }
            slot.rx.take()
        }) {
            Some(rx) => rx,
            None => return, // superseded
        };
        let received = rx.recv_timeout(FLOW_TIMEOUT + Duration::from_secs(10));
        if received.is_err() && !flow_slot_matches(&server_name_clone, &state) {
            let _ = completion_tx.send(Err(FLOW_SUPERSEDED.to_string()));
            return;
        }
        let result = (|| -> Result<StoredTokens, String> {
            let code = received.map_err(|_| "OAuth listener channel closed".to_string())??;
            let tokens = exchange_code(
                &oauth_state_clone.token_endpoint,
                &client_id,
                client_secret.as_deref(),
                &redirect_clone,
                &code,
                &verifier_clone,
                Some(&oauth_state_clone.resource),
            )?;
            save_tokens(&server_name_clone, &tokens)?;
            Ok(tokens)
        })();
        if let Ok(mut g) = flow_slots().lock() {
            if g.get(&server_name_clone).map(|s| s.state.as_str()) == Some(state.as_str()) {
                g.remove(&server_name_clone);
            }
        }
        let _ = completion_tx.send(result);
    });

    Ok((
        StartedFlow {
            auth_url,
            completion_rx,
        },
        oauth_state,
    ))
}

/// Called from `agent_start` for each MCP server with an OAuth config.
/// Returns the bearer access token, refreshing if it expires within 60s.
/// Returns `Ok(None)` if the server has no stored tokens (let it start
/// unauthenticated; the bridge will surface the 401).
fn resource_for_entry(oauth: &McpOAuthState, entry: &McpServerEntry) -> Option<String> {
    if !oauth.resource.is_empty() {
        return Some(oauth.resource.clone());
    }
    // Migration fallback for settings written before we persisted the RFC 8707
    // resource. `discover` also defaults to the server origin when the
    // protected-resource document doesn't advertise a more specific value.
    entry.url.as_deref().and_then(|url| url_origin(url).ok())
}

pub fn access_token_for_session(
    server_name: &str,
    entry: &McpServerEntry,
) -> Result<Option<String>, String> {
    let oauth = match &entry.oauth {
        Some(o) => o,
        None => return Ok(None),
    };
    // Atlassian uses rotating refresh tokens. Serialize refresh attempts so a
    // status poll and an agent start cannot both spend the same refresh token.
    let _refresh_guard = token_refresh_lock().lock().map_err(|e| e.to_string())?;
    let mut tokens = match load_tokens(server_name)? {
        Some(t) => t,
        None => return Ok(None),
    };
    // Refresh if we're within 60s of expiry. Never inject a known-expired
    // bearer token — it just produces opaque 401s from the MCP server.
    if tokens.expires_at <= now_unix() + 60 {
        if let Some(rt) = tokens.refresh_token.clone() {
            if oauth.token_endpoint.is_empty() || oauth.client_id.is_empty() {
                return Err("OAuth metadata is incomplete; reconnect this MCP server".to_string());
            }
            let secret = load_client_secret(server_name).ok().flatten();
            let resource = resource_for_entry(oauth, entry);
            tokens = refresh_with(
                &oauth.token_endpoint,
                &oauth.client_id,
                secret.as_deref(),
                &rt,
                resource.as_deref(),
            )?;
            // Some IdPs omit a refresh_token on refresh; preserve the old one
            // so the next refresh still works.
            if tokens.refresh_token.is_none() {
                tokens.refresh_token = Some(rt);
            }
            save_tokens(server_name, &tokens)?;
        } else {
            return Err("OAuth access token expired and no refresh token is available; reconnect this MCP server".to_string());
        }
    }
    Ok(Some(tokens.access_token))
}

/// Compute the user-visible status for a server.
pub fn status_for(server_name: &str, entry: &McpServerEntry) -> McpAuthStatus {
    if entry.oauth.is_none() {
        return McpAuthStatus {
            name: server_name.to_string(),
            status: "not_configured".into(),
            expires_at: None,
            message: None,
        };
    }
    match load_tokens(server_name) {
        Ok(Some(mut tokens)) => {
            let now = now_unix();
            // Status polling is a safe place to perform an on-demand refresh,
            // so the UI doesn't show "expired" for a token we can refresh and
            // the next agent session doesn't start with stale credentials.
            if tokens.expires_at <= now + 60 && tokens.refresh_token.is_some() {
                if let Err(e) = access_token_for_session(server_name, entry) {
                    return McpAuthStatus {
                        name: server_name.to_string(),
                        status: "error".into(),
                        expires_at: Some(tokens.expires_at),
                        message: Some(format!("Refresh failed: {}", e)),
                    };
                }
                if let Ok(Some(refreshed)) = load_tokens(server_name) {
                    tokens = refreshed;
                }
            }
            let now = now_unix();
            let status = if tokens.expires_at > now + 60 {
                "connected"
            } else {
                "expired"
            };
            McpAuthStatus {
                name: server_name.to_string(),
                status: status.into(),
                expires_at: Some(tokens.expires_at),
                message: None,
            }
        }
        Ok(None) => McpAuthStatus {
            name: server_name.to_string(),
            status: "disconnected".into(),
            expires_at: None,
            message: None,
        },
        Err(e) => McpAuthStatus {
            name: server_name.to_string(),
            status: "error".into(),
            expires_at: None,
            message: Some(e),
        },
    }
}

/// Wipe all OAuth state for a server (secret store + flow slots).
pub fn revoke(server_name: &str) -> Result<(), String> {
    flow_slots()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(server_name);
    let _ = delete_tokens(server_name);
    let _ = delete_client_secret(server_name);
    Ok(())
}
