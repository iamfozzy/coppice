use tauri::State;
use crate::db::Database;
use crate::models::AgentTabCache;

#[tauri::command]
pub fn save_agent_tab_cache(
    db: State<'_, Database>,
    tab: AgentTabCache,
) -> Result<(), String> {
    db.save_agent_tab_cache(&tab).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_agent_tab_cache(
    db: State<'_, Database>,
    worktree_id: String,
) -> Result<Vec<AgentTabCache>, String> {
    db.list_agent_tab_cache(&worktree_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_agent_tab_cache(
    db: State<'_, Database>,
    tab_id: String,
) -> Result<(), String> {
    db.delete_agent_tab_cache(&tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_agent_tab_cache_for_worktree(
    db: State<'_, Database>,
    worktree_id: String,
) -> Result<(), String> {
    db.delete_agent_tab_cache_for_worktree(&worktree_id).map_err(|e| e.to_string())
}
