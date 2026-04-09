use tauri::{AppHandle, State};
use crate::services::pty_manager::PtyManager;

#[tauri::command]
pub fn terminal_spawn(
    pty: State<'_, PtyManager>,
    app: AppHandle,
    session_id: String,
    cwd: String,
    command: Option<String>,
    rows: Option<u16>,
    cols: Option<u16>,
) -> Result<(), String> {
    pty.spawn(&session_id, &cwd, command.as_deref(), rows.unwrap_or(24), cols.unwrap_or(80), &app)
}

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
