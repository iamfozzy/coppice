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
        }
    }
}

pub struct SettingsState(pub Mutex<AppSettings>);

impl SettingsState {
    pub fn new() -> Self {
        Self(Mutex::new(load_settings()))
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
