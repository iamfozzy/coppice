mod commands;
mod db;
mod models;
mod services;
mod settings;

use db::Database;
use services::claude_hooks::ClaudeHookWatcher;
use services::pty_manager::PtyManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let database = Database::new().expect("Failed to initialize database");
    let pty_manager = PtyManager::new();
    let settings_state = settings::SettingsState::new();

    // Ensure the hook directory exists and clean up stale status files
    // from previous sessions (crash recovery).
    services::claude_hooks::init_hook_dir();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Start the filesystem watcher that bridges Claude Code hook
            // signals into Tauri events for the frontend.
            match ClaudeHookWatcher::new(app.handle()) {
                Ok(watcher) => {
                    // Store in managed state so it lives for the app's lifetime.
                    app.manage(watcher);
                }
                Err(e) => {
                    eprintln!("Warning: failed to start Claude hook watcher: {}", e);
                    // Non-fatal — heuristic detection still works without hooks.
                }
            }
            Ok(())
        })
        .manage(database)
        .manage(pty_manager)
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
            // Settings commands
            commands::settings::get_settings,
            commands::settings::update_settings,
            // Claude hooks commands
            commands::claude_hooks::check_claude_hooks_installed,
            commands::claude_hooks::install_claude_hooks,
            commands::claude_hooks::uninstall_claude_hooks,
            // External tool commands
            commands::external::open_in_editor,
            commands::external::open_in_terminal,
            commands::external::open_in_finder,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
