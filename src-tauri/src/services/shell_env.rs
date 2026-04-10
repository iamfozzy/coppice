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

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

        // Run a login interactive shell to get the PATH after sourcing profiles
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
pub fn user_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", get_user_path());

    // AppImage sets LD_LIBRARY_PATH to its bundled libs, which breaks child
    // processes like git that need the system's libcurl/libpcre2/etc.
    // Restore the original value (saved by AppImage as *_ORIG) or unset it.
    if cfg!(target_os = "linux") {
        match std::env::var("LD_LIBRARY_PATH_ORIG") {
            Ok(orig) => { cmd.env("LD_LIBRARY_PATH", orig); }
            Err(_) => { cmd.env_remove("LD_LIBRARY_PATH"); }
        }
    }

    cmd
}
