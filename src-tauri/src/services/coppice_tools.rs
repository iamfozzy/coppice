//! Coppice IDE tool handlers.
//!
//! These are invoked by the agent bridge when Claude calls a `coppice_*` MCP
//! tool. Each handler receives the tool arguments as JSON, performs the action,
//! and returns a result string that flows back to the SDK.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::Database;
use crate::services::shell_env::user_command;

/// Dispatch a Coppice tool call to the appropriate handler.
pub fn handle_coppice_tool(
    tool_name: &str,
    args: &Value,
    app: &AppHandle,
    cwd: &str,
) -> Result<String, String> {
    match tool_name {
        "create_worktree" => handle_create_worktree(args, app, cwd),
        "list_worktrees" => handle_list_worktrees(app, cwd),
        "spawn_terminal" => handle_spawn_terminal(args, app, cwd),
        "open_file" => handle_open_file(args, app, cwd),
        "open_scratchpad" => handle_open_scratchpad(args, app),
        "open_url" => handle_open_url(args, app),
        _ => Err(format!("Unknown coppice tool: {}", tool_name)),
    }
}

// ── Helpers ──

/// Find the project that owns the given cwd. The cwd may be the project root
/// or any worktree path belonging to it.
fn find_project_for_cwd(
    db: &Database,
    cwd: &str,
) -> Result<(crate::models::Project, String), String> {
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    let cwd_path = std::path::Path::new(cwd);

    for project in &projects {
        // Direct match on project root
        if std::path::Path::new(&project.local_path) == cwd_path {
            return Ok((project.clone(), project.id.clone()));
        }
        // Check worktree paths
        let worktrees = db.list_worktrees(&project.id).map_err(|e| e.to_string())?;
        for wt in &worktrees {
            if std::path::Path::new(&wt.path) == cwd_path {
                return Ok((project.clone(), project.id.clone()));
            }
        }
    }

    // Fallback: check if cwd is a subdirectory of any project/worktree path
    for project in &projects {
        if cwd_path.starts_with(&project.local_path) {
            return Ok((project.clone(), project.id.clone()));
        }
        let worktrees = db.list_worktrees(&project.id).map_err(|e| e.to_string())?;
        for wt in &worktrees {
            if cwd_path.starts_with(&wt.path) {
                return Ok((project.clone(), project.id.clone()));
            }
        }
    }

    Err("Could not find a Coppice project for the current working directory".to_string())
}

/// Find the worktree ID that best matches the given cwd.
/// Checks exact worktree path matches first, then subdirectory matches.
fn find_worktree_id_for_cwd(db: &Database, cwd: &str) -> Option<String> {
    let cwd_path = std::path::Path::new(cwd);
    let projects = db.list_projects().ok()?;

    // Pass 1: exact match on worktree paths
    for project in &projects {
        if let Ok(worktrees) = db.list_worktrees(&project.id) {
            for wt in &worktrees {
                if std::path::Path::new(&wt.path) == cwd_path {
                    return Some(wt.id.clone());
                }
            }
        }
    }

    // Pass 2: cwd is a subdirectory of a worktree — pick the longest (most specific) match
    let mut best: Option<(usize, String)> = None;
    for project in &projects {
        if let Ok(worktrees) = db.list_worktrees(&project.id) {
            for wt in &worktrees {
                if cwd_path.starts_with(&wt.path) {
                    let len = wt.path.len();
                    if best.as_ref().map_or(true, |(bl, _)| len > *bl) {
                        best = Some((len, wt.id.clone()));
                    }
                }
            }
        }
    }

    best.map(|(_, id)| id)
}

/// Build the worktree filesystem path from project + name.
fn build_worktree_path(project: &crate::models::Project, name: &str) -> String {
    let base = std::path::Path::new(&project.local_path);
    let parent = base.parent().unwrap_or(base);
    let repo_name = base
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    parent
        .join(format!("{}-worktrees", repo_name))
        .join(name)
        .to_string_lossy()
        .to_string()
}

