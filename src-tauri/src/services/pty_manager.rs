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

        let shell = std::env::var("SHELL").unwrap_or_else(|_| {
            if cfg!(target_os = "windows") {
                "cmd.exe".to_string()
            } else {
                "/bin/bash".to_string()
            }
        });

        let mut cmd = if let Some(command) = command {
            let mut cmd = CommandBuilder::new(&shell);
            cmd.arg("-l");
            cmd.arg("-c");
            cmd.arg(command);
            cmd
        } else {
            let mut cmd = CommandBuilder::new(&shell);
            cmd.arg("-l");
            cmd
        };
        cmd.cwd(cwd);

        // Inherit full environment, then set terminal-specific vars
        for (key, value) in std::env::vars() {
            cmd.env(key, value);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("LANG", "en_US.UTF-8");
        cmd.env("LC_ALL", "en_US.UTF-8");

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

        thread::spawn(move || {
            let mut buf = [0u8; 8192];
            // Buffer to hold incomplete UTF-8 sequences between reads
            let mut pending: Vec<u8> = Vec::new();

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // Flush any remaining bytes
                        if !pending.is_empty() {
                            let data = String::from_utf8_lossy(&pending).to_string();
                            let _ = app.emit(&event_name, &data);
                        }
                        let _ = app.emit(&format!("pty-exit-{}", sid), ());
                        sessions_ref.lock().unwrap().remove(&sid);
                        break;
                    }
                    Ok(n) => {
                        pending.extend_from_slice(&buf[..n]);

                        // Find the last valid UTF-8 boundary
                        let valid_up_to = match std::str::from_utf8(&pending) {
                            Ok(_) => pending.len(),
                            Err(e) => e.valid_up_to(),
                        };

                        if valid_up_to > 0 {
                            // Safety: we just verified this slice is valid UTF-8
                            let data = unsafe {
                                std::str::from_utf8_unchecked(&pending[..valid_up_to])
                            };
                            let _ = app.emit(&event_name, data);
                            pending.drain(..valid_up_to);
                        }

                        // If pending has grown large with invalid bytes, flush them
                        // to avoid unbounded memory growth
                        if pending.len() > 64 {
                            let data = String::from_utf8_lossy(&pending).to_string();
                            let _ = app.emit(&event_name, &data);
                            pending.clear();
                        }
                    }
                    Err(_) => {
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
