use tauri::State;
use crate::settings::{AppSettings, SettingsState, save_settings};

#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> AppSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn update_settings(state: State<'_, SettingsState>, mut settings: AppSettings) -> Result<AppSettings, String> {
    let current = state.0.lock().unwrap();

    // The backend is the sole authority for OAuth metadata (token_endpoint,
    // client_id, etc.) — the frontend form may hold a stale snapshot from
    // before discovery/refresh completed.  Preserve the backend's OAuth state
    // for every MCP server that exists in both the incoming and current
    // settings so a Save from the modal doesn't silently wipe discovered
    // metadata.
    for (name, incoming) in settings.mcp_servers.iter_mut() {
        if let Some(current_entry) = current.mcp_servers.get(name) {
            if let Some(current_oauth) = &current_entry.oauth {
                incoming.oauth = Some(current_oauth.clone());
            }
        }
    }

    drop(current);
    save_settings(&settings)?;
    let mut guard = state.0.lock().unwrap();
    *guard = settings.clone();
    Ok(settings)
}