/// Copy env files from the project root to a new worktree.
fn post_create_setup(app: &AppHandle, project: &crate::models::Project, worktree_path: &str) {
    let total = project.env_files.len();
    for (i, env_file) in project.env_files.iter().enumerate() {
        let _ = app.emit(
            "worktree-setup-progress",
            serde_json::json!({
                "step": i + 1,
                "total": total,
                "file": env_file,
            }),
        );
        let src = std::path::Path::new(&project.local_path).join(env_file);
        let dst = std::path::Path::new(worktree_path).join(env_file);
        if src.is_dir() {
            copy_dir_recursive(&src, &dst).ok();
        } else if src.exists() {
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::copy(&src, &dst).ok();
        }
    }
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

// ── Tool handlers ──

fn handle_create_worktree(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let (project, project_id) = find_project_for_cwd(&db, cwd)?;

    let branch = args.get("branch").and_then(|v| v.as_str()).unwrap_or("");
    let new_branch = args.get("new_branch").and_then(|v| v.as_str()).unwrap_or("");
    let base_branch = args.get("base_branch").and_then(|v| v.as_str()).unwrap_or("main");

    if branch.is_empty() && new_branch.is_empty() {
        return Err("Either 'branch' (existing) or 'new_branch' must be provided".to_string());
    }

    let effective_branch = if !new_branch.is_empty() { new_branch } else { branch };

    // Derive folder name from branch — replace / with -
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| effective_branch.replace('/', "-"));

    let worktree_path = build_worktree_path(&project, &name);

    // Prune stale worktree references
    let _ = user_command("git")
        .args(["worktree", "prune"])
        .current_dir(&project.local_path)
        .output();

    if !new_branch.is_empty() {
        // Create a new branch based on base_branch
        let output = user_command("git")
            .args([
                "worktree",
                "add",
                "-b",
                new_branch,
                &worktree_path,
                base_branch,
            ])
            .current_dir(&project.local_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {}", stderr));
        }
    } else {
        // Checkout an existing branch — use --detach to avoid "already checked out" errors
        let output = user_command("git")
            .args(["worktree", "add", "--detach", &worktree_path])
            .current_dir(&project.local_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git worktree add failed: {}", stderr));
        }

        let checkout = user_command("git")
            .args(["checkout", branch])
            .current_dir(&worktree_path)
            .output()
            .map_err(|e| format!("Failed to checkout: {}", e))?;

        if !checkout.status.success() {
            let stderr = String::from_utf8_lossy(&checkout.stderr);
            let _ = user_command("git")
                .args(["worktree", "remove", "--force", &worktree_path])
                .current_dir(&project.local_path)
                .output();
            return Err(format!("git checkout failed: {}", stderr));
        }
    }

    post_create_setup(app, &project, &worktree_path);

    let worktree = db
        .create_worktree(&project_id, &name, &worktree_path, effective_branch, "branch")
        .map_err(|e| e.to_string())?;

    let prompt = args.get("prompt").and_then(|v| v.as_str());

    // Tell the frontend to refresh, switch to the new worktree, and
    // optionally spawn an agent tab with the user's task.
    let _ = app.emit(
        "coppice-action",
        serde_json::json!({
            "action": "worktree_created",
            "projectId": project_id,
            "worktreeId": worktree.id,
            "prompt": prompt,
        })
        .to_string(),
    );

    let mut result = serde_json::json!({
        "id": worktree.id,
        "name": worktree.name,
        "path": worktree.path,
        "branch": worktree.branch,
    });
    if prompt.is_some() {
        result["delegated"] = serde_json::Value::Bool(true);
        result["message"] = serde_json::Value::String(
            "Worktree created and a new agent tab has been spawned with the task. \
             Do NOT cd into the worktree or attempt the task yourself — it is being \
             handled in the new tab."
                .to_string(),
        );
    }

    Ok(result.to_string())
}

fn handle_list_worktrees(app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let (_project, project_id) = find_project_for_cwd(&db, cwd)?;
    let worktrees = db.list_worktrees(&project_id).map_err(|e| e.to_string())?;

    let list: Vec<Value> = worktrees
        .iter()
        .map(|wt| {
            serde_json::json!({
                "id": wt.id,
                "name": wt.name,
                "path": wt.path,
                "branch": wt.branch,
                "source_type": wt.source_type,
            })
        })
        .collect();

    Ok(serde_json::json!(list).to_string())
}

fn handle_spawn_terminal(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let terminal_cwd = args
        .get("cwd")
        .and_then(|v| v.as_str())
        .unwrap_or(cwd)
        .to_string();
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Resolve the worktree ID on the Rust side so the frontend doesn't have
    // to path-match. Try the terminal cwd first, fall back to the session cwd.
    let worktree_id = find_worktree_id_for_cwd(&db, &terminal_cwd)
        .or_else(|| find_worktree_id_for_cwd(&db, cwd));

    // Emit a coppice-action event — the frontend creates the tab in Zustand
    let _ = app.emit(
        "coppice-action",
        serde_json::json!({
            "action": "spawn_terminal",
            "worktreeId": worktree_id,
            "cwd": terminal_cwd,
            "command": command,
        })
        .to_string(),
    );

    Ok(format!(
        "Terminal tab opened{}",
        command
            .as_ref()
            .map(|c| format!(" running: {}", c))
            .unwrap_or_default()
    ))
}

fn handle_open_file(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "'path' is required".to_string())?;

    // Make path absolute if it's relative
    let abs_path = if std::path::Path::new(path).is_absolute() {
        path.to_string()
    } else {
        std::path::Path::new(cwd)
            .join(path)
            .to_string_lossy()
            .to_string()
    };

    let worktree_id = find_worktree_id_for_cwd(&db, cwd);

    let _ = app.emit(
        "coppice-action",
        serde_json::json!({
            "action": "open_file",
            "worktreeId": worktree_id,
            "path": abs_path,
            "cwd": cwd,
        })
        .to_string(),
    );

    Ok(format!("Opened file: {}", abs_path))
}

fn handle_open_scratchpad(args: &Value, app: &AppHandle) -> Result<String, String> {
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "'content' is required".to_string())?;
    let title = args.get("title").and_then(|v| v.as_str());

    let _ = app.emit(
        "coppice-action",
        serde_json::json!({
            "action": "open_scratchpad",
            "content": content,
            "title": title,
        })
        .to_string(),
    );

    Ok("Scratchpad tab created".to_string())
}

fn handle_open_url(args: &Value, _app: &AppHandle) -> Result<String, String> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "'url' is required".to_string())?;

    // Validate the URL scheme for safety
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http:// and https:// URLs are allowed".to_string());
    }

    open_url_in_browser(url)?;

    Ok(format!("Opened URL: {}", url))
}

/// Open a URL in the system browser, cross-platform.
pub fn open_url_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {}", e))?;
    }
    Ok(())
}
