use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn spawn(
        &self,
        session_id: &str,
        cwd: &str,
        command: Option<&str>,
        rows: u16,
        cols: u16,
        app_handle: &AppHandle,
        shell_override: Option<&str>,
    ) -> Result<(), String> {
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows: if rows > 0 { rows } else { 24 },
                cols: if cols > 0 { cols } else { 80 },
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to open PTY: {}", e))?;

        // Commands containing double quotes can't be safely passed as a
        // shell argument on Windows — many common CLIs ship as `.cmd` shims
        // (e.g. npm-installed `claude.cmd`), and cmd.exe mangles quoted
        // arguments when invoking them, so `claude "Commit all the changes…"`
        // reaches Claude as just the word "Commit". Fall back to spawning an
        // interactive shell and typing the command into it after the prompt
        // appears — the shell then parses the line with its own rules, which
        // handle quotes correctly. See `windows_deferred_type_command` below.
        let defer_type_command = cfg!(target_os = "windows")
            && command.map(|c| c.contains('"')).unwrap_or(false);

        let mut cmd = if cfg!(target_os = "windows") {
            // Windows shell resolution:
            //   - cmd.exe: fall back to COMSPEC, else resolve via System32 so we
            //     don't rely on PATH containing System32 (containers/minimal
            //     envs may not).
            //   - pwsh (PowerShell 7+/Core): preferred for interactive shells.
            //   - powershell.exe (Windows PowerShell 5.1): available as an
            //     interactive fallback, but NOT used to run piped commands —
            //     it does not support the `&&` operator (PS 7+ only), so
            //     compound commands like `npm i && npm test` would fail.
            let cmd_exe = resolve_cmd_exe();
            let pwsh_exe = if which_exists("pwsh") {
                Some("pwsh".to_string())
            } else if which_exists("pwsh.exe") {
                Some("pwsh.exe".to_string())
            } else {
                None
            };
            let powershell_exe = if which_exists("powershell.exe") {
                Some("powershell.exe".to_string())
            } else if which_exists("powershell") {
                Some("powershell".to_string())
            } else {
                None
            };

            // User-configured shell override wins on all platforms.
            if let Some(custom) = shell_override {
                let mut cmd = CommandBuilder::new(custom);
                if let Some(command) = command {
                    if !defer_type_command {
                        // Best-effort: most Windows shells accept `-c <cmd>`.
                        // cmd.exe wants `/c` — if the override path looks like
                        // cmd.exe, use that flag.
                        if custom.to_lowercase().ends_with("cmd.exe") {
                            cmd.args(["/c", command]);
                        } else {
                            cmd.args(["-c", command]);
                        }
                    }
                }
                cmd
            } else if let Some(command) = command.filter(|_| !defer_type_command) {
                // Command execution: prefer pwsh (handles &&), else fall back
                // to cmd.exe (also handles &&). Skip powershell.exe to avoid
                // the `&&` incompatibility.
                if let Some(ps) = pwsh_exe {
                    let mut cmd = CommandBuilder::new(ps);
                    cmd.args(["-NoLogo", "-Command", command]);
                    cmd
                } else {
                    let mut cmd = CommandBuilder::new(&cmd_exe);
                    cmd.args(["/c", command]);
                    cmd
                }
            } else {
                // Interactive shell: pwsh > powershell.exe > cmd.exe.
                // Used both for plain interactive sessions and for the deferred
                // "type the command in" path for quoted commands.
                if let Some(ps) = pwsh_exe {
                    let mut cmd = CommandBuilder::new(ps);
                    cmd.arg("-NoLogo");
                    cmd
                } else if let Some(ps) = powershell_exe {
                    let mut cmd = CommandBuilder::new(ps);
                    cmd.arg("-NoLogo");
                    cmd
                } else {
                    CommandBuilder::new(&cmd_exe)
                }
            }
        } else {
            // macOS + Linux: use the user's preferred shell ($SHELL), falling
            // back to /bin/bash which is available on both platforms.
            let shell = shell_override
                .map(|s| s.to_string())
                .unwrap_or_else(|| std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()));

            if let Some(command) = command {
                let mut cmd = CommandBuilder::new(&shell);
                cmd.arg("-li");
                cmd.arg("-c");
                cmd.arg(command);
                cmd
            } else {
                let mut cmd = CommandBuilder::new(&shell);
                cmd.arg("-l");
                cmd
            }
        };
        cmd.cwd(cwd);

        if cfg!(target_os = "windows") {
            // Windows: inherit full environment — PowerShell/cmd already
            // have the correct PATH from the system environment.
            for (key, value) in std::env::vars() {
                cmd.env(key, value);
            }
            cmd.env("TERM", "xterm-256color");
        } else {
            // macOS/Linux: Do NOT inherit the app's PATH — .app bundles and
            // some Linux launchers start with a minimal PATH. The login shell
            // (-l flag) will source ~/.zshrc / ~/.bash_profile to get the
            // correct PATH with Homebrew, nvm, yarn, etc.
            cmd.env("TERM", "xterm-256color");
            cmd.env("COLORTERM", "truecolor");
            cmd.env("LANG", "en_US.UTF-8");
            cmd.env("LC_ALL", "en_US.UTF-8");
            if let Ok(home) = std::env::var("HOME") {
                cmd.env("HOME", home);
            }
            if let Ok(user) = std::env::var("USER") {
                cmd.env("USER", user);
            }
            if let Ok(logname) = std::env::var("LOGNAME") {
                cmd.env("LOGNAME", logname);
            }

            // On Linux, strip AppImage-injected env vars so shells and the
            // tools spawned from them (git, eza, …) use the system's libraries
            // and GTK/GIO config instead of the bundled ones. Without this,
            // every git call inside the terminal logs "libpcre2-8.so.0: no
            // version information available" because it picks up the
            // AppImage's libpcre2 via LD_LIBRARY_PATH.
            #[cfg(target_os = "linux")]
            for var in [
                "LD_LIBRARY_PATH",
                "APPDIR",
                "APPIMAGE",
                "GTK_DATA_PREFIX",
                "GTK_THEME",
                "GTK_EXE_PREFIX",
                "GTK_PATH",
                "GTK_IM_MODULE_FILE",
                "GDK_BACKEND",
                "GDK_PIXBUF_MODULE_FILE",
                "GIO_EXTRA_MODULES",
                "GSETTINGS_SCHEMA_DIR",
            ] {
                cmd.env_remove(var);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn: {}", e))?;

        drop(pair.slave);

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to get writer: {}", e))?;

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to get reader: {}", e))?;

        let event_name = format!("pty-output-{}", session_id);
        let app = app_handle.clone();
        let sid = session_id.to_string();
        let sessions_ref = self.sessions.clone();

        // Shared buffer between reader thread and flush thread
        let shared_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let shared_buf_reader = shared_buf.clone();
        let shared_buf_flusher = shared_buf.clone();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_reader = done.clone();
        let done_flusher = done.clone();

        let event_name_flush = event_name.clone();
        let app_flush = app.clone();

        // Flush thread — emits buffered data every 50ms
        thread::spawn(move || {
            while !done_flusher.load(std::sync::atomic::Ordering::Relaxed) {
                thread::sleep(std::time::Duration::from_millis(50));

                let mut buf = shared_buf_flusher.lock().unwrap();
                if buf.is_empty() { continue; }

                let valid_up_to = match std::str::from_utf8(&buf) {
                    Ok(_) => buf.len(),
                    Err(e) => e.valid_up_to(),
                };

                if valid_up_to > 0 {
                    // Safe: valid_up_to is the longest prefix of valid UTF-8
                    // (either the full buffer or the boundary returned by
                    // Utf8Error::valid_up_to()). String::from_utf8_lossy on a
                    // valid prefix is a zero-copy borrow.
                    let data = String::from_utf8_lossy(&buf[..valid_up_to]).to_string();
                    let _ = app_flush.emit(&event_name_flush, &data);
                    buf.drain(..valid_up_to);
                }

                if buf.len() > 64 {
                    let data = String::from_utf8_lossy(&buf).to_string();
                    let _ = app_flush.emit(&event_name_flush, &data);
                    buf.clear();
                }
            }

            // Final flush
            let mut buf = shared_buf_flusher.lock().unwrap();
            if !buf.is_empty() {
                let data = String::from_utf8_lossy(&buf).to_string();
                let _ = app_flush.emit(&event_name_flush, &data);
                buf.clear();
            }
        });

        // Reader thread — reads from PTY and appends to shared buffer
        thread::spawn(move || {
            let mut read_buf = [0u8; 16384];

            loop {
                match reader.read(&mut read_buf) {
                    Ok(0) => {
                        done_reader.store(true, std::sync::atomic::Ordering::Relaxed);
                        // Wait a bit for flusher to drain
                        thread::sleep(std::time::Duration::from_millis(100));
                        let _ = app.emit(&format!("pty-exit-{}", sid), ());
                        sessions_ref.lock().unwrap().remove(&sid);
                        break;
                    }
                    Ok(n) => {
                        let mut buf = shared_buf_reader.lock().unwrap();
                        buf.extend_from_slice(&read_buf[..n]);
                    }
                    Err(_) => {
                        done_reader.store(true, std::sync::atomic::Ordering::Relaxed);
                        thread::sleep(std::time::Duration::from_millis(100));
                        let _ = app.emit(&format!("pty-exit-{}", sid), ());
                        sessions_ref.lock().unwrap().remove(&sid);
                        break;
                    }
                }
            }
        });

        let session = PtySession {
            writer,
            _master: pair.master,
            child,
        };

        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), session);

        // Windows deferred-type-command: when the requested command contains
        // double quotes, we spawned an interactive shell above instead of
        // passing the command as a shell arg (to dodge cmd.exe's .cmd-shim
        // quote mangling). Type the command into the PTY once the shell has
        // had time to render its prompt. 800ms covers pwsh cold start on
        // slower machines while still feeling responsive.
        #[cfg(target_os = "windows")]
        if defer_type_command {
            if let Some(command_str) = command {
                let sessions = self.sessions.clone();
                let sid = session_id.to_string();
                let bytes = format!("{}\r", command_str).into_bytes();
                thread::spawn(move || {
                    thread::sleep(std::time::Duration::from_millis(800));
                    if let Some(session) = sessions.lock().unwrap().get_mut(&sid) {
                        let _ = session.writer.write_all(&bytes);
                        let _ = session.writer.flush();
                    }
                });
            }
        }

        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        session
            .writer
            .write_all(data)
            .map_err(|e| format!("Write failed: {}", e))?;
        session
            .writer
            .flush()
            .map_err(|e| format!("Flush failed: {}", e))?;
        Ok(())
    }

    pub fn resize(&self, session_id: &str, rows: u16, cols: u16) -> Result<(), String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "Session not found".to_string())?;
        session
            ._master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Resize failed: {}", e))?;
        Ok(())
    }

    pub fn exists(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(session_id) {
            // Kill the child process and its entire process group
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        Ok(())
    }
}

/// Resolve cmd.exe to an absolute path, preferring %COMSPEC%, falling back to
/// %SystemRoot%\System32\cmd.exe, and finally the bare "cmd.exe" name.
#[cfg(target_os = "windows")]
fn resolve_cmd_exe() -> String {
    if let Ok(p) = std::env::var("COMSPEC") {
        if !p.is_empty() {
            return p;
        }
    }
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let abs = format!("{}\\System32\\cmd.exe", sysroot);
    if std::path::Path::new(&abs).exists() {
        return abs;
    }
    "cmd.exe".to_string()
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
fn resolve_cmd_exe() -> String {
    "cmd.exe".to_string()
}

/// Check if an executable exists on the system PATH.
fn which_exists(name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        crate::services::shell_env::user_command("where")
            .arg(name)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        crate::services::shell_env::user_command("which")
            .arg(name)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}
