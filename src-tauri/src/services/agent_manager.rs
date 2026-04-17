use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};

pub struct AgentSession {
    stdin: ChildStdin,
    child: Child,
}

pub struct AgentManager {
    sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Start an agent query. If a bridge process already exists for this
    /// session, reuse it by sending a new start command. Otherwise spawn
    /// a fresh bridge process.
    ///
    /// `bridge_path` is the absolute path to `bridge.mjs`.
    /// `start_msg` is the full JSON start command to write to stdin.
    pub fn start(
        &self,
        session_id: &str,
        bridge_path: &str,
        start_msg: &str,
        api_key: Option<&str>,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        // Check if we already have a running bridge for this session
        {
            let mut sessions = self.sessions.lock().unwrap();
            if let Some(session) = sessions.get_mut(session_id) {
                // Reuse existing bridge process — send new start command
                let line = format!("{}\n", start_msg);
                session
                    .stdin
                    .write_all(line.as_bytes())
                    .map_err(|e| format!("Failed to write to agent: {}", e))?;
                session
                    .stdin
                    .flush()
                    .map_err(|e| format!("Failed to flush agent stdin: {}", e))?;
                return Ok(());
            }
        }

        // No existing bridge — spawn a new one
        self.spawn(session_id, bridge_path, start_msg, api_key, app_handle)
    }

    /// Spawn a new agent bridge process for the given session.
    fn spawn(
        &self,
        session_id: &str,
        bridge_path: &str,
        start_msg: &str,
        api_key: Option<&str>,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        // Resolve node to its real binary path (bypassing asdf/nvm/fnm shims),
        // then wrap via user_command so PATH + platform flags are correct for
        // any children node itself spawns (e.g. the bundled claude cli).
        let node_path = crate::services::shell_env::resolve_node_binary()
            .ok_or_else(|| {
                "Node.js not found. Install Node.js 18+ and ensure it is \
                 available in your login shell."
                    .to_string()
            })?;
        let mut cmd = crate::services::shell_env::user_command(node_path);
        cmd.arg(bridge_path);
        cmd.stdin(Stdio::piped());
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Pass API key via environment if provided
        if let Some(key) = api_key {
            cmd.env("ANTHROPIC_API_KEY", key);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn agent bridge: {}", e))?;

        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to get stdin for agent bridge".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to get stdout for agent bridge".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to get stderr for agent bridge".to_string())?;

        // Write the start command immediately
        let start_line = format!("{}\n", start_msg);
        stdin
            .write_all(start_line.as_bytes())
            .map_err(|e| format!("Failed to write start command: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush start command: {}", e))?;

        // Stdout reader thread — emits Tauri events for each JSON line
        let event_name = format!("agent-event-{}", session_id);
        let app = app_handle.clone();
        let sid = session_id.to_string();
        let sessions_ref = self.sessions.clone();

        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        if text.trim().is_empty() {
                            continue;
                        }
                        let _ = app.emit(&event_name, &text);
                    }
                    Err(_) => break,
                }
            }
            // Process ended — emit an exit event
            let _ = app.emit(
                &event_name,
                r#"{"type":"status","status":"exited"}"#,
            );
            sessions_ref.lock().unwrap().remove(&sid);
        });

        // Stderr reader thread — log to eprintln AND forward to the UI as a
        // bridge_stderr event. In packaged builds eprintln is invisible, so
        // without forwarding, a bridge that dies before emitting any stdout
        // (e.g. missing node_modules, import error) leaves the UI with no
        // feedback at all.
        let sid_err = session_id.to_string();
        let event_name_err = format!("agent-event-{}", session_id);
        let app_err = app_handle.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        eprintln!("[agent:{}] {}", sid_err, text);
                        let payload = serde_json::json!({
                            "type": "bridge_stderr",
                            "text": text,
                        });
                        let _ = app_err.emit(&event_name_err, payload.to_string());
                    }
                    Err(_) => break,
                }
            }
        });

        let session = AgentSession { stdin, child };
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), session);

        Ok(())
    }

    /// Send a JSON line to the agent bridge's stdin.
    pub fn send(&self, session_id: &str, json_line: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "Agent session not found".to_string())?;
        let line = format!("{}\n", json_line);
        session
            .stdin
            .write_all(line.as_bytes())
            .map_err(|e| format!("Failed to write to agent: {}", e))?;
        session
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush agent stdin: {}", e))?;
        Ok(())
    }

    /// Check if a session exists.
    pub fn exists(&self, session_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(session_id)
    }

    /// Close a specific session — send close command, then kill.
    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(mut session) = sessions.remove(session_id) {
            // Try to send close command gracefully
            let _ = session.stdin.write_all(b"{\"type\":\"close\"}\n");
            let _ = session.stdin.flush();
            // Kill the process tree. On Windows, child.kill() only terminates
            // the direct child (node), leaving any grandchildren (Claude SDK
            // sub-processes) orphaned. Use taskkill /T to kill the whole tree.
            kill_process_tree(&mut session.child);
        }
        Ok(())
    }

    /// Close all sessions — called on app exit.
    #[allow(dead_code)]
    pub fn close_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut session) in sessions.drain() {
            let _ = session.stdin.write_all(b"{\"type\":\"close\"}\n");
            let _ = session.stdin.flush();
            kill_process_tree(&mut session.child);
        }
    }
}

/// Kill a child process and its entire process tree.
fn kill_process_tree(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let pid = child.id();
        // taskkill /T kills the entire process tree, /F forces termination
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}
