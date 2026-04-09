use rusqlite::{Connection, Result, params};
use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::{Project, ProjectFormData, Worktree};

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
                setup_scripts TEXT NOT NULL DEFAULT '[]',
                build_command TEXT NOT NULL DEFAULT '',
                run_command TEXT NOT NULL DEFAULT '',
                env_files TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS worktrees (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                branch TEXT NOT NULL,
                source_type TEXT NOT NULL DEFAULT 'branch',
                pr_number INTEGER,
                pr_status TEXT,
                ci_status TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_worktrees_project ON worktrees(project_id);",
        )?;
        Ok(())
    }

    // ── Projects ──

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, local_path, github_remote, setup_scripts, build_command, run_command, env_files, created_at
             FROM projects ORDER BY name"
        )?;

        let rows = stmt.query_map([], |row| {
            let setup_scripts_json: String = row.get(4)?;
            let env_files_json: String = row.get(7)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                local_path: row.get(2)?,
                github_remote: row.get(3)?,
                setup_scripts: serde_json::from_str(&setup_scripts_json).unwrap_or_default(),
                build_command: row.get(5)?,
                run_command: row.get(6)?,
                env_files: serde_json::from_str(&env_files_json).unwrap_or_default(),
                created_at: row.get(8)?,
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
            "INSERT INTO projects (id, name, local_path, github_remote, setup_scripts, build_command, run_command, env_files, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![id, data.name, data.local_path, data.github_remote, setup_scripts_json, data.build_command, data.run_command, env_files_json, now],
        )?;

        Ok(Project {
            id,
            name: data.name.clone(),
            local_path: data.local_path.clone(),
            github_remote: data.github_remote.clone(),
            setup_scripts: data.setup_scripts.clone(),
            build_command: data.build_command.clone(),
            run_command: data.run_command.clone(),
            env_files: data.env_files.clone(),
            created_at: now,
        })
    }

    pub fn update_project(&self, id: &str, data: &ProjectFormData) -> Result<Project> {
        let setup_scripts_json = serde_json::to_string(&data.setup_scripts).unwrap();
        let env_files_json = serde_json::to_string(&data.env_files).unwrap();

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE projects SET name=?1, local_path=?2, github_remote=?3, setup_scripts=?4, build_command=?5, run_command=?6, env_files=?7
             WHERE id=?8",
            params![data.name, data.local_path, data.github_remote, setup_scripts_json, data.build_command, data.run_command, env_files_json, id],
        )?;

        // Fetch updated record
        let mut stmt = conn.prepare(
            "SELECT id, name, local_path, github_remote, setup_scripts, build_command, run_command, env_files, created_at FROM projects WHERE id=?1"
        )?;
        stmt.query_row(params![id], |row| {
            let setup_scripts_json: String = row.get(4)?;
            let env_files_json: String = row.get(7)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                local_path: row.get(2)?,
                github_remote: row.get(3)?,
                setup_scripts: serde_json::from_str(&setup_scripts_json).unwrap_or_default(),
                build_command: row.get(5)?,
                run_command: row.get(6)?,
                env_files: serde_json::from_str(&env_files_json).unwrap_or_default(),
                created_at: row.get(8)?,
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
            "SELECT id, project_id, name, path, branch, source_type, pr_number, pr_status, ci_status, pinned, archived, created_at
             FROM worktrees WHERE project_id=?1 ORDER BY pinned DESC, created_at DESC"
        )?;

        let rows = stmt.query_map(params![project_id], |row| {
            Ok(Worktree {
                id: row.get(0)?,
                project_id: row.get(1)?,
                name: row.get(2)?,
                path: row.get(3)?,
                branch: row.get(4)?,
                source_type: row.get(5)?,
                pr_number: row.get(6)?,
                pr_status: row.get(7)?,
                ci_status: row.get(8)?,
                pinned: row.get(9)?,
                archived: row.get(10)?,
                created_at: row.get(11)?,
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
            source_type: source_type.to_string(),
            pr_number: None,
            pr_status: None,
            ci_status: None,
            pinned: false,
            archived: false,
            created_at: now,
        })
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
}
