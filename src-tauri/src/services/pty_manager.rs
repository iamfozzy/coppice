use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};

// Flush cadence for the PTY-output background thread.
// Hidden terminals pay almost no compositor cost when their xterm is
// suspended, but the buffer still needs to drain often enough that
// switching back to the tab feels instant — 250 ms is well under the
// perceptual threshold for "terminal looks live again".
const FLUSH_INTERVAL_VISIBLE_MS: u64 = 50;
const FLUSH_INTERVAL_HIDDEN_MS: u64 = 250;

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    _master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
}

pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    // Flush interval (ms) shared with each session's flush thread. Frontend
    // toggles via `set_visible` based on IntersectionObserver state.
    flush_intervals: Arc<Mutex<HashMap<String, Arc<AtomicU64>>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            flush_intervals: Arc::new(Mutex::new(HashMap::new())),
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
        compact_prompt: bool,
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
        let use_compact_prompt = compact_prompt && command.is_none();

        // Tracks whether the shell hosting the deferred-type command uses
        // cmd.exe syntax (`&` as statement separator) vs PowerShell syntax
        // (`;`). Only consulted when `defer_type_command` is true.
        #[cfg(target_os = "windows")]
        let mut defer_shell_is_cmd = false;

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
                let is_cmd = custom.to_lowercase().ends_with("cmd.exe");
                #[cfg(target_os = "windows")]
                {
                    defer_shell_is_cmd = is_cmd;
                }
                let mut cmd = CommandBuilder::new(custom);
                if let Some(command) = command {
                    if !defer_type_command {
                        // Best-effort: most Windows shells accept `-c <cmd>`.
                        // cmd.exe wants `/c` — if the override path looks like
                        // cmd.exe, use that flag.
                        if is_cmd {
                            cmd.args(["/c", command]);
                        } else {
                            cmd.args(["-c", command]);
                        }
                    }
                } else if use_compact_prompt {
                    configure_windows_interactive_prompt(&mut cmd, custom, is_cmd);
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
                    if use_compact_prompt {
                        cmd.args(["-NoExit", "-Command", COPPICE_POWERSHELL_PROMPT]);
                    }
                    cmd
                } else if let Some(ps) = powershell_exe {
                    let mut cmd = CommandBuilder::new(ps);
                    cmd.arg("-NoLogo");
                    if use_compact_prompt {
                        cmd.args(["-NoExit", "-Command", COPPICE_POWERSHELL_PROMPT]);
                    }
                    cmd
                } else {
                    #[cfg(target_os = "windows")]
                    {
                        defer_shell_is_cmd = true;
                    }
                    let mut cmd = CommandBuilder::new(&cmd_exe);
                    if use_compact_prompt {
                        cmd.env("PROMPT", "$P$_$G ");
                    }
                    cmd
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
                if !use_compact_prompt || !configure_unix_interactive_prompt(&mut cmd, &shell, app_handle) {
                    cmd.arg("-l");
                    if use_compact_prompt {
                        cmd.env("PROMPT_DIRTRIM", "2");
                    }
                }
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
        let flush_intervals_ref = self.flush_intervals.clone();

        // Shared buffer between reader thread and flush thread
        let shared_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let shared_buf_reader = shared_buf.clone();
        let shared_buf_flusher = shared_buf.clone();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_reader = done.clone();
        let done_flusher = done.clone();

        // Timestamp of the reader thread's most recent successful read.
        // Used by the Windows deferred-type path to detect "prompt ready"
        // (see the defer_type_command block below).
        let last_output: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let last_output_reader = last_output.clone();

        let event_name_flush = event_name.clone();
        let app_flush = app.clone();

        // Per-session flush interval — driven by frontend visibility events.
        // Default to the "visible" cadence so the first paint after spawn is
        // snappy; the IntersectionObserver in TerminalPanel will throttle us
        // down within the first frame if the terminal is parked off-screen.
        let flush_interval = Arc::new(AtomicU64::new(FLUSH_INTERVAL_VISIBLE_MS));
        self.flush_intervals
            .lock()
            .unwrap()
            .insert(session_id.to_string(), flush_interval.clone());
        let flush_interval_thread = flush_interval.clone();

        // Flush thread — emits buffered data on a cadence that depends on
        // whether the frontend reports the terminal as visible (50 ms) or
        // suspended (250 ms).
        thread::spawn(move || {
            while !done_flusher.load(std::sync::atomic::Ordering::Relaxed) {
                let interval_ms = flush_interval_thread.load(Ordering::Relaxed);
                thread::sleep(std::time::Duration::from_millis(interval_ms));

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
                        flush_intervals_ref.lock().unwrap().remove(&sid);
                        break;
                    }
                    Ok(n) => {
                        let mut buf = shared_buf_reader.lock().unwrap();
                        buf.extend_from_slice(&read_buf[..n]);
                        // Cap buffer at 4 MB to prevent unbounded memory
                        // growth when PTY output arrives faster than the
                        // 50 ms flush cycle can drain it.  Drain to a
                        // UTF-8 code-point boundary so the flusher never
                        // sees orphaned continuation bytes at the start.
                        const MAX_BUF_SIZE: usize = 4 * 1024 * 1024;
                        if buf.len() > MAX_BUF_SIZE {
                            let mut drain_to = buf.len() - MAX_BUF_SIZE;
                            // Advance past any UTF-8 continuation bytes
                            // (0b10xxxxxx) so we land on a leading byte.
                            while drain_to < buf.len() && buf[drain_to] & 0xC0 == 0x80 {
                                drain_to += 1;
                            }
                            buf.drain(..drain_to);
                        }
                        drop(buf);
                        *last_output_reader.lock().unwrap() = Some(Instant::now());
                    }
                    Err(_) => {
                        done_reader.store(true, std::sync::atomic::Ordering::Relaxed);
                        thread::sleep(std::time::Duration::from_millis(100));
                        let _ = app.emit(&format!("pty-exit-{}", sid), ());
                        sessions_ref.lock().unwrap().remove(&sid);
                        flush_intervals_ref.lock().unwrap().remove(&sid);
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
        // rendered its prompt and is waiting for input.
        //
        // Rather than a fixed delay, wait for the "output then idle" signal:
        // the shell emits its banner + prompt, then goes quiet. When we've
        // seen output and no new bytes have arrived for ~120ms, the prompt
        // is drawn and PSReadLine / cmd is listening. Fast machines fire in
        // ~150–300ms; slow machines wait as long as they need. Capped by a
        // 3000ms safety net just in case the shell never goes fully idle.
        //
        // Prefix with `cls` so the briefly-visible shell prompt + typed
        // command line is cleared the instant the target process (e.g.
        // Claude) takes over the terminal. Without this, users saw
        // `PS C:\path> claude "Commit all the changes…"` stuck at the top
        // of the view when hitting "Commit & Push" or "Create PR".
        #[cfg(target_os = "windows")]
        if defer_type_command {
            if let Some(command_str) = command {
                let sessions = self.sessions.clone();
                let sid = session_id.to_string();
                let separator = if defer_shell_is_cmd { " & " } else { "; " };
                let bytes = format!("cls{}{}\r", separator, command_str).into_bytes();
                let last_output_defer = last_output.clone();
                thread::spawn(move || {
                    const IDLE_THRESHOLD: std::time::Duration =
                        std::time::Duration::from_millis(120);
                    const MAX_WAIT: std::time::Duration =
                        std::time::Duration::from_millis(3000);
                    const POLL_INTERVAL: std::time::Duration =
                        std::time::Duration::from_millis(25);

                    let start = Instant::now();
                    loop {
                        thread::sleep(POLL_INTERVAL);
                        let last = *last_output_defer.lock().unwrap();
                        if let Some(ts) = last {
                            if ts.elapsed() >= IDLE_THRESHOLD {
                                break;
                            }
                        }
                        if start.elapsed() >= MAX_WAIT {
                            break;
                        }
                    }
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
        self.flush_intervals.lock().unwrap().remove(session_id);
        Ok(())
    }

    /// Toggle the PTY-flush cadence for a session. Visible terminals flush at
    /// 50 ms (snappy paints); hidden terminals flush at 250 ms so the reader
    /// thread isn't waking the event loop and WindowServer 20×/sec for an
    /// invisible xterm. No-op if the session doesn't exist (e.g. flush thread
    /// already exited).
    pub fn set_visible(&self, session_id: &str, visible: bool) {
        if let Some(interval) = self.flush_intervals.lock().unwrap().get(session_id) {
            let ms = if visible {
                FLUSH_INTERVAL_VISIBLE_MS
            } else {
                FLUSH_INTERVAL_HIDDEN_MS
            };
            interval.store(ms, Ordering::Relaxed);
        }
    }

    /// Kill all PTY sessions — called on app exit.
    pub fn close_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
        self.flush_intervals.lock().unwrap().clear();
    }
}

const COPPICE_POWERSHELL_PROMPT: &str = r#"function global:prompt {
  $path = $executionContext.SessionState.Path.CurrentLocation.Path
  $leaf = Split-Path -Leaf $path
  if ([string]::IsNullOrWhiteSpace($leaf)) { $leaf = $path }
  "PS $leaf`n> "
}"#;

fn configure_windows_interactive_prompt(cmd: &mut CommandBuilder, shell: &str, is_cmd: bool) {
    let name = shell_basename(shell);
    if name == "pwsh" || name == "powershell" {
        cmd.arg("-NoLogo");
        cmd.args(["-NoExit", "-Command", COPPICE_POWERSHELL_PROMPT]);
    } else if is_cmd || name == "cmd" {
        // Keep the full path available, but put it on its own line so the
        // editable command line starts at a short `>` prompt.
        cmd.env("PROMPT", "$P$_$G ");
    }
}

fn configure_unix_interactive_prompt(cmd: &mut CommandBuilder, shell: &str, app_handle: &AppHandle) -> bool {
    match shell_basename(shell).as_str() {
        "bash" => match write_bash_prompt_file(app_handle) {
            Ok(path) => {
                let path = path.to_string_lossy().to_string();
                cmd.args(["--rcfile", path.as_str(), "-i"]);
                true
            }
            Err(_) => false,
        },
        "zsh" => match write_zsh_prompt_files(app_handle) {
            Ok(dir) => {
                let home = std::env::var("HOME").unwrap_or_else(|_| String::from(""));
                let orig_zdotdir = std::env::var("ZDOTDIR").unwrap_or(home);
                let dir = dir.to_string_lossy().to_string();
                cmd.arg("-l");
                cmd.env("COPPICE_ZDOTDIR", &dir);
                cmd.env("COPPICE_ORIG_ZDOTDIR", orig_zdotdir);
                cmd.env("ZDOTDIR", dir);
                true
            }
            Err(_) => false,
        },
        _ => false,
    }
}

fn prompt_cache_dir(app_handle: &AppHandle, shell: &str) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {e}"))?
        .join("shell-prompt")
        .join(shell);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create shell prompt dir: {e}"))?;
    Ok(dir)
}

fn write_bash_prompt_file(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = prompt_cache_dir(app_handle, "bash")?;
    let path = dir.join("coppice-bashrc");
    fs::write(&path, BASH_PROMPT_RC)
        .map_err(|e| format!("Failed to write bash prompt file: {e}"))?;
    Ok(path)
}

fn write_zsh_prompt_files(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = prompt_cache_dir(app_handle, "zsh")?;
    fs::write(dir.join(".zshenv"), ZSHENV_PROMPT_RC)
        .map_err(|e| format!("Failed to write zshenv prompt file: {e}"))?;
    fs::write(dir.join(".zprofile"), "__coppice_source_orig .zprofile\n")
        .map_err(|e| format!("Failed to write zprofile prompt file: {e}"))?;
    fs::write(dir.join(".zshrc"), "__coppice_source_orig .zshrc\n__coppice_compact_prompt\n")
        .map_err(|e| format!("Failed to write zshrc prompt file: {e}"))?;
    fs::write(dir.join(".zlogin"), "__coppice_source_orig .zlogin\n__coppice_compact_prompt\n")
        .map_err(|e| format!("Failed to write zlogin prompt file: {e}"))?;
    Ok(dir)
}

fn shell_basename(shell: &str) -> String {
    Path::new(shell)
        .file_stem()
        .or_else(|| Path::new(shell).file_name())
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| shell.to_ascii_lowercase())
}

const BASH_PROMPT_RC: &str = r#"# Generated by Coppice for compact in-app terminal prompts.
if [ -r /etc/profile ]; then . /etc/profile; fi
__coppice_profile_sourced=0
for __coppice_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -r "$__coppice_profile" ]; then
    . "$__coppice_profile"
    __coppice_profile_sourced=1
    break
  fi
done
if [ "$__coppice_profile_sourced" = 0 ] && [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
unset __coppice_profile __coppice_profile_sourced
export PROMPT_DIRTRIM=2
PS1='\[\033[34m\]\w\[\033[0m\]\n\$ '
"#;

const ZSHENV_PROMPT_RC: &str = r#"# Generated by Coppice for compact in-app terminal prompts.
function __coppice_source_orig() {
  local __coppice_file="$COPPICE_ORIG_ZDOTDIR/$1"
  [[ -r "$__coppice_file" ]] || return 0
  local __coppice_old_zdotdir="$ZDOTDIR"
  export ZDOTDIR="$COPPICE_ORIG_ZDOTDIR"
  source "$__coppice_file"
  export ZDOTDIR="$__coppice_old_zdotdir"
}

function __coppice_vcs_info() { vcs_info }

function __coppice_compact_prompt() {
  autoload -Uz vcs_info
  zstyle ':vcs_info:*' enable git
  zstyle ':vcs_info:git:*' formats ' %F{magenta}(%b)%f'
  typeset -ga precmd_functions
  if [[ ${precmd_functions[(Ie)__coppice_vcs_info]} -eq 0 ]]; then
    precmd_functions+=(__coppice_vcs_info)
  fi
  setopt prompt_subst
  PROMPT=$'%F{blue}%2~%f${vcs_info_msg_0_}\n%# '
}

if [[ -n "$COPPICE_ORIG_ZDOTDIR" && -r "$COPPICE_ORIG_ZDOTDIR/.zshenv" ]]; then
  __coppice_source_orig .zshenv
fi
export ZDOTDIR="$COPPICE_ZDOTDIR"
"#;

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
