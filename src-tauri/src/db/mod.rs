use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::{AgentTabCache, Project, ProjectFormData, Worktree};

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new() -> Result<Self> {
        let db_path = Self::db_path();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    fn db_path() -> PathBuf {
        let mut path = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
        path.push("coppice");
        path.push("coppice.db");
        path
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                local_path TEXT NOT NULL,
                github_remote TEXT NOT NULL DEFAULT '',
                base_branch TEXT NOT NULL DEFAULT 'main',
                setup_scripts TEXT NOT NULL DEFAULT '[]',
                build_command TEXT NOT NULL DEFAULT '',
                run_command TEXT NOT NULL DEFAULT '',
                env_files TEXT NOT NULL DEFAULT '[]',
                pr_create_skill TEXT NOT NULL DEFAULT '',
                claude_command TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );


            CREATE TABLE IF NOT EXISTS worktrees (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                target_branch TEXT,
                source_type TEXT NOT NULL DEFAULT 'branch',
                pr_number INTEGER,
                pr_status TEXT,
                ci_status TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);

            CREATE TABLE IF NOT EXISTS agent_tab_cache (
                tab_id TEXT PRIMARY KEY,
                worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                cwd TEXT NOT NULL,
                sdk_session_id TEXT,
                model TEXT NOT NULL DEFAULT '',
                effort TEXT NOT NULL DEFAULT 'high',
                permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
                status TEXT NOT NULL DEFAULT 'done',
                cost_json TEXT,
                messages_json TEXT NOT NULL DEFAULT '[]',
                tab_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agent_tab_cache_worktree ON agent_tab_cache(worktree_id);",
        )?;

        // Migrations (ignore errors if columns already exist)
        let _ = conn.execute("ALTER TABLE projects ADD COLUMN base_branch TEXT NOT NULL DEFAULT 'main'", []);
        let _ = conn.execute("ALTER TABLE worktrees ADD COLUMN target_branch TEXT", []);
        let _ = conn.execute("ALTER TABLE projects ADD COLUMN pr_create_skill TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE projects ADD COLUMN claude_command TEXT NOT NULL DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE agent_tab_cache ADD COLUMN extended_context INTEGER NOT NULL DEFAULT 0", []);
        let _ = conn.execute("ALTER TABLE agent_tab_cache ADD COLUMN concise_mode INTEGER NOT NULL DEFAULT 0", []);

        Ok(())
    }

    // ── Projects ──

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, local_path, github_remote, base_branch, setup_scripts, build_command, run_command, env_files, pr_create_skill, claude_command, created_at
             FROM projects ORDER BY name"
        )?;

        let rows = stmt.query_map([], |row| {
            let setup_scripts_json: String = row.get(5)?;
            let env_files_json: String = row.get(8)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                local_path: row.get(2)?,
                github_remote: row.get(3)?,
                base_branch: row.get(4)?,
                setup_scripts: serde_json::from_str(&setup_scripts_json).unwrap_or_default(),
                build_command: row.get(6)?,
                run_command: row.get(7)?,
                env_files: serde_json::from_str(&env_files_json).unwrap_or_default(),
                pr_create_skill: row.get(9)?,
                claude_command: row.get(10)?,
                created_at: row.get(11)?,
            })
        })?;

        rows.collect()
    }

    pub fn create_project(&self, data: &ProjectFormData) -> Result<Project> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let setup_scripts_json = serde_json::to_string(&data.setup_scripts).unwrap();
        let env_files_json = serde_json::to_string(&data.env_files).unwrap();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO projects (id, name, local_path, github_remote, base_branch, setup_scripts, build_command, run_command, env_files, pr_create_skill, claude_command, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![id, data.name, data.local_path, data.github_remote, data.base_branch, setup_scripts_json, data.build_command, data.run_command, env_files_json, data.pr_create_skill, data.claude_command, now],
        )?;

        Ok(Project {
            id,
            name: data.name.clone(),
            local_path: data.local_path.clone(),
            github_remote: data.github_remote.clone(),
            base_branch: data.base_branch.clone(),
            setup_scripts: data.setup_scripts.clone(),
            build_command: data.build_command.clone(),
            run_command: data.run_command.clone(),
            env_files: data.env_files.clone(),
            pr_create_skill: data.pr_create_skill.clone(),
            claude_command: data.claude_command.clone(),
            created_at: now,
        })
    }

    pub fn update_project(&self, id: &str, data: &ProjectFormData) -> Result<Project> {
        let setup_scripts_json = serde_json::to_string(&data.setup_scripts).unwrap();
        let env_files_json = serde_json::to_string(&data.env_files).unwrap();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name=?1, local_path=?2, github_remote=?3, base_branch=?4, setup_scripts=?5, build_command=?6, run_command=?7, env_files=?8, pr_create_skill=?9, claude_command=?10
             WHERE id=?11",
            params![data.name, data.local_path, data.github_remote, data.base_branch, setup_scripts_json, data.build_command, data.run_command, env_files_json, data.pr_create_skill, data.claude_command, id],
        )?;

        // Fetch updated record
        let mut stmt = conn.prepare(
            "SELECT id, name, local_path, github_remote, base_branch, setup_scripts, build_command, run_command, env_files, pr_create_skill, claude_command, created_at FROM projects WHERE id=?1"
        )?;
        stmt.query_row(params![id], |row| {
            let setup_scripts_json: String = row.get(5)?;
            let env_files_json: String = row.get(8)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                local_path: row.get(2)?,
                github_remote: row.get(3)?,
                base_branch: row.get(4)?,
                setup_scripts: serde_json::from_str(&setup_scripts_json).unwrap_or_default(),
                build_command: row.get(6)?,
                run_command: row.get(7)?,
                env_files: serde_json::from_str(&env_files_json).unwrap_or_default(),
                pr_create_skill: row.get(9)?,
                claude_command: row.get(10)?,
                created_at: row.get(11)?,
            })
        })
    }

    pub fn delete_project(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM projects WHERE id=?1", params![id])?;
        Ok(())
    }

    // ── Worktrees ──

    pub fn list_worktrees(&self, project_id: &str) -> Result<Vec<Worktree>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, project_id, name, path, branch, target_branch, source_type, pr_number, pr_status, ci_status, pinned, archived, created_at
             FROM worktrees WHERE project_id=?1 ORDER BY pinned DESC, created_at DESC"
        )?;

        let rows = stmt.query_map(params![project_id], |row| {
            Ok(Worktree {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                branch: row.get(4)?,
                target_branch: row.get(5)?,
                source_type: row.get(6)?,
                pr_number: row.get(7)?,
                pr_status: row.get(8)?,
                ci_status: row.get(9)?,
                pinned: row.get(10)?,
                archived: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?;

        rows.collect()
    }

    pub fn create_worktree(
        &self,
        project_id: &str,
        name: &str,
        path: &str,
        branch: &str,
        source_type: &str,
    ) -> Result<Worktree> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO worktrees (id, project_id, name, path, branch, source_type, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, project_id, name, path, branch, source_type, now],
        )?;

        Ok(Worktree {
            id,
            project_id: project_id.to_string(),
            name: name.to_string(),
            path: path.to_string(),
            branch: branch.to_string(),
            target_branch: None,
            source_type: source_type.to_string(),
            pr_number: None,
            pr_status: None,
            ci_status: None,
            pinned: false,
            archived: false,
            created_at: now,
        })
    }

    pub fn set_worktree_target_branch(&self, id: &str, target_branch: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE worktrees SET target_branch=?1 WHERE id=?2", params![target_branch, id])?;
        Ok(())
    }

    pub fn rename_worktree(&self, id: &str, name: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE worktrees SET name=?1 WHERE id=?2", params![name, id])?;
        Ok(())
    }

    pub fn delete_worktree(&self, id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM worktrees WHERE id=?1", params![id])?;
        Ok(())
    }

    // ── Agent Tab Cache ──

    pub fn save_agent_tab_cache(&self, tab: &AgentTabCache) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO agent_tab_cache (tab_id, worktree_id, label, cwd, sdk_session_id, model, effort, permission_mode, status, cost_json, messages_json, tab_order, extended_context, concise_mode, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                tab.tab_id,
                tab.worktree_id,
                tab.label,
                tab.cwd,
                tab.sdk_session_id,
                tab.model,
                tab.effort,
                tab.permission_mode,
                tab.status,
                tab.cost_json,
                tab.messages_json,
                tab.tab_order,
                tab.extended_context,
                tab.concise_mode,
                tab.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_agent_tab_cache(&self, worktree_id: &str) -> Result<Vec<AgentTabCache>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT tab_id, worktree_id, label, cwd, sdk_session_id, model, effort, permission_mode, status, cost_json, messages_json, tab_order, extended_context, concise_mode, created_at
             FROM agent_tab_cache WHERE worktree_id=?1 ORDER BY tab_order ASC"
        )?;

        let rows = stmt.query_map(params![worktree_id], |row| {
            Ok(AgentTabCache {
                tab_id: row.get(0)?,
                worktree_id: row.get(1)?,
                label: row.get(2)?,
                cwd: row.get(3)?,
                sdk_session_id: row.get(4)?,
                model: row.get(5)?,
                effort: row.get(6)?,
                permission_mode: row.get(7)?,
                status: row.get(8)?,
                cost_json: row.get(9)?,
                messages_json: row.get(10)?,
                tab_order: row.get(11)?,
                extended_context: row.get(12)?,
                concise_mode: row.get(13)?,
                created_at: row.get(14)?,
            })
        })?;

        rows.collect()
    }

    pub fn delete_agent_tab_cache(&self, tab_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agent_tab_cache WHERE tab_id=?1", params![tab_id])?;
        Ok(())
    }

    pub fn delete_agent_tab_cache_for_worktree(&self, worktree_id: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM agent_tab_cache WHERE worktree_id=?1", params![worktree_id])?;
        Ok(())
    }

    /// Delete agent tab cache entries older than the given number of days.
    /// Returns the number of rows deleted.
    pub fn purge_old_agent_tab_cache(&self, max_age_days: u32) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let deleted = conn.execute(
            "DELETE FROM agent_tab_cache WHERE created_at < datetime('now', '-' || ?1 || ' days')",
            params![max_age_days],
        )?;
        Ok(deleted)
    }
}
