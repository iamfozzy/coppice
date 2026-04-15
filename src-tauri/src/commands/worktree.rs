use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use crate::db::Database;
use crate::models::{Project, Worktree};
use crate::services::shell_env::user_command;

#[derive(Debug, Clone, Serialize)]
pub struct GitFileStatus {
    pub status: String,
    pub file: String,
}

#[tauri::command]
pub async fn list_worktrees(db: State<'_, Database>, project_id: String) -> Result<Vec<Worktree>, String> {
    db.list_worktrees(&project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_worktree(
    app: AppHandle,
    db: State<'_, Database>,
    project_id: String,
    branch: String,
    name: String,
) -> Result<Worktree, String> {
    let project = find_project(&db, &project_id)?;
    validate_worktree_name(&name)?;
    let worktree_path = build_worktree_path(&project, &name);

    // Prune stale worktree references first
    let _ = user_command("git")
        .args(["worktree", "prune"])
        .current_dir(&project.local_path)
        .output();

    // Use --detach to avoid "already checked out" errors, then checkout the branch
    let output = user_command("git")
        .args(["worktree", "add", "--detach", &worktree_path])
        .current_dir(&project.local_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    // Now checkout the desired branch in the worktree
    let checkout = user_command("git")
        .args(["checkout", &branch])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to checkout: {}", e))?;

    if !checkout.status.success() {
        let stderr = String::from_utf8_lossy(&checkout.stderr);
        // Clean up the worktree if checkout fails
        let _ = user_command("git")
            .args(["worktree", "remove", "--force", &worktree_path])
            .current_dir(&project.local_path)
            .output();
        return Err(format!("git checkout failed: {}", stderr));
    }

    post_create_setup(&app, &project, &worktree_path);

    db.create_worktree(&project_id, &name, &worktree_path, &branch, "branch")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_worktree_new_branch(
    app: AppHandle,
    db: State<'_, Database>,
    project_id: String,
    base_branch: String,
    new_branch: String,
    name: String,
) -> Result<Worktree, String> {
    let project = find_project(&db, &project_id)?;
    validate_worktree_name(&name)?;
    let worktree_path = build_worktree_path(&project, &name);

    // Prune stale worktree references first
    let _ = user_command("git")
        .args(["worktree", "prune"])
        .current_dir(&project.local_path)
        .output();

    // Create worktree with a new branch based off the selected base
    let output = user_command("git")
        .args([
            "worktree", "add",
            "-b", &new_branch,
            &worktree_path,
            &base_branch,
        ])
        .current_dir(&project.local_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git worktree add failed: {}", stderr));
    }

    post_create_setup(&app, &project, &worktree_path);

    db.create_worktree(&project_id, &name, &worktree_path, &new_branch, "branch")
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_worktree_target_branch(db: State<'_, Database>, id: String, target_branch: Option<String>) -> Result<(), String> {
    db.set_worktree_target_branch(&id, target_branch.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_worktree(db: State<'_, Database>, id: String, name: String) -> Result<(), String> {
    db.rename_worktree(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_worktree(db: State<'_, Database>, id: String) -> Result<(), String> {
    // Collect info needed for cleanup before deleting the DB record
    let mut cleanup_info: Option<(String, String)> = None;
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    for project in &projects {
        let worktrees = db.list_worktrees(&project.id).map_err(|e| e.to_string())?;
        if let Some(wt) = worktrees.iter().find(|w| w.id == id) {
            cleanup_info = Some((project.local_path.clone(), wt.path.clone()));
            break;
        }
    }

    // Delete from DB immediately so UI updates instantly
    db.delete_worktree(&id).map_err(|e| e.to_string())?;

    // Run the heavy git/filesystem cleanup in the background
    if let Some((project_path, wt_path)) = cleanup_info {
        std::thread::spawn(move || {
            let _ = user_command("git")
                .args(["worktree", "prune"])
                .current_dir(&project_path)
                .output();

            let _ = user_command("git")
                .args(["worktree", "remove", "--force", &wt_path])
                .current_dir(&project_path)
                .output();

            let path = std::path::Path::new(&wt_path);
            if path.exists() {
                let _ = std::fs::remove_dir_all(path);
            }

            let _ = user_command("git")
                .args(["worktree", "prune"])
                .current_dir(&project_path)
                .output();
        });
    }

    Ok(())
}

#[tauri::command]
pub async fn list_branches(db: State<'_, Database>, project_id: String) -> Result<Vec<String>, String> {
    let project = find_project(&db, &project_id)?;

    let output = user_command("git")
        .args(["branch", "-a", "--format=%(refname:short)"])
        .current_dir(&project.local_path)
        .output()
        .map_err(|e| format!("Failed to list branches: {}", e))?;

    if !output.status.success() {
        return Err("Failed to list branches".to_string());
    }

    let branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    Ok(branches)
}

#[tauri::command]
pub async fn get_current_branch(path: String) -> Result<String, String> {
    let output = user_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get branch: {}", e))?;

    if !output.status.success() {
        return Err("Not a git directory".to_string());
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub async fn get_git_status(path: String) -> Result<Vec<GitFileStatus>, String> {
    let output = user_command("git")
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to run git status: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git status failed: {}", stderr));
    }

    let statuses = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.len() >= 4)
        .map(|line| {
            let status = line[..2].trim().to_string();
            let raw_file = &line[3..];
            // For renames/copies (R/C), format is "old -> new" — use the new path
            let file = if raw_file.contains(" -> ") {
                raw_file.rsplit(" -> ").next().unwrap_or(raw_file)
            } else {
                raw_file
            };
            // Strip C-style quotes git uses for paths with special characters
            let file = if file.starts_with('"') && file.ends_with('"') {
                &file[1..file.len() - 1]
            } else {
                file
            };
            GitFileStatus { status, file: file.to_string() }
        })
        .collect();

    Ok(statuses)
}

/// Read file content from a specific git ref (or working tree)
#[tauri::command]
pub async fn get_file_content(path: String, file: String, git_ref: Option<String>) -> Result<String, String> {
    if let Some(r) = git_ref {
        // Read from git object
        let output = user_command("git")
            .args(["show", &format!("{}:{}", r, file)])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to read file: {}", e))?;

        if !output.status.success() {
            // File doesn't exist at that ref (new file)
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        // Read from working tree
        let file_path = std::path::Path::new(&path).join(&file);
        std::fs::read_to_string(&file_path)
            .map_err(|e| format!("Failed to read file: {}", e))
    }
}

/// Get the merge-base commit between current HEAD and a base branch
#[tauri::command]
pub async fn get_merge_base(path: String, base_branch: Option<String>) -> Result<String, String> {
    let base = base_branch.unwrap_or_else(|| "main".to_string());
    let output = user_command("git")
        .args(["merge-base", &base, "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get merge-base: {}", e))?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Get diff for a single file (uncommitted changes)
#[tauri::command]
pub async fn get_file_diff(path: String, file: String) -> Result<String, String> {
    // Try staged diff first, fall back to unstaged
    let output = user_command("git")
        .args(["diff", "HEAD", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get diff: {}", e))?;

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    // If empty, try diff against nothing (new file)
    if diff.trim().is_empty() {
        let empty_path = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };
        let output2 = user_command("git")
            .args(["diff", "--no-index", empty_path, &file])
            .current_dir(&path)
            .output()
            .unwrap_or(output);
        return Ok(String::from_utf8_lossy(&output2.stdout).to_string());
    }

    Ok(diff)
}

/// Get all files changed in the PR (diff against base branch)
#[tauri::command]
pub async fn get_pr_diff_files(path: String, base_branch: Option<String>) -> Result<Vec<GitFileStatus>, String> {
    let base = base_branch.unwrap_or_else(|| "main".to_string());

    // Get merge base
    let merge_base = user_command("git")
        .args(["merge-base", &base, "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get merge-base: {}", e))?;

    let base_commit = String::from_utf8_lossy(&merge_base.stdout).trim().to_string();
    if base_commit.is_empty() {
        return Ok(Vec::new());
    }

    let output = user_command("git")
        .args(["diff", "--name-status", &base_commit, "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get PR diff: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let files = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(3, '\t').collect();
            if parts.len() >= 2 {
                // Strip numeric suffix from status (e.g. "R100" -> "R")
                let status = parts[0].chars().take_while(|c| c.is_ascii_alphabetic()).collect::<String>();
                // For renames/copies (R/C), the new path is the third field
                let file = if parts.len() == 3 {
                    parts[2].to_string()
                } else {
                    parts[1].to_string()
                };
                Some(GitFileStatus { status, file })
            } else {
                None
            }
        })
        .collect();

    Ok(files)
}

/// Get diff for a file against the PR base branch
#[tauri::command]
pub async fn get_pr_file_diff(path: String, file: String, base_branch: Option<String>) -> Result<String, String> {
    let base = base_branch.unwrap_or_else(|| "main".to_string());

    let merge_base = user_command("git")
        .args(["merge-base", &base, "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get merge-base: {}", e))?;

    let base_commit = String::from_utf8_lossy(&merge_base.stdout).trim().to_string();
    if base_commit.is_empty() {
        return Err("Could not find merge base".to_string());
    }

    let output = user_command("git")
        .args(["diff", &base_commit, "HEAD", "--", &file])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get diff: {}", e))?;

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[tauri::command]
pub async fn get_unpushed_count(path: String) -> Result<u32, String> {
    let branch = user_command("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to get branch: {}", e))?;
    let branch = String::from_utf8_lossy(&branch.stdout).trim().to_string();

    // Check if remote tracking branch exists
    let has_remote = user_command("git")
        .args(["rev-parse", "--verify", &format!("origin/{}", branch)])
        .current_dir(&path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if !has_remote {
        // No remote tracking branch — count commits since fork point from main
        // Try common base branch names to find where this branch diverged
        for base in &["origin/main", "origin/master", "main", "master"] {
            let merge_base = user_command("git")
                .args(["merge-base", base, "HEAD"])
                .current_dir(&path)
                .output();
            if let Ok(mb) = merge_base {
                if mb.status.success() {
                    let mb_sha = String::from_utf8_lossy(&mb.stdout).trim().to_string();
                    if !mb_sha.is_empty() {
                        let output = user_command("git")
                            .args(["rev-list", "--count", &format!("{}..HEAD", mb_sha)])
                            .current_dir(&path)
                            .output()
                            .map_err(|e| format!("Failed to count commits: {}", e))?;
                        let count = String::from_utf8_lossy(&output.stdout)
                            .trim()
                            .parse::<u32>()
                            .unwrap_or(0);
                        return Ok(count);
                    }
                }
            }
        }
        // Could not determine base — report 0
        return Ok(0);
    }

    let output = user_command("git")
        .args(["rev-list", "--count", &format!("origin/{}..HEAD", branch)])
        .current_dir(&path)
        .output()
        .map_err(|e| format!("Failed to count unpushed: {}", e))?;

    let count = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u32>()
        .unwrap_or(0);
    Ok(count)
}

/// Fetch and fast-forward a base branch from origin
#[tauri::command]
pub async fn update_base_branch(db: State<'_, Database>, project_id: String, branch: String) -> Result<(), String> {
    let project = find_project(&db, &project_id)?;

    // Fetch the latest from origin for this branch
    let fetch = user_command("git")
        .args(["fetch", "origin", &branch])
        .current_dir(&project.local_path)
        .output()
        .map_err(|e| format!("Failed to fetch: {}", e))?;

    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        return Err(format!("git fetch failed: {}", stderr));
    }

    // Check what branch is currently checked out in the main repo
    let head = user_command("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(&project.local_path)
        .output()
        .ok();

    let current_branch = head
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();

    if current_branch == branch {
        // Branch is checked out in main repo — fast-forward merge
        let merge = user_command("git")
            .args(["merge", "--ff-only", &format!("origin/{}", branch)])
            .current_dir(&project.local_path)
            .output()
            .map_err(|e| format!("Failed to merge: {}", e))?;

        if !merge.status.success() {
            let stderr = String::from_utf8_lossy(&merge.stderr);
            return Err(format!("Cannot fast-forward {}: {}", branch, stderr));
        }
    } else {
        // Branch is not checked out — update the ref directly
        let update = user_command("git")
            .args(["branch", "-f", &branch, &format!("origin/{}", branch)])
            .current_dir(&project.local_path)
            .output()
            .map_err(|e| format!("Failed to update branch: {}", e))?;

        if !update.status.success() {
            let stderr = String::from_utf8_lossy(&update.stderr);
            return Err(format!("Failed to update {}: {}", branch, stderr));
        }
    }

    Ok(())
}

/// Revert a single file's uncommitted changes
#[tauri::command]
pub fn revert_file(path: String, file: String, status: String) -> Result<(), String> {
    if status == "??" {
        // Untracked file — just delete it
        let file_path = std::path::Path::new(&path).join(&file);
        if file_path.is_dir() {
            std::fs::remove_dir_all(&file_path)
                .map_err(|e| format!("Failed to remove directory: {}", e))?;
        } else if file_path.exists() {
            std::fs::remove_file(&file_path)
                .map_err(|e| format!("Failed to remove file: {}", e))?;
        }
    } else {
        // Tracked file — unstage first, then restore from HEAD
        let _ = user_command("git")
            .args(["reset", "HEAD", "--", &file])
            .current_dir(&path)
            .output();

        let output = user_command("git")
            .args(["checkout", "HEAD", "--", &file])
            .current_dir(&path)
            .output()
            .map_err(|e| format!("Failed to revert file: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("git checkout failed: {}", stderr));
        }
    }

    Ok(())
}

fn find_project(db: &Database, project_id: &str) -> Result<Project, String> {
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    projects
        .into_iter()
        .find(|p| p.id == project_id)
        .ok_or_else(|| "Project not found".to_string())
}

fn post_create_setup(app: &AppHandle, project: &Project, worktree_path: &str) {
    let total = project.env_files.len();
    for (i, env_file) in project.env_files.iter().enumerate() {
        let _ = app.emit("worktree-setup-progress", serde_json::json!({
            "step": i + 1,
            "total": total,
            "file": env_file,
        }));
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

/// Validate a worktree folder name. Rejects characters and reserved names
/// that are illegal on Windows (`< > : " | ? * \`, control chars, CON/PRN/…)
/// so worktree creation fails fast with a clear message rather than
/// producing cryptic git errors on the target platform.
fn validate_worktree_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Worktree name cannot be empty".to_string());
    }
    // Illegal on Windows filesystems (and confusing elsewhere).
    const ILLEGAL: &[char] = &['<', '>', ':', '"', '|', '?', '*', '\\', '/'];
    if let Some(c) = trimmed.chars().find(|c| ILLEGAL.contains(c) || (*c as u32) < 0x20) {
        return Err(format!(
            "Worktree name contains invalid character '{}'. Avoid: {}",
            c,
            "< > : \" | ? * \\ /"
        ));
    }
    // Windows disallows a trailing dot or space in any path component.
    if trimmed.ends_with('.') || trimmed.ends_with(' ') {
        return Err("Worktree name cannot end with '.' or a space".to_string());
    }
    // Windows reserved device names (case-insensitive, with or without extension).
    let stem = trimmed.split('.').next().unwrap_or(trimmed).to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| *r == stem) {
        return Err(format!("'{}' is a reserved name on Windows", trimmed));
    }
    Ok(())
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
