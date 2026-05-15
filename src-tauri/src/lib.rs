mod commands;
mod db;
mod models;
mod services;
mod settings;

use db::Database;
use services::agent_manager::AgentManager;
use services::pty_manager::PtyManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let database = Database::new().expect("Failed to initialize database");

    // Purge agent tab cache entries older than 30 days
    match database.purge_old_agent_tab_cache(30) {
        Ok(n) if n > 0 => eprintln!("Purged {n} stale agent tab cache entries (>30 days old)"),
        Ok(_) => {}
        Err(e) => eprintln!("Warning: failed to purge old agent tab cache: {e}"),
    }
    let pty_manager = PtyManager::new();
    let agent_manager = AgentManager::new();
    let settings_state = settings::SettingsState::new();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
            commands::terminal::terminal_spawn_claude,
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
            commands::agent::pi_get_models,
            commands::agent::pi_oauth_login,
            commands::agent::pi_oauth_check,
            commands::agent::claude_auth_login,
            commands::agent::claude_auth_status,
            commands::agent::read_image_base64,
            commands::agent::get_project_commands,
            // Agent tab cache commands
            commands::agent_tab_cache::save_agent_tab_cache,
            commands::agent_tab_cache::list_agent_tab_cache,
            commands::agent_tab_cache::list_pinned_worktree_ids,
            commands::agent_tab_cache::count_agent_tab_caches,
            commands::agent_tab_cache::delete_agent_tab_cache,
            commands::agent_tab_cache::delete_agent_tab_cache_for_worktree,
            commands::agent_tab_cache::purge_old_agent_tab_cache,
            // MCP catalog + OAuth
            commands::mcp::mcp_get_catalog,
            commands::mcp::mcp_install_catalog_entry,
            commands::mcp::mcp_oauth_start,
            commands::mcp::mcp_oauth_revoke,
            commands::mcp::mcp_get_auth_status,
            commands::mcp::mcp_test_connection,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Spawn the MCP OAuth token refresh scheduler. This background thread
    // proactively refreshes tokens approaching expiry and pushes updated
    // headers to all running agent bridges so MCP connections don't 401.
    let scheduler_handle = app.handle().clone();
    std::thread::spawn(move || {
        services::mcp_token_scheduler::run(scheduler_handle);
    });

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Gracefully shut down all child processes to prevent orphans.
            let agent_mgr = handle.state::<AgentManager>();
            agent_mgr.close_all();
            let pty_mgr = handle.state::<PtyManager>();
            pty_mgr.close_all();
        }
    });
}
