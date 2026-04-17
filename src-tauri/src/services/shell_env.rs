use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

static USER_PATH: OnceLock<String> = OnceLock::new();
static NODE_BINARY: OnceLock<Option<String>> = OnceLock::new();

/// Resolve a Tauri `externalBin` sidecar that was bundled with the app.
///
/// Tauri places sidecars next to the main executable for every bundle format
/// we ship (macOS .app/Contents/MacOS, Windows install dir, Linux .deb/.AppImage
/// bin dir), so we locate them by asking for `current_exe()`'s neighbor. The
/// bundled names are prefixed with `coppice-` to avoid clashing with any
/// user-installed `node` / `gh` that might share the install dir on Linux.
///
/// Returns `None` in dev mode when the sidecar hasn't been downloaded yet, or
/// if the file is missing for any other reason — callers should fall back to
/// PATH-based lookup in that case.
pub fn sidecar_path(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let filename = if cfg!(windows) {
        format!("coppice-{name}.exe")
    } else {
        format!("coppice-{name}")
    };
    let candidate = dir.join(filename);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// Resolve a program to its bundled sidecar path if present, otherwise return
/// the bare name for PATH-based lookup. Use this at every `user_command` call
/// site for `node` and `gh` so packaged builds always use the bundled copy.
pub fn bin(name: &str) -> String {
    sidecar_path(name)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| name.to_string())
}

/// Get the user's full PATH by sourcing their login shell profile.
/// Falls back to the current process PATH if the shell query fails.
pub fn get_user_path() -> &'static str {
    USER_PATH.get_or_init(|| {
        if cfg!(target_os = "windows") {
            // Windows inherits the correct PATH from the system
            return std::env::var("PATH").unwrap_or_default();
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

        // Run a login interactive shell to get the PATH after sourcing profiles.
        // (Unix-only branch — Windows returned above.)
        let output = Command::new(&shell)
            .args(["-li", "-c", "echo $PATH"])
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return path;
                }
            }
            _ => {}
        }

        // Fallback
        std::env::var("PATH").unwrap_or_default()
    })
}

/// Create a Command that has the user's full PATH set and AppImage library
/// path pollution removed so child processes use system libraries.
///
/// On Windows, this also suppresses the console window that would otherwise
/// flash up for each child process. Coppice is a GUI app with no attached
/// console, so Windows allocates a fresh conhost window per spawn by default —
/// visible as a blink for every `git status`, `gh pr list`, etc. Setting
/// `CREATE_NO_WINDOW` keeps these background calls invisible. Commands that
/// *do* want a visible window (editor/terminal launchers) go through
/// `commands::external`, not this helper.
pub fn user_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", get_user_path());

    // AppImage prepends its bundled libs to LD_LIBRARY_PATH so Coppice itself
    // can find them, but that leaks into child processes — git/gh then pick up
    // the bundled libpcre2/libcurl/etc. and log "no version information
    // available" (or worse, hit ABI incompatibilities). Drop the var entirely
    // so children resolve via the system's default linker search path.
    #[cfg(target_os = "linux")]
    cmd.env_remove("LD_LIBRARY_PATH");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd
}

/// Resolve the absolute path of the `node` binary to use for the agent bridge.
///
/// Prefers the sidecar bundled via Tauri's `externalBin` — packaged builds
/// always have a known-good Node version adjacent to the main executable, so
/// the user no longer needs Node installed at all.
///
/// Falls back to a login-shell lookup for dev mode (before the sidecar has
/// been downloaded) and broken packaged installs. The fallback sidesteps
/// version-manager shims (asdf/nvm/fnm/volta) by asking node for its own
/// `process.execPath` — a shim would otherwise bail out inside a .app bundle
/// where cwd is `/` and launchd has not propagated the shell env.
///
/// Returns `None` only when there is no sidecar AND no resolvable system node.
pub fn resolve_node_binary() -> Option<&'static str> {
    NODE_BINARY
        .get_or_init(|| {
            if let Some(p) = sidecar_path("node") {
                return Some(p.to_string_lossy().to_string());
            }

            if cfg!(target_os = "windows") {
                return Some("node".to_string());
            }

            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

            let output = Command::new(&shell)
                .args([
                    "-lic",
                    "node -e 'process.stdout.write(process.execPath)'",
                ])
                .output()
                .ok()?;

            if !output.status.success() {
                return None;
            }

            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if path.is_empty() || !std::path::Path::new(&path).exists() {
                return None;
            }
            Some(path)
        })
        .as_deref()
}
