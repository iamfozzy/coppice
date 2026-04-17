use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use crate::db::Database;
use crate::services::pty_manager::PtyManager;
use crate::services::shell_env::{bin, user_command};

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
pub async fn get_pr_for_branch(
    db: State<'_, Database>,
    project_id: String,
    branch: String,
) -> Result<PrStatus, String> {
    let cwd = get_project_path(&db, &project_id)?;

    // Get PR for this branch using gh CLI
    let pr_output = user_command(&bin("gh"))
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
    let output = user_command(&bin("gh"))
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
pub async fn create_pr(
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
    let push_output = user_command("git")
        .args(["push", "-u", "origin", "HEAD"])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to push: {}", e))?;

    if !push_output.status.success() {
        let stderr = String::from_utf8_lossy(&push_output.stderr);
        return Err(format!("git push failed: {}", stderr));
    }

    // Create the PR
    let output = user_command(&bin("gh"))
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
pub async fn get_failed_action_logs(
    db: State<'_, Database>,
    project_id: String,
    pr_number: i64,
) -> Result<String, String> {
    let cwd = get_project_path(&db, &project_id)?;

    // First, resolve the PR's head branch name (Command::new doesn't
    // invoke a shell, so we cannot use $(...) expansions).
    let head_ref_output = user_command(&bin("gh"))
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
    let checks_output = user_command(&bin("gh"))
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

    let run_list = user_command(&bin("gh"))
        .args(&run_list_args)
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to get run ID: {}", e))?;

    let run_id = String::from_utf8_lossy(&run_list.stdout).trim().to_string();

    if run_id.is_empty() {
        return Ok(format!("PR #{} checks:\n{}", pr_number, checks_text));
    }

    let logs_output = user_command(&bin("gh"))
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
    pub is_resolved: bool,
    pub thread_id: Option<String>,
}

#[tauri::command]
pub async fn get_pr_comments(
    db: State<'_, Database>,
    project_id: String,
    pr_number: i64,
) -> Result<Vec<PrComment>, String> {
    let cwd = get_project_path(&db, &project_id)?;

    // Get review comments (inline code comments)
    let review_output = user_command(&bin("gh"))
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
                is_resolved: false,
                thread_id: None,
            });
        }
    }

    // Get issue comments (general PR comments)
    let issue_output = user_command(&bin("gh"))
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
                is_resolved: false,
                thread_id: None,
            });
        }
    }

    // Fetch thread resolution status via GraphQL (best-effort)
    if let Ok(repo_out) = user_command(&bin("gh"))
        .args(["repo", "view", "--json", "owner,name"])
        .current_dir(&cwd)
        .output()
    {
        if repo_out.status.success() {
            if let Ok(repo_json) = serde_json::from_slice::<serde_json::Value>(&repo_out.stdout) {
                let owner = repo_json["owner"]["login"].as_str().unwrap_or("");
                let name = repo_json["name"].as_str().unwrap_or("");

                if !owner.is_empty() && !name.is_empty() {
                    let query = r#"query($owner: String!, $name: String!, $pr: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 100) { nodes { databaseId } } } } } } }"#;

                    if let Ok(gql_out) = user_command(&bin("gh"))
                        .args([
                            "api", "graphql",
                            "-f", &format!("owner={}", owner),
                            "-f", &format!("name={}", name),
                            "-F", &format!("pr={}", pr_number),
                            "-f", &format!("query={}", query),
                        ])
                        .current_dir(&cwd)
                        .output()
                    {
                        if gql_out.status.success() {
                            if let Ok(gql_json) = serde_json::from_slice::<serde_json::Value>(&gql_out.stdout) {
                                let threads = &gql_json["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"];
                                if let Some(thread_array) = threads.as_array() {
                                    let mut resolution_map: std::collections::HashMap<i64, (bool, String)> =
                                        std::collections::HashMap::new();
                                    for thread in thread_array {
                                        let is_resolved = thread["isResolved"].as_bool().unwrap_or(false);
                                        let thread_id = thread["id"].as_str().unwrap_or("").to_string();
                                        if let Some(comment_nodes) = thread["comments"]["nodes"].as_array() {
                                            for comment in comment_nodes {
                                                if let Some(db_id) = comment["databaseId"].as_i64() {
                                                    resolution_map.insert(db_id, (is_resolved, thread_id.clone()));
                                                }
                                            }
                                        }
                                    }
                                    for comment in &mut comments {
                                        if let Some((resolved, tid)) = resolution_map.get(&comment.id) {
                                            comment.is_resolved = *resolved;
                                            comment.thread_id = Some(tid.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Sort by created_at
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(comments)
}

#[tauri::command]
pub async fn resolve_pr_comment(
    db: State<'_, Database>,
    project_id: String,
    thread_id: String,
    resolve: bool,
) -> Result<(), String> {
    let cwd = get_project_path(&db, &project_id)?;

    let mutation_name = if resolve {
        "resolveReviewThread"
    } else {
        "unresolveReviewThread"
    };

    let query = format!(
        r#"mutation($threadId: ID!) {{ {}(input: {{threadId: $threadId}}) {{ thread {{ id isResolved }} }} }}"#,
        mutation_name
    );

    let output = user_command(&bin("gh"))
        .args([
            "api", "graphql",
            "-f", &format!("threadId={}", thread_id),
            "-f", &format!("query={}", query),
        ])
        .current_dir(&cwd)
        .output()
        .map_err(|e| format!("Failed to {} thread: {}", mutation_name, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to {} thread: {}", mutation_name, stderr));
    }

    // Check for GraphQL errors in the response
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        if let Some(errors) = json["errors"].as_array() {
            if !errors.is_empty() {
                let msg = errors[0]["message"].as_str().unwrap_or("Unknown error");
                return Err(format!("GraphQL error: {}", msg));
            }
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthStatus {
    pub logged_in: bool,
    pub user: Option<String>,
    pub host: String,
}

/// Check whether the bundled `gh` is authenticated against github.com.
///
/// `gh auth status` exits non-zero when not logged in and writes its
/// human-readable report to stderr in both cases; we parse the username out
/// of the "Logged in to github.com account <user>" line when present.
#[tauri::command]
pub async fn github_auth_status() -> Result<AuthStatus, String> {
    let output = user_command(&bin("gh"))
        .args(["auth", "status", "--hostname", "github.com"])
        .output()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    if !output.status.success() {
        return Ok(AuthStatus {
            logged_in: false,
            user: None,
            host: "github.com".into(),
        });
    }

    let user = combined
        .lines()
        .find_map(|line| {
            let t = line.trim();
            t.strip_prefix("Logged in to github.com account ")
                .map(|rest| rest.split_whitespace().next().unwrap_or("").to_string())
                .filter(|s| !s.is_empty())
        });

    Ok(AuthStatus {
        logged_in: true,
        user,
        host: "github.com".into(),
    })
}

/// Start an interactive `gh auth login` session in a PTY. The frontend
/// attaches an xterm to `session_id` to show the device-code prompt and let
/// the user press Enter / paste the code. `-w` uses the web browser flow,
/// which is the only one that works inside a packaged app with no stored
/// SSH keys.
#[tauri::command]
pub fn github_auth_login(
    session_id: String,
    rows: Option<u16>,
    cols: Option<u16>,
    pty_manager: State<'_, PtyManager>,
    app: AppHandle,
) -> Result<(), String> {
    let gh = bin("gh");
    let cmd = format!(
        "{} auth login --hostname github.com --git-protocol https --web",
        shell_quote(&gh)
    );
    let cwd = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    pty_manager.spawn(
        &session_id,
        &cwd,
        Some(&cmd),
        rows.unwrap_or(24),
        cols.unwrap_or(80),
        &app,
        None,
    )
}

/// Log out of github.com. Runs non-interactively — `gh` writes credentials
/// to its config dir so a simple invocation is enough.
#[tauri::command]
pub async fn github_auth_logout() -> Result<(), String> {
    let output = user_command(&bin("gh"))
        .args(["auth", "logout", "--hostname", "github.com"])
        .output()
        .map_err(|e| format!("Failed to run gh: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    Ok(())
}

/// Minimal POSIX-ish quoting for paths passed through a shell command line.
/// Sidecar paths on macOS live under `.app/Contents/MacOS/` which contains
/// spaces in the bundle name; wrap in single quotes and escape any embedded
/// single quotes. Windows pwsh/cmd aren't covered here — auth login is a
/// Unix-shaped flow in practice, and Tauri spawns this through the platform
/// shell which handles its own quoting on Windows.
fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}
