use std::path::PathBuf;

/// Sentinel substring present in every hook command Coppice installs.
/// Used to find/remove our entries without disturbing user-defined hooks.
const SENTINEL: &str = "COPPICE_HOOK_DIR";

/// Path to the user-level Claude Code settings file.
fn claude_settings_path() -> PathBuf {
    let mut p = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push(".claude");
    p.push("settings.json");
    p
}

/// Build the hook command for a given event type.
/// On macOS/Linux, uses `sh -c` with a guard so non-Coppice Claude sessions
/// no-op silently. On Windows, uses `cmd /c` with `if defined` guards.
fn hook_command(event: &str) -> String {
    if cfg!(target_os = "windows") {
        // cmd.exe: `if defined` checks both vars, writes the event to the
        // status file. `2>nul` suppresses errors when the dir doesn't exist
        // (i.e. Coppice isn't running).
        format!(
            r#"cmd /c "if defined COPPICE_HOOK_DIR if defined COPPICE_SESSION_ID (echo {event}> "%COPPICE_HOOK_DIR%\%COPPICE_SESSION_ID%.status") 2>nul""#,
            event = event,
        )
    } else {
        format!(
            r#"sh -c '[ -n "$COPPICE_HOOK_DIR" ] && [ -n "$COPPICE_SESSION_ID" ] && printf "%s" "{event}" > "$COPPICE_HOOK_DIR/$COPPICE_SESSION_ID.status" 2>/dev/null; exit 0'"#,
            event = event,
        )
    }
}

/// Read the Claude settings file, returning a mutable JSON object.
/// Returns a fresh `{}` object if the file doesn't exist or can't be parsed.
fn read_claude_settings() -> serde_json::Value {
    let path = claude_settings_path();
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|_| serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    }
}

/// Write the JSON object back to the Claude settings file.
fn write_claude_settings(value: &serde_json::Value) -> Result<(), String> {
    let path = claude_settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {}", parent.display(), e))?;
    }
    let contents = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(&path, contents)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    Ok(())
}

/// Returns true if a hook array contains a Coppice-managed entry.
fn has_coppice_hook(hooks_array: &serde_json::Value) -> bool {
    if let Some(arr) = hooks_array.as_array() {
        for entry in arr {
            if let Some(inner) = entry.get("hooks").and_then(|h| h.as_array()) {
                for hook in inner {
                    if let Some(cmd) = hook.get("command").and_then(|c| c.as_str()) {
                        if cmd.contains(SENTINEL) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Build a single hook entry for an event type.
fn make_hook_entry(event: &str) -> serde_json::Value {
    serde_json::json!({
        "matcher": "",
        "hooks": [
            {
                "type": "command",
                "command": hook_command(event)
            }
        ]
    })
}

/// Remove all Coppice-managed entries from a hook array, returning the
/// filtered array.
fn remove_coppice_entries(hooks_array: &serde_json::Value) -> serde_json::Value {
    match hooks_array.as_array() {
        Some(arr) => {
            let filtered: Vec<&serde_json::Value> = arr
                .iter()
                .filter(|entry| {
                    // Keep the entry if none of its inner hooks contain our sentinel
                    if let Some(inner) = entry.get("hooks").and_then(|h| h.as_array()) {
                        !inner.iter().any(|hook| {
                            hook.get("command")
                                .and_then(|c| c.as_str())
                                .map(|c| c.contains(SENTINEL))
                                .unwrap_or(false)
                        })
                    } else {
                        true
                    }
                })
                .collect();
            serde_json::json!(filtered)
        }
        None => serde_json::json!([]),
    }
}

// ── Tauri commands ──

/// Check whether Coppice hooks are installed in ~/.claude/settings.json.
#[tauri::command]
pub fn check_claude_hooks_installed() -> bool {
    let settings = read_claude_settings();
    let hooks = settings.get("hooks").cloned().unwrap_or_else(|| serde_json::json!({}));

    // We consider hooks "installed" if at least the Stop hook is present.
    let stop = hooks.get("Stop").cloned().unwrap_or_else(|| serde_json::json!([]));
    has_coppice_hook(&stop)
}

/// Install Coppice-managed hooks into ~/.claude/settings.json.
/// Merges with any existing hooks the user has configured.
#[tauri::command]
pub fn install_claude_hooks() -> Result<(), String> {
    let mut settings = read_claude_settings();

    let hooks = settings
        .as_object_mut()
        .ok_or("Settings is not an object")?
        .entry("hooks")
        .or_insert_with(|| serde_json::json!({}));

    let hooks_obj = hooks
        .as_object_mut()
        .ok_or("hooks is not an object")?;

    // Events we install hooks for.
    let events = ["Stop", "Notification"];

    for event in &events {
        let arr = hooks_obj
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]));

        // Skip if already installed (idempotent).
        if has_coppice_hook(arr) {
            continue;
        }

        // Append our entry.
        if let Some(vec) = arr.as_array_mut() {
            vec.push(make_hook_entry(event));
        }
    }

    write_claude_settings(&settings)
}

/// Remove all Coppice-managed hooks from ~/.claude/settings.json.
#[tauri::command]
pub fn uninstall_claude_hooks() -> Result<(), String> {
    let mut settings = read_claude_settings();

    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_event, arr) in hooks.iter_mut() {
            *arr = remove_coppice_entries(arr);
        }
    }

    write_claude_settings(&settings)
}
