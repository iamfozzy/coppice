use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub editor_command: String,
    pub claude_command: String,
    pub terminal_font_family: String,
    pub terminal_font_size: u16,
    pub terminal_emulator: String,
    pub shell: String,
    pub window_decorations: bool,
    pub notification_sound: bool,
    pub notification_popup: bool,
    pub default_claude_mode: String,
    pub agent_default_model: String,
    pub agent_default_effort: String,
    pub agent_node_path: String,
    pub agent_api_key: String,
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
            window_decorations: true,
            notification_sound: true,
            notification_popup: true,
            default_claude_mode: "terminal".to_string(),
            agent_default_model: String::new(),
            agent_default_effort: "high".to_string(),
            agent_node_path: String::new(),
            agent_api_key: String::new(),
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
