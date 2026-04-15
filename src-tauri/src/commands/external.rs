use std::process::Command;
use crate::settings::SettingsState;

#[tauri::command]
pub async fn open_in_editor(state: tauri::State<'_, SettingsState>, path: String) -> Result<(), String> {
    let editor = {
        let settings = state.0.lock().unwrap();
        settings.editor_command.clone()
    };

    #[cfg(target_os = "macos")]
    {
        if editor.is_empty() {
            Command::new("open")
                .args(["-a", "Visual Studio Code", &path])
                .spawn()
                .map_err(|e| format!("Failed to open editor: {}", e))?;
        } else {
            Command::new(&editor)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to open editor '{}': {}", editor, e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let cmd = if editor.is_empty() { "code".to_string() } else { editor };
        Command::new(&cmd)
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open editor '{}': {}", cmd, e))?;
    }

    #[cfg(target_os = "windows")]
    {
        let ed = if editor.is_empty() { "code".to_string() } else { editor };
        // Try direct invocation first — safer than routing through `cmd /c`,
        // which reinterprets `&`, `|`, `^`, `%` in the path. Many editor
        // launchers are .exe (Sublime, IntelliJ, Cursor) and work directly.
        //
        // If the launcher is a batch file (VS Code ships as `code.cmd`),
        // CreateProcessW can't execute it without a full path, so fall back
        // to `cmd /c` — at that point metacharacters in the editor binary
        // name are already trusted (user-configured setting).
        let direct = Command::new(&ed).arg(&path).spawn();
        if direct.is_err() {
            // Hide the transient cmd.exe window while it launches the editor.
            // The editor itself is a GUI app and creates its own window
            // independently of cmd's console, so the user only sees the editor.
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            Command::new("cmd")
                .arg("/c")
                .arg(&ed)
                .arg(&path)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("Failed to open editor '{}': {}", ed, e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_in_terminal(state: tauri::State<'_, SettingsState>, path: String) -> Result<(), String> {
    let terminal = {
        let settings = state.0.lock().unwrap();
        settings.terminal_emulator.clone()
    };

    #[cfg(target_os = "macos")]
    {
        if terminal.is_empty() {
            Command::new("open")
                .args(["-a", "Terminal", &path])
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        } else {
            Command::new(&terminal)
                .arg(&path)
                .spawn()
                .map_err(|e| format!("Failed to open terminal '{}': {}", terminal, e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if !terminal.is_empty() {
            let attempts: &[&[&str]] = &[
                &["--working-directory", &path],
                &["--workdir", &path],
                &["-e", &format!("cd '{}' && exec $SHELL", path)],
            ];
            let mut launched = false;
            for args in attempts {
                if Command::new(&terminal).args(*args).spawn().is_ok() {
                    launched = true;
                    break;
                }
            }
            if !launched {
                return Err(format!("Failed to open terminal '{}'", terminal));
            }
        } else {
            let attempts: &[(&str, &[&str])] = &[
                ("x-terminal-emulator", &["--working-directory", &path]),
                ("gnome-terminal", &["--working-directory", &path]),
                ("konsole", &["--workdir", &path]),
                ("alacritty", &["--working-directory", &path]),
                ("xfce4-terminal", &["--working-directory", &path]),
                ("xterm", &["-e", &format!("cd '{}' && exec $SHELL", path)]),
            ];
            let mut launched = false;
            for (term, args) in attempts {
                if Command::new(term).args(*args).spawn().is_ok() {
                    launched = true;
                    break;
                }
            }
            if !launched {
                return Err("No terminal emulator found".to_string());
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Prefer Windows Terminal invoked directly: Rust's Command properly
        // escapes args per CommandLineToArgvW, and wt.exe handles spaces and
        // special chars in the -d path without going through cmd.
        let wt = Command::new("wt")
            .args(["-d", &path])
            .spawn();

        if wt.is_err() {
            // Fallback: spawn cmd.exe directly in its own console window using
            // current_dir. Avoids the `start` + path-in-string approach, which
            // has cmd's metacharacter-reinterpretation and the
            // "first-quoted-arg-is-window-title" footgun.
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            Command::new("cmd.exe")
                .arg("/k")
                .current_dir(&path)
                .creation_flags(CREATE_NEW_CONSOLE)
                .spawn()
                .map_err(|e| format!("Failed to open terminal: {}", e))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }

    Ok(())
}
