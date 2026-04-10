use std::process::Command;
use serde::{Deserialize, Serialize};
use tauri::State;
use crate::db::Database;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrInfo {
    pub number: i64,
    pub title: String,
    pub state: String,
    pub url: String,
    pub draft: bool,
    pub mergeable: Option<String>,
    pub head_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckRun {
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrStatus {
    pub pr: Option<PrInfo>,
    pub checks: Vec<CheckRun>,
}

fn get_project_path(db: &Database, project_id: &str) -> Result<String, String> {
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.local_path.clone())
        .ok_or_else(|| "Project not found".to_string())
}

fn _get_github_remote(db: &Database, project_id: &str) -> Result<String, String> {
    let projects = db.list_projects().map_err(|e| e.to_string())?;
    projects
        .iter()
        .find(|p| p.id == project_id)
        .map(|p| p.github_remote.clone())
        .ok_or_else(|| "Project not found".to_string())
}

#[tauri::command]
pub fn get_pr_for_branch(
    db: State<'_, Database>,
    project_id: String,
    branch: String,
) -> Result<PrStatus, String> {
    let cwd = get_project_path(&db, &project_id)?;

    // Get PR for this branch using gh CLI
    let pr_output = Command::new("gh")
        .args([
            "pr", "view", &branch,
            "--json", "number,title,state,url,isDraft,mergeable,headRefName",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    let pr = if pr_output.status.success() {
        let json: serde_json::Value =
            serde_json::from_slice(&pr_output.stdout).map_err(|e| e.to_string())?;
        Some(PrInfo {
            number: json["number"].as_i64().unwrap_or(0),
            title: json["title"].as_str().unwrap_or("").to_string(),
            state: json["state"].as_str().unwrap_or("").to_string(),
            url: json["url"].as_str().unwrap_or("").to_string(),
            draft: json["isDraft"].as_bool().unwrap_or(false),
            mergeable: json["mergeable"].as_str().map(|s| s.to_string()),
            head_ref: json["headRefName"].as_str().unwrap_or("").to_string(),
        })
    } else {
        None
    };

    // Get check runs for the branch
    let checks = if let Some(ref pr_info) = pr {
        get_check_runs(&cwd, pr_info.number)?
    } else {
        Vec::new()
    };

    Ok(PrStatus { pr, checks })
}

fn get_check_runs(cwd: &str, pr_number: i64) -> Result<Vec<CheckRun>, String> {
    let output = Command::new("gh")
        .args([
            "pr", "checks", &pr_number.to_string(),
            "--json", "name,state,link",
        ])
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("Failed to get checks: {}", e))?;

    if !output.status.success() {
        return Ok(Vec::new());
    }

    let items: Vec<serde_json::Value> =
        serde_json::from_slice(&output.stdout).unwrap_or_default();

    Ok(items
        .iter()
        .map(|item| CheckRun {
            name: item["name"].as_str().unwrap_or("").to_string(),
            status: item["state"].as_str().unwrap_or("PENDING").to_string(),
            conclusion: item["state"].as_str().map(|s| s.to_string()),
            url: item["link"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

#[tauri::command]
pub fn create_pr(
    db: State<'_, Database>,
    project_id: String,
    worktree_path: String,
    title: String,
    body: String,
) -> Result<PrInfo, String> {
    let cwd = if worktree_path.is_empty() {
        get_project_path(&db, &project_id)?
    } else {
        worktree_path
    };

    // Push the branch first
    let push_output = Command::new("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr));
    }

    // Create the PR
    let output = Command::new("gh")
        .args([
            "pr", "create",
            "--title", &title,
            "--body", &body,
            "--json", "number,title,state,url,isDraft,mergeable,headRefName",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to create PR: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr create failed: {}", stderr));
    }

    let json: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;

    Ok(PrInfo {
        number: json["number"].as_i64().unwrap_or(0),
        title: json["title"].as_str().unwrap_or("").to_string(),
        state: json["state"].as_str().unwrap_or("").to_string(),
        url: json["url"].as_str().unwrap_or("").to_string(),
        draft: json["isDraft"].as_bool().unwrap_or(false),
        mergeable: json["mergeable"].as_str().map(|s| s.to_string()),
        head_ref: json["headRefName"].as_str().unwrap_or("").to_string(),
    })
}

#[tauri::command]
pub fn get_failed_action_logs(
    db: State<'_, Database>,
    project_id: String,
    pr_number: i64,
) -> Result<String, String> {
    let cwd = get_project_path(&db, &project_id)?;

    // First, resolve the PR's head branch name (Command::new doesn't
    // invoke a shell, so we cannot use $(...) expansions).
    let head_ref_output = Command::new("gh")
        .args([
            "pr", "view", &pr_number.to_string(),
            "--json", "headRefName",
            "-q", ".headRefName",
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get PR head ref: {}", e))?;

    let head_ref = String::from_utf8_lossy(&head_ref_output.stdout).trim().to_string();

    // Get from PR checks directly
    let checks_output = Command::new("gh")
        .args([
            "pr", "checks", &pr_number.to_string(),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get checks: {}", e))?;

    let checks_text = String::from_utf8_lossy(&checks_output.stdout).to_string();

    // Get the latest failed run for this branch
    let mut run_list_args = vec![
        "run", "list",
        "--status", "failure",
        "--limit", "1",
        "--json", "databaseId",
        "-q", ".[0].databaseId",
    ];
    if !head_ref.is_empty() {
        run_list_args.push("--branch");
        run_list_args.push(&head_ref);
    }

    let run_list = Command::new("gh")
        .args(&run_list_args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get run ID: {}", e))?;

    let run_id = String::from_utf8_lossy(&run_list.stdout).trim().to_string();

    if run_id.is_empty() {
        return Ok(format!("PR #{} checks:\n{}", pr_number, checks_text));
    }

    let logs_output = Command::new("gh")
        .args(["run", "view", &run_id, "--log-failed"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get logs: {}", e))?;

    let logs = String::from_utf8_lossy(&logs_output.stdout).to_string();

    // Truncate if very long
    let truncated = if logs.len() > 10000 {
        format!("{}...\n\n[Truncated — showing last 10000 chars]", &logs[logs.len()-10000..])
    } else {
        logs
    };

    Ok(format!(
        "PR #{} has failed CI checks.\n\nChecks:\n{}\n\nFailed logs:\n{}",
        pr_number, checks_text, truncated
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrComment {
    pub id: i64,
    pub author: String,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<i64>,
    pub created_at: String,
    pub url: String,
}

#[tauri::command]
pub fn get_pr_comments(
    db: State<'_, Database>,
    project_id: String,
    pr_number: i64,
) -> Result<Vec<PrComment>, String> {
    let cwd = get_project_path(&db, &project_id)?;

    // Get review comments (inline code comments)
    let review_output = Command::new("gh")
        .args([
            "api",
            &format!("repos/{{owner}}/{{repo}}/pulls/{}/comments", pr_number),
            "--jq", r#"[.[] | {id: .id, author: .user.login, body: .body, path: .path, line: (.line // .original_line), created_at: .created_at, url: .html_url}]"#,
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get review comments: {}", e))?;

    let mut comments: Vec<PrComment> = Vec::new();

    if review_output.status.success() {
        let items: Vec<serde_json::Value> =
            serde_json::from_slice(&review_output.stdout).unwrap_or_default();
        for item in &items {
            comments.push(PrComment {
                id: item["id"].as_i64().unwrap_or(0),
                author: item["author"].as_str().unwrap_or("").to_string(),
                body: item["body"].as_str().unwrap_or("").to_string(),
                path: item["path"].as_str().map(|s| s.to_string()),
                line: item["line"].as_i64(),
                created_at: item["created_at"].as_str().unwrap_or("").to_string(),
                url: item["url"].as_str().unwrap_or("").to_string(),
            });
        }
    }

    // Get issue comments (general PR comments)
    let issue_output = Command::new("gh")
        .args([
            "api",
            &format!("repos/{{owner}}/{{repo}}/issues/{}/comments", pr_number),
            "--jq", r#"[.[] | {id: .id, author: .user.login, body: .body, path: null, line: null, created_at: .created_at, url: .html_url}]"#,
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get issue comments: {}", e))?;

    if issue_output.status.success() {
        let items: Vec<serde_json::Value> =
            serde_json::from_slice(&issue_output.stdout).unwrap_or_default();
        for item in &items {
            comments.push(PrComment {
                id: item["id"].as_i64().unwrap_or(0),
                author: item["author"].as_str().unwrap_or("").to_string(),
                body: item["body"].as_str().unwrap_or("").to_string(),
                path: None,
                line: None,
                created_at: item["created_at"].as_str().unwrap_or("").to_string(),
                url: item["url"].as_str().unwrap_or("").to_string(),
            });
        }
    }

    // Sort by created_at
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(comments)
}
