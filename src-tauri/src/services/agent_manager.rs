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

    /// Spawn a new agent bridge process for the given session.
    ///
    /// `bridge_path` is the absolute path to `bridge.mjs`.
    /// `start_msg` is the full JSON start command to write to stdin.
    pub fn spawn(
        &self,
        session_id: &str,
        bridge_path: &str,
        start_msg: &str,
        api_key: Option<&str>,
        app_handle: &AppHandle,
    ) -> Result<(), String> {
        // Resolve node binary — use user_command for correct PATH + platform flags
        let mut cmd = crate::services::shell_env::user_command("node");
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

        // Stderr reader thread — log to eprintln
        let sid_err = session_id.to_string();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(text) => {
                        eprintln!("[agent:{}] {}", sid_err, text);
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
            // Give it a moment then kill
            let _ = session.child.kill();
            let _ = session.child.wait();
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
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}
