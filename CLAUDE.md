# Coppice - Development Guidelines

## Cross-Platform Requirement

**All changes MUST work on Windows, Linux, and macOS.** This is non-negotiable.

- Rust backend: use `#[cfg(target_os = "...")]` blocks when platform-specific behavior is needed. Always handle all three: `windows`, `linux`, `macos`. See `src-tauri/src/commands/external.rs` for the established pattern.
- File paths: use `std::path::PathBuf` / `dirs` crate for platform-appropriate paths. Never hardcode `/` or `\` separators.
- Shell commands: use `services::shell_env::user_command()` to spawn child processes — it handles PATH resolution and Linux AppImage env cleanup. On Windows, shell commands may need `cmd /c` wrapping.
- PTY: the `portable-pty` crate abstracts platform differences. Shell selection is Windows (pwsh > powershell.exe > cmd.exe) vs Unix ($SHELL > /bin/bash). See `services/pty_manager.rs`.
- Frontend: avoid platform assumptions in TypeScript. Use Tauri APIs for filesystem/OS interactions, not browser APIs.
- Test on CI: the build matrix covers macOS (ARM + x86), Ubuntu 22.04, and Windows. If your change touches platform-specific code, verify all matrix targets pass.

## Project Overview

Coppice is a Tauri 2 desktop app for managing Git worktrees, terminals, and development workflows. It ships on macOS, Linux, and Windows.

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4 |
| State management | Zustand 5 |
| Terminal emulator | xterm.js 6 |
| Diff viewer | Monaco Editor |
| Backend | Rust (2021 edition) |
| Database | SQLite via rusqlite (bundled, WAL mode) |
| PTY | portable-pty |
| Git/GitHub | shells out to `git` and `gh` CLI |

## Architecture

### Frontend → Backend IPC

All backend calls go through `src/lib/commands.ts` which wraps `@tauri-apps/api invoke()`. Commands return `Promise<T>`. Errors are strings.

PTY output streams via Tauri events (`pty-output-{sessionId}`, `pty-exit-{sessionId}`).

### Backend Command Pattern

Tauri commands live in `src-tauri/src/commands/`. Each is an async function tagged with `#[tauri::command]` that takes `State<'_, T>` for database/pty/settings access. Returns `Result<T, String>`. New commands must be registered in `src-tauri/src/lib.rs` in the `invoke_handler` list.

### State Management

Single Zustand store in `src/stores/appStore.ts`. State is organized by concern: projects, worktrees, UI state, per-worktree sessions (tabs, runners).

### Terminal Architecture

Terminals render off-screen and are reparented into the visible UI on demand. Runner terminals live at position -9999,-9999. This preserves terminal state across tab switches.

## Development

```bash
npx tauri dev       # Dev mode with hot reload (Vite on :1420)
npx tauri build     # Production build
npm run build       # Frontend only (TypeScript check + Vite)
```

## Conventions

### TypeScript
- Strict mode (`strict: true`, `noUnusedLocals`, `noUnusedParameters`)
- Functional components with hooks
- PascalCase for component files, camelCase for utilities
- No `I` prefix on interfaces

### Rust
- `snake_case` functions/modules, `PascalCase` structs
- All IPC structs derive `Debug, Clone, Serialize, Deserialize`
- Errors propagated with `?` and converted to `String` at command boundary
- Shared state via `Arc<Mutex<T>>`
- Use `services::shell_env::user_command()` for spawning processes that need the user's PATH

### Git
- All git operations shell out to `git`/`gh` CLI (no libgit2)
- Version in three places: `package.json`, `Cargo.toml`, `tauri.conf.json` — kept in sync by auto-release CI

## Data Storage

- Database: `~/.local/share/coppice/coppice.db` (Linux), platform equivalent via `dirs` crate
- Settings: `~/.local/share/coppice/settings.toml`
- Schema migrations use `ALTER TABLE` in `src-tauri/src/db/mod.rs`

## CI/CD

- GitHub Actions builds on: macOS ARM64, macOS x86_64, Ubuntu 22.04, Windows
- Auto-release on push to main: bumps patch version, tags, builds, creates GitHub release
- Artifacts: `.dmg` (macOS), `.deb`/`.AppImage` (Linux), `.msi`/`.exe` (Windows)
