# Coppice

Tauri 2 desktop app for Git worktrees, terminals, and dev workflows. Ships on macOS, Linux, Windows.

**All changes MUST work cross-platform (Windows, Linux, macOS).**

## Stack

Frontend: React 19, TypeScript, Vite, Tailwind 4, Zustand 5, xterm.js 6, Monaco Editor
Backend: Rust 2021, SQLite (rusqlite bundled WAL), portable-pty
Git: shells out to `git`/`gh` CLI (no libgit2)

## Key Patterns

- IPC: `src/lib/commands.ts` wraps `invoke()`. PTY streams via events (`pty-output-{id}`, `pty-exit-{id}`).
- Commands: `src-tauri/src/commands/` — `#[tauri::command]` async fns, `State<'_, T>`, return `Result<T, String>`. Register in `src-tauri/src/lib.rs` invoke_handler.
- Store: single Zustand store `src/stores/appStore.ts`.
- Terminals: render off-screen at -9999,-9999, reparented on demand.
- IPC structs: derive `Debug, Clone, Serialize, Deserialize`.
- State: `Arc<Mutex<T>>`.
- Processes: use `services::shell_env::user_command()` for child processes (handles PATH + AppImage env).
- Migrations: `ALTER TABLE` in `src-tauri/src/db/mod.rs`.

## Cross-Platform Rules

- Platform-specific: `#[cfg(target_os = "...")]` for all three. See `commands/external.rs`.
- Paths: `PathBuf` / `dirs` crate. Never hardcode separators.
- PTY shell: Windows (pwsh > powershell.exe > cmd.exe), Unix ($SHELL > /bin/bash). See `services/pty_manager.rs`.
- Frontend: Tauri APIs for filesystem/OS, not browser APIs.

## Dev Commands

```
npx tauri dev       # Dev (Vite :1420)
npx tauri build     # Production
npm run build       # Frontend only
```

## Conventions

- TS: strict mode, functional components, PascalCase components, camelCase utils, no `I` prefix
- Rust: snake_case fns, PascalCase structs, `?` → `String` at boundary
- Version in `package.json`, `Cargo.toml`, `tauri.conf.json` — synced by CI

## Storage

DB: `~/.local/share/coppice/coppice.db` (Linux; platform equiv via `dirs`). Settings: `settings.toml` same dir.

## CI

GitHub Actions: macOS ARM64/x86_64, Ubuntu 22.04, Windows. Auto-release on main push.
