//! Coppice IDE tool handlers.
//!
//! These are invoked by the agent bridge when Claude calls a `coppice_*` MCP
//! tool. Each handler receives the tool arguments as JSON, performs the action,
//! and returns a result string that flows back to the SDK.

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{Database, SCRATCHPAD_PROJECT_ID, SCRATCHPAD_WORKTREE_ID};
use crate::models::{Project, ProjectFormData, Worktree};
use crate::services::pty_manager::PtyManager;
use crate::services::shell_env::user_command;

/// Dispatch a Coppice tool call to the appropriate handler.
pub fn handle_coppice_tool(
    tool_name: &str,
    args: &Value,
    app: &AppHandle,
    cwd: &str,
) -> Result<String, String> {
    match tool_name {
        "create_project" => handle_create_project(args, app),
        "list_projects" => handle_list_projects(app),
        "create_worktree" => handle_create_worktree(args, app, cwd),
        "list_worktrees" => handle_list_worktrees(args, app, cwd),
        "list_runners" => handle_list_runners(args, app, cwd),
        "run_runner" => handle_run_runner(args, app, cwd),
        "stop_runner" => handle_stop_runner(args, app, cwd),
        "runner_status" => handle_runner_status(args, app, cwd),
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
) -> Result<(Project, String), String> {
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

fn find_project_by_id_or_name(db: &Database, project_id: Option<&str>, project_name: Option<&str>) -> Result<Option<Project>, String> {
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    if let Some(id) = project_id.filter(|s| !s.trim().is_empty()) {
        return Ok(projects.into_iter().find(|p| p.id == id));
    }
    if let Some(name) = project_name.filter(|s| !s.trim().is_empty()) {
        let needle = name.trim().to_lowercase();
        return Ok(projects
            .into_iter()
            .find(|p| p.name.to_lowercase() == needle || p.id == name));
    }
    Ok(None)
}

fn resolve_project_for_args(db: &Database, args: &Value, cwd: &str) -> Result<(Project, String), String> {
    let project_id = args.get("project_id").and_then(|v| v.as_str());
    let project_name = args.get("project_name").and_then(|v| v.as_str());
    if project_id.is_some() || project_name.is_some() {
        let project = find_project_by_id_or_name(db, project_id, project_name)?
            .ok_or_else(|| "No Coppice project matched the provided project_id/project_name".to_string())?;
        if project.id == SCRATCHPAD_PROJECT_ID {
            return Err("The scratchpad is not a real project. Choose one of the projects returned by coppice_list_projects.".to_string());
        }
        return Ok((project.clone(), project.id));
    }

    let (project, id) = find_project_for_cwd(db, cwd)?;
    if id == SCRATCHPAD_PROJECT_ID {
        return Err(
            "This session is in the scratchpad, not a project. Call coppice_list_projects and ask the user which project to use, then pass project_id to this tool."
                .to_string(),
        );
    }
    Ok((project, id))
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
fn resolve_worktree_for_args(db: &Database, args: &Value, cwd: &str) -> Result<(Project, String, Worktree), String> {
    let requested_worktree_id = args.get("worktree_id").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());
    let requested_worktree_name = args.get("worktree_name").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty());

    if let Some(wid) = requested_worktree_id {
        let projects = db.list_projects().map_err(|e| e.to_string())?;
        for project in projects {
            let worktrees = db.list_worktrees(&project.id).map_err(|e| e.to_string())?;
            if let Some(wt) = worktrees.into_iter().find(|w| w.id == wid) {
                return Ok((project.clone(), project.id, wt));
            }
        }
        return Err(format!("No Coppice worktree matched worktree_id '{wid}'"));
    }

    let (project, project_id) = resolve_project_for_args(db, args, cwd)?;
    let worktrees = db.list_worktrees(&project_id).map_err(|e| e.to_string())?;

    if let Some(name) = requested_worktree_name {
        let needle = name.to_lowercase();
        if let Some(wt) = worktrees
            .into_iter()
            .find(|w| w.name.to_lowercase() == needle || w.branch == name)
        {
            return Ok((project, project_id, wt));
        }
        return Err(format!("No worktree named '{name}' exists in project '{}'", project.name));
    }

    let cwd_path = std::path::Path::new(cwd);
    let mut best: Option<(usize, Worktree)> = None;
    for wt in worktrees {
        let wt_path = std::path::Path::new(&wt.path);
        if wt_path == cwd_path || cwd_path.starts_with(wt_path) {
            let len = wt.path.len();
            if best.as_ref().map_or(true, |(bl, _)| len > *bl) {
                best = Some((len, wt));
            }
        }
    }

    if let Some((_, wt)) = best {
        if wt.id == SCRATCHPAD_WORKTREE_ID {
            return Err("This session is in the scratchpad. Pass project_id plus worktree_id/worktree_name for the target project worktree.".to_string());
        }
        return Ok((project, project_id, wt));
    }

    Err("Could not determine the target Coppice worktree. Pass worktree_id or worktree_name.".to_string())
}

fn runner_command(project: &Project, key: &str) -> Option<String> {
    match key {
        "setup" if !project.setup_scripts.is_empty() => Some(project.setup_scripts.join(" && ")),
        "build" if !project.build_command.trim().is_empty() => Some(project.build_command.clone()),
        "run" if !project.run_command.trim().is_empty() => Some(project.run_command.clone()),
        _ => None,
    }
}

fn runner_id(worktree_id: &str, key: &str) -> String {
    format!("runner-{key}-{worktree_id}")
}

fn build_worktree_path(project: &Project, name: &str) -> String {
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
fn post_create_setup(app: &AppHandle, project: &Project, worktree_path: &str) {
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

fn handle_list_projects(app: &AppHandle) -> Result<String, String> {
    let db = app.state::<Database>();
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    let list: Vec<Value> = projects
        .iter()
        .filter(|p| p.id != SCRATCHPAD_PROJECT_ID)
        .map(|p| {
            serde_json::json!({
                "id": p.id,
                "name": p.name,
                "local_path": p.local_path,
                "base_branch": p.base_branch,
                "target_branch": p.target_branch,
                "has_setup": !p.setup_scripts.is_empty(),
                "has_build": !p.build_command.trim().is_empty(),
                "has_run": !p.run_command.trim().is_empty(),
            })
        })
        .collect();
    Ok(serde_json::json!(list).to_string())
}

fn handle_create_project(args: &Value, app: &AppHandle) -> Result<String, String> {
    let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
    let local_path = args.get("local_path").and_then(|v| v.as_str()).unwrap_or("").trim();
    if name.is_empty() || local_path.is_empty() {
        return Err("'name' and 'local_path' are required. Ask the user for any missing value before creating a project.".to_string());
    }
    let data = ProjectFormData {
        name: name.to_string(),
        local_path: local_path.to_string(),
        github_remote: args.get("github_remote").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        base_branch: args.get("base_branch").and_then(|v| v.as_str()).unwrap_or("main").to_string(),
        target_branch: args.get("target_branch").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        setup_scripts: args
            .get("setup_scripts")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        build_command: args.get("build_command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        run_command: args.get("run_command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        env_files: args
            .get("env_files")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
        pr_create_skill: args.get("pr_create_skill").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        claude_command: args.get("claude_command").and_then(|v| v.as_str()).unwrap_or("").to_string(),
    };

    let db = app.state::<Database>();
    let project = db.create_project(&data).map_err(|e| e.to_string())?;
    let _ = app.emit("worktrees-changed", ());
    Ok(serde_json::json!({
        "id": project.id,
        "name": project.name,
        "local_path": project.local_path,
    }).to_string())
}

fn handle_create_worktree(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let (project, project_id) = resolve_project_for_args(&db, args, cwd)?;

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

    // Fetch latest remote refs so we don't branch off stale tracking data
    let fetch = user_command("git")
        .args(["fetch", "origin"])
        .current_dir(&project.local_path)
        .output()
        .map_err(|e| format!("Failed to fetch from origin: {}", e))?;

    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        return Err(format!("git fetch failed: {}", stderr));
    }

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

fn handle_list_worktrees(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let project_id_arg = args.get("project_id").and_then(|v| v.as_str());
    let project_name_arg = args.get("project_name").and_then(|v| v.as_str());

    let projects: Vec<Project> = if project_id_arg.is_some() || project_name_arg.is_some() {
        vec![find_project_by_id_or_name(&db, project_id_arg, project_name_arg)?
            .ok_or_else(|| "No Coppice project matched the provided project_id/project_name".to_string())?]
    } else if let Ok((project, project_id)) = find_project_for_cwd(&db, cwd) {
        if project_id == SCRATCHPAD_PROJECT_ID {
            db.list_projects()
                .map_err(|e| e.to_string())?
                .into_iter()
                .filter(|p| p.id != SCRATCHPAD_PROJECT_ID)
                .collect()
        } else {
            vec![project]
        }
    } else {
        db.list_projects()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|p| p.id != SCRATCHPAD_PROJECT_ID)
            .collect()
    };

    let mut out = Vec::new();
    for project in projects {
        let worktrees = db.list_worktrees(&project.id).map_err(|e| e.to_string())?;
        out.push(serde_json::json!({
            "project": {
                "id": project.id,
                "name": project.name,
                "local_path": project.local_path,
            },
            "worktrees": worktrees.iter().map(|wt| serde_json::json!({
                "id": wt.id,
                "name": wt.name,
                "path": wt.path,
                "branch": wt.branch,
                "source_type": wt.source_type,
            })).collect::<Vec<Value>>()
        }));
    }

    Ok(serde_json::json!(out).to_string())
}

fn handle_list_runners(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let db = app.state::<Database>();
    let (project, project_id, worktree) = resolve_worktree_for_args(&db, args, cwd)?;
    let pty = app.state::<PtyManager>();
    let runners: Vec<Value> = ["setup", "build", "run"]
        .iter()
        .map(|key| {
            let command = runner_command(&project, key);
            let id = runner_id(&worktree.id, key);
            serde_json::json!({
                "key": key,
                "available": command.is_some(),
                "command": command,
                "status": if pty.exists(&id) { "running" } else { "stopped" },
            })
        })
        .collect();
    Ok(serde_json::json!({
        "projectId": project_id,
        "projectName": project.name,
        "worktreeId": worktree.id,
        "worktreeName": worktree.name,
        "runners": runners,
    }).to_string())
}

fn handle_run_runner(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let key = args.get("runner").or_else(|| args.get("key")).and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(key, "setup" | "build" | "run") {
        return Err("'runner' must be one of: setup, build, run".to_string());
    }
    let db = app.state::<Database>();
    let (project, project_id, worktree) = resolve_worktree_for_args(&db, args, cwd)?;
    let Some(command) = runner_command(&project, key) else {
        return Ok(serde_json::json!({
            "available": false,
            "runner": key,
            "message": format!("The '{}' runner is not configured for project '{}'. Do not run an equivalent shell command yourself unless the user explicitly asks.", key, project.name),
        }).to_string());
    };

    let _ = app.emit(
        "coppice-action",
        serde_json::json!({
            "action": "run_runner",
            "projectId": project_id,
            "worktreeId": worktree.id,
            "runner": key,
            "command": command,
            "cwd": worktree.path,
        })
        .to_string(),
    );

    Ok(serde_json::json!({
        "available": true,
        "runner": key,
        "status": "starting",
        "message": format!("Requested Coppice to run the '{}' runner. Output is shown in the sidepanel.", key),
    }).to_string())
}

fn handle_stop_runner(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let key = args.get("runner").or_else(|| args.get("key")).and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(key, "setup" | "build" | "run") {
        return Err("'runner' must be one of: setup, build, run".to_string());
    }
    let db = app.state::<Database>();
    let (_project, project_id, worktree) = resolve_worktree_for_args(&db, args, cwd)?;
    let id = runner_id(&worktree.id, key);
    let pty = app.state::<PtyManager>();
    let _ = pty.kill(&id);
    let _ = app.emit(
        "coppice-action",
        serde_json::json!({
            "action": "runner_stopped",
            "projectId": project_id,
            "worktreeId": worktree.id,
            "runner": key,
        })
        .to_string(),
    );
    Ok(serde_json::json!({ "runner": key, "status": "stopped" }).to_string())
}

fn handle_runner_status(args: &Value, app: &AppHandle, cwd: &str) -> Result<String, String> {
    let key = args.get("runner").or_else(|| args.get("key")).and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(key, "setup" | "build" | "run") {
        return Err("'runner' must be one of: setup, build, run".to_string());
    }
    let db = app.state::<Database>();
    let (project, _project_id, worktree) = resolve_worktree_for_args(&db, args, cwd)?;
    let command = runner_command(&project, key);
    let id = runner_id(&worktree.id, key);
    let pty = app.state::<PtyManager>();
    Ok(serde_json::json!({
        "runner": key,
        "available": command.is_some(),
        "status": if pty.exists(&id) { "running" } else { "stopped" },
        "command": command,
        "worktreeId": worktree.id,
        "worktreeName": worktree.name,
    }).to_string())
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
