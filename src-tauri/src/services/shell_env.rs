use std::process::Command;
use std::sync::OnceLock;

static USER_PATH: OnceLock<String> = OnceLock::new();

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
