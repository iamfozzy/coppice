use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Per-server OAuth metadata persisted in settings.toml. Only non-secret
/// data lives here — access/refresh tokens are stored in Coppice's encrypted
/// local secret store.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpOAuthState {
    /// Discovered authorization endpoint (RFC 8414).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub authorization_endpoint: String,
    /// Discovered token endpoint.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub token_endpoint: String,
    /// RFC 8707 resource indicator for the MCP server. Some providers (notably
    /// Atlassian) bind tokens to this audience and require it during token
    /// exchange/refresh as well as on the authorization URL.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub resource: String,
    /// Optional dynamic-registration endpoint (RFC 7591).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registration_endpoint: Option<String>,
    /// Client ID returned from dynamic registration (or pre-registered).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_id: String,
    /// Whether a client secret is stored in the secret store (true=confidential client).
    #[serde(default)]
    pub has_client_secret: bool,
    /// Requested scopes (space-separated value the AS will see).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
    /// True when the secret store currently holds a non-expired (or refreshable) token set.
    #[serde(default)]
    pub connected: bool,
    /// Unix timestamp of last successful auth/refresh — purely informational.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_auth_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerEntry {
    pub server_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub env: HashMap<String, String>,
    /// Static headers for http/sse transports (e.g. a fixed Authorization Bearer
    /// supplied by the user). Merged with — and overridden by — the OAuth
    /// access token when an OAuth flow has been completed.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
    /// OAuth state for http/sse servers that authenticate via OAuth 2.1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth: Option<McpOAuthState>,
    /// Identifies which catalog entry this server was created from. Lets the
    /// UI badge "Atlassian Rovo" instead of just the server name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub editor_command: String,
    pub claude_command: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub app_font_size: u16,
    pub terminal_emulator: String,
    pub shell: String,
    pub theme: String,
    pub window_decorations: bool,
    pub notification_sound: bool,
    pub notification_popup: bool,
    pub default_claude_mode: String,
    pub claude_cli_statusline_enabled: bool,
    pub claude_cli_statusline_git: bool,
    pub claude_cli_statusline_colors: bool,
    pub claude_cli_notifications: bool,
    pub claude_cli_fullscreen: bool,
    pub claude_cli_terminal_progress: bool,
    pub agent_default_model: String,
    pub agent_default_effort: String,
    pub agent_default_extended_context: bool,
    pub agent_api_key: String,
    pub agent_base_url: String,
    pub agent_base_url_custom_only: bool,
    pub agent_api_key_custom_only: bool,
    pub agent_small_fast_model: String,
    pub agent_subagent_model: String,
    pub agent_bash_max_output: u32,
    pub agent_task_max_output: u32,
    pub mcp_servers: HashMap<String, McpServerEntry>,

    // Pi Agent backend
    pub agent_backend: String,
    pub pi_default_provider: String,
    pub pi_default_model: String,
    pub pi_enable_web_access: bool,
    pub pi_enable_subagent: bool,
    pub pi_api_keys: HashMap<String, String>,
    pub pi_configured_providers: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            editor_command: String::new(),
            claude_command: String::new(),
            terminal_font_family: String::new(),
            terminal_font_size: 0,
            app_font_size: 16,
            terminal_emulator: String::new(),
            shell: String::new(),
            theme: "dim".to_string(),
            window_decorations: true,
            notification_sound: true,
            notification_popup: true,
            default_claude_mode: "claude".to_string(),
            claude_cli_statusline_enabled: true,
            claude_cli_statusline_git: true,
            claude_cli_statusline_colors: true,
            claude_cli_notifications: true,
            claude_cli_fullscreen: true,
            claude_cli_terminal_progress: true,
            agent_default_model: String::new(),
            agent_default_effort: "medium".to_string(),
            agent_default_extended_context: false,
            agent_api_key: String::new(),
            agent_base_url: String::new(),
            agent_base_url_custom_only: false,
            agent_api_key_custom_only: false,
            agent_small_fast_model: String::new(),
            agent_subagent_model: String::new(),
            agent_bash_max_output: 15000,
            agent_task_max_output: 15000,
            mcp_servers: HashMap::new(),

            agent_backend: "claude".to_string(),
            pi_default_provider: "anthropic".to_string(),
            pi_default_model: "claude-sonnet-4-20250514".to_string(),
            pi_enable_web_access: true,
            pi_enable_subagent: true,
            pi_api_keys: HashMap::new(),
            pi_configured_providers: vec!["anthropic".to_string()],
        }
    }
}

pub struct SettingsState(pub Mutex<AppSettings>);

impl SettingsState {
    pub fn new() -> Self {
        Self(Mutex::new(load_settings()))
    }

    pub fn get(&self) -> AppSettings {
        self.0.lock().unwrap().clone()
    }
}

fn settings_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("coppice");
    path.push("settings.toml");
    path
}

pub fn load_settings() -> AppSettings {
    let path = settings_path();
    match std::fs::read_to_string(&path) {
        Ok(contents) => toml::from_str(&contents).unwrap_or_default(),
        Err(_) => AppSettings::default(),
    }
}

pub fn save_settings(settings: &AppSettings) -> Result<(), String> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir: {}", e))?;
    }
    let contents =
        toml::to_string_pretty(settings).map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}
