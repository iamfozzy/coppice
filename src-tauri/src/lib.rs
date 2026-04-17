mod commands;
mod db;
mod models;
mod services;
mod settings;

use db::Database;
use services::agent_manager::AgentManager;
use services::pty_manager::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let database = Database::new().expect("Failed to initialize database");
    let pty_manager = PtyManager::new();
    let agent_manager = AgentManager::new();
    let settings_state = settings::SettingsState::new();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(database)
        .manage(pty_manager)
        .manage(agent_manager)
        .manage(settings_state)
        .invoke_handler(tauri::generate_handler![
            // Project commands
            commands::project::list_projects,
            commands::project::create_project,
            commands::project::update_project,
            commands::project::delete_project,
            // Worktree commands
            commands::worktree::list_worktrees,
            commands::worktree::create_worktree,
            commands::worktree::create_worktree_new_branch,
            commands::worktree::set_worktree_target_branch,
            commands::worktree::rename_worktree,
            commands::worktree::delete_worktree,
            commands::worktree::list_branches,
            commands::worktree::get_current_branch,
            commands::worktree::get_git_status,
            commands::worktree::get_file_content,
            commands::worktree::get_merge_base,
            commands::worktree::get_file_diff,
            commands::worktree::get_pr_diff_files,
            commands::worktree::get_pr_file_diff,
            commands::worktree::get_unpushed_count,
            commands::worktree::revert_file,
            commands::worktree::update_base_branch,
            // Terminal commands
            commands::terminal::terminal_spawn,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_exists,
            commands::terminal::terminal_kill,
            // GitHub commands
            commands::github::get_pr_for_branch,
            commands::github::create_pr,
            commands::github::get_failed_action_logs,
            commands::github::get_pr_comments,
            commands::github::resolve_pr_comment,
            commands::github::github_auth_status,
            commands::github::github_auth_login,
            commands::github::github_auth_logout,
            // Settings commands
            commands::settings::get_settings,
            commands::settings::update_settings,
            // External tool commands
            commands::external::open_in_editor,
            commands::external::open_worktree_file_in_editor,
            commands::external::open_in_terminal,
            commands::external::open_in_finder,
            // Agent commands
            commands::agent::agent_start,
            commands::agent::agent_send_input,
            commands::agent::agent_interrupt,
            commands::agent::agent_tool_response,
            commands::agent::agent_ask_response,
            commands::agent::agent_set_model,
            commands::agent::agent_set_permission_mode,
            commands::agent::agent_list_commands,
            commands::agent::agent_close,
            commands::agent::agent_exists,
            commands::agent::agent_check_available,
            // Agent tab cache commands
            commands::agent_tab_cache::save_agent_tab_cache,
            commands::agent_tab_cache::list_agent_tab_cache,
            commands::agent_tab_cache::delete_agent_tab_cache,
            commands::agent_tab_cache::delete_agent_tab_cache_for_worktree,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
