//! Machine-bound encrypted secret store for MCP OAuth tokens.
//!
//! Why not the OS keychain? Keychain prompts are intrusive (especially
//! macOS dev builds where each rebuild has a different binary path and
//! triggers a fresh "allow access" prompt). Headless Linux without a
//! session keychain also fails outright.
//!
//! Trade-off: this store is encrypted-at-rest with a key derived from the
//! machine's stable ID, so the file alone is useless if copied to another
//! box. But any process running as the same user can read it. That's the
//! same threat model Chrome/Discord/Spotify accept for desktop credential
//! storage and is acceptable for user-scoped MCP tokens.
//!
//! Layout: a single JSON file at `<data_dir>/coppice/mcp-secrets.enc`
//! containing one nonce + AES-256-GCM ciphertext blob over a
//! `HashMap<String, String>` of all stored entries. Read-modify-write on
//! every change — protected by a process-wide `Mutex`.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

const FILE_NAME: &str = "mcp-secrets.enc";
const APP_SALT: &[u8] = b"coppice-mcp/v1/secrets";
const NONCE_LEN: usize = 12;
const KEY_INFO: &[u8] = b"mcp-tokens-aes256-gcm";

/// Process-wide mutex guarding the file. Trivial contention since writes
/// are infrequent and small.
fn store_lock() -> &'static Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn store_path() -> PathBuf {
    let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("coppice");
    path.push(FILE_NAME);
    path
}

#[derive(Debug, Serialize, Deserialize)]
struct OnDisk {
    version: u32,
    /// base64(nonce ‖ ciphertext)
    data: String,
}

// ─── Key derivation ────────────────────────────────────────────────────────

/// Derive a 32-byte AES key from the machine's stable identifier. Falls back
/// to a static salt if the machine ID can't be read — that degrades the
/// security to "obscured" but keeps things working.
fn derive_key() -> [u8; 32] {
    let machine_id = read_machine_id().unwrap_or_else(|| "coppice-fallback-machine".to_string());
    let hk = Hkdf::<Sha256>::new(Some(APP_SALT), machine_id.as_bytes());
    let mut key = [0u8; 32];
    hk.expand(KEY_INFO, &mut key)
        .expect("HKDF expand of 32 bytes");
    key
}

fn read_machine_id() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(s) = std::fs::read_to_string("/etc/machine-id") {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
        if let Ok(s) = std::fs::read_to_string("/var/lib/dbus/machine-id") {
            let t = s.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        // IOPlatformUUID is stable across reboots and OS upgrades; only
        // changes on hardware/logic-board replacement. `ioreg` is in /usr/sbin
        // on every macOS install — no network, no entitlement needed.
        let out = std::process::Command::new("ioreg")
            .args(["-rd1", "-c", "IOPlatformExpertDevice"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains("IOPlatformUUID") {
                // Line looks like:  "IOPlatformUUID" = "ABCD-…-1234"
                let mut parts = line.split('"');
                let _ = parts.next(); // before key
                let _ = parts.next(); // key
                let _ = parts.next(); // " = "
                if let Some(uuid) = parts.next() {
                    if !uuid.trim().is_empty() {
                        return Some(uuid.trim().to_string());
                    }
                }
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        // Read MachineGuid from the registry via `reg.exe` — avoids an
        // additional crate dependency and works on every Windows install.
        let out = std::process::Command::new("reg")
            .args([
                "query",
                r"HKLM\SOFTWARE\Microsoft\Cryptography",
                "/v",
                "MachineGuid",
            ])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        for line in text.lines() {
            if line.contains("MachineGuid") {
                if let Some(value) = line.split_whitespace().last() {
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
        None
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

// ─── Encrypt / decrypt ─────────────────────────────────────────────────────

fn encrypt(plain: &[u8]) -> Result<String, String> {
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain)
        .map_err(|e| format!("encrypt: {}", e))?;
    let mut combined = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    Ok(base64::engine::general_purpose::STANDARD.encode(combined))
}

fn decrypt(b64: &str) -> Result<Vec<u8>, String> {
    let combined = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("decode: {}", e))?;
    if combined.len() <= NONCE_LEN {
        return Err("ciphertext too short".to_string());
    }
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Nonce::from_slice(&combined[..NONCE_LEN]);
    cipher
        .decrypt(nonce, &combined[NONCE_LEN..])
        .map_err(|e| format!("decrypt: {}", e))
}

// ─── File I/O ──────────────────────────────────────────────────────────────

fn read_all() -> Result<HashMap<String, String>, String> {
    let path = store_path();
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(e) => return Err(format!("read store: {}", e)),
    };
    let on_disk: OnDisk = serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    if on_disk.version != 1 {
        return Err(format!("unknown secret store version: {}", on_disk.version));
    }
    if on_disk.data.is_empty() {
        return Ok(HashMap::new());
    }
    let plain = decrypt(&on_disk.data)?;
    let map: HashMap<String, String> = serde_json::from_slice(&plain)
        .map_err(|e| format!("parse decrypted: {}", e))?;
    Ok(map)
}

fn write_all(map: &HashMap<String, String>) -> Result<(), String> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let plain = serde_json::to_vec(map).map_err(|e| format!("serialize: {}", e))?;
    let encrypted = encrypt(&plain)?;
    let on_disk = OnDisk {
        version: 1,
        data: encrypted,
    };
    let json = serde_json::to_string(&on_disk).map_err(|e| format!("serialize: {}", e))?;

    // Atomic write: temp file → rename. Restrict the temp file's mode on
    // Unix so it never has a window of being world-readable.
    let tmp = path.with_extension("enc.tmp");
    {
        use std::io::Write;
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(&tmp)
                .map_err(|e| format!("open tmp: {}", e))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("write tmp: {}", e))?;
            f.sync_all().ok();
        }
        #[cfg(not(unix))]
        {
            let mut f = std::fs::File::create(&tmp).map_err(|e| format!("open tmp: {}", e))?;
            f.write_all(json.as_bytes())
                .map_err(|e| format!("write tmp: {}", e))?;
            f.sync_all().ok();
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

// ─── Public API ────────────────────────────────────────────────────────────

pub fn save(key: &str, value: &str) -> Result<(), String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut map = read_all().unwrap_or_default();
    map.insert(key.to_string(), value.to_string());
    write_all(&map)
}

pub fn load(key: &str) -> Result<Option<String>, String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let map = read_all()?;
    Ok(map.get(key).cloned())
}

pub fn delete(key: &str) -> Result<(), String> {
    let _g = store_lock().lock().map_err(|e| e.to_string())?;
    let mut map = match read_all() {
        Ok(m) => m,
        // If the file is corrupted (e.g. machine-id changed) just blow it
        // away — there's nothing useful in there anyway.
        Err(_) => HashMap::new(),
    };
    if map.remove(key).is_some() {
        write_all(&map)?;
    }
    Ok(())
}
