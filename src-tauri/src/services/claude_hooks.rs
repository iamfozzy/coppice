use notify::{EventKind, RecursiveMode, Watcher};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

/// Directory where hook status files live.
/// Each Claude PTY session gets `<session_id>.status` written here
/// by Claude Code's hook when the agent reaches a stopping point.
pub fn hook_dir() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("coppice");
    path.push("hooks");
    path
}

/// Ensure the hook directory exists and clean up stale status files
/// from previous Coppice sessions (e.g. after a crash).
pub fn init_hook_dir() {
    let dir = hook_dir();
    let _ = std::fs::create_dir_all(&dir);
    // Remove stale .status files — no active PTY sessions exist at startup.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                == Some("status")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Remove the status file for a PTY session. Called on session kill/exit
/// to prevent stale files from accumulating.
pub fn cleanup_session(session_id: &str) {
    let mut path = hook_dir();
    path.push(format!("{}.status", session_id));
    let _ = std::fs::remove_file(path);
}

/// Watches the hook directory for .status file writes and emits Tauri
/// events so the frontend can react to Claude Code hook signals.
///
/// The watcher must be held alive for its lifetime — dropping it stops
/// the watch. Store it in Tauri managed state.
pub struct ClaudeHookWatcher {
    _watcher: notify::RecommendedWatcher,
}

impl ClaudeHookWatcher {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let dir = hook_dir();

        let app_handle = app.clone();
        let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            let event = match res {
                Ok(e) => e,
                Err(_) => return,
            };
            // Only care about creates and writes — the hook overwrites the
            // file each time it fires.
            match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) => {}
                _ => return,
            }
            for path in &event.paths {
                if path.extension().and_then(|e| e.to_str()) != Some("status") {
                    continue;
                }
                let session_id = match path.file_stem().and_then(|s| s.to_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let content = match std::fs::read_to_string(path) {
                    Ok(c) => c.trim().to_string(),
                    Err(_) => continue,
                };
                if content.is_empty() {
                    continue;
                }
                let event_name = format!("claude-hook-{}", session_id);
                let _ = app_handle.emit(&event_name, &content);
            }
        })
        .map_err(|e| format!("Failed to create file watcher: {}", e))?;

        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| format!("Failed to watch hook dir: {}", e))?;

        Ok(Self { _watcher: watcher })
    }
}
