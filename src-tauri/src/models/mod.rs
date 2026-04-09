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
