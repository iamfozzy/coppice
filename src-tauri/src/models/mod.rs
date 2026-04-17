use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub local_path: String,
    pub github_remote: String,
    pub base_branch: String,
    pub setup_scripts: Vec<String>,
    pub build_command: String,
    pub run_command: String,
    pub env_files: Vec<String>,
    pub pr_create_skill: String,
    pub claude_command: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFormData {
    pub name: String,
    pub local_path: String,
    pub github_remote: String,
    pub base_branch: String,
    pub setup_scripts: Vec<String>,
    pub build_command: String,
    pub run_command: String,
    pub env_files: Vec<String>,
    pub pr_create_skill: String,
    pub claude_command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Worktree {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub branch: String,
    pub target_branch: Option<String>,
    pub source_type: String,
    pub pr_number: Option<i64>,
    pub pr_status: Option<String>,
    pub ci_status: Option<String>,
    pub pinned: bool,
    pub archived: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTabCache {
    pub tab_id: String,
    pub worktree_id: String,
    pub label: String,
    pub cwd: String,
    pub sdk_session_id: Option<String>,
    pub model: String,
    pub effort: String,
    pub permission_mode: String,
    pub status: String,
    pub cost_json: Option<String>,
    pub messages_json: String,
    pub tab_order: i32,
    pub extended_context: bool,
    pub created_at: String,
}
