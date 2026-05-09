use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub editor_command: String,
    pub claude_command: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub terminal_emulator: String,
    pub shell: String,
    pub theme: String,
    pub window_decorations: bool,
    pub notification_sound: bool,
    pub notification_popup: bool,
    pub default_claude_mode: String,
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
            terminal_emulator: String::new(),
            shell: String::new(),
            theme: "dark".to_string(),
            window_decorations: true,
            notification_sound: true,
            notification_popup: true,
            default_claude_mode: "agent".to_string(),
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
    let contents = toml::to_string_pretty(settings).map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write settings: {}", e))?;
    Ok(())
}
