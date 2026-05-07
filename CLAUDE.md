# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Coppice

Tauri 2 desktop app for Git worktrees, terminals, and dev workflows. Ships on macOS, Linux, Windows.

**All changes MUST work cross-platform (Windows, Linux, macOS).**

## Stack

Frontend: React 19, TypeScript, Vite 8, Tailwind 4, Zustand 5, xterm.js 6, Monaco Editor
Backend: Rust 2021, SQLite (rusqlite bundled WAL), portable-pty
Git: shells out to `git`/`gh` CLI (no libgit2)
Agent: Node.js bridge subprocess running `@anthropic-ai/claude-agent-sdk` via JSON-line stdio protocol

## Dev Commands

```
npm install             # Install all (postinstall: agent-bridge deps, sidecars)
npx tauri dev           # Dev mode (Vite :1420 + Tauri window, hot reload)
npx tauri build         # Production build (frontend + Rust, outputs platform bundles)
npm run build           # Frontend only (tsc + vite build)
```

## Architecture

### IPC Flow

```
React (invoke) → Tauri commands (Rust) → Result<T, String> → React
React (listen) ← Tauri events (Rust)  ← pty-output-{id}, agent-event-{id}
```

- `src/lib/commands.ts` wraps all `invoke()` calls — every IPC function is here.
- `src-tauri/src/commands/` — `#[tauri::command]` async fns, access state via `State<'_, T>`, return `Result<T, String>`. Register in `src-tauri/src/lib.rs` invoke_handler.
- PTY streams via events (`pty-output-{id}`, `pty-exit-{id}`). Agent streams via `agent-event-{id}`.

### Agent Bridge (Node.js Subprocess)

The agent runs in an isolated Node.js process (`src-tauri/resources/agent-bridge/bridge.mjs`, ~1300 lines) communicating with Rust via JSON lines on stdin/stdout:

- **Rust → Node (stdin)**: `{ type: "start" | "input" | "set_model" | "tool_response" | "ask_response", ... }`
- **Node → Rust (stdout)**: `{ type: "init" | "assistant" | "partial" | "tool_use" | "tool_result" | "tool_permission" | "result" | "error", ... }`
- Bridge is **reusable** — send a new `start` command to an existing bridge to resume a session.
- `AgentManager` (`services/agent_manager.rs`) spawns and tracks bridge processes per session.
- Coppice IDE tools (worktree, terminal, file opening) are registered as MCP tools in the bridge via `createSdkMcpServer()`. Tool calls for these are intercepted by Rust and executed locally.

### State Management

Single Zustand store `src/stores/appStore.ts` with key slices:
- `worktreesByProject` — Project → Worktree[]
- `tabsByWorktree` — Worktree → Tab[] (terminal, agent, diff, scratchpad tabs)
- `agentSessionByTab` — Tab → AgentSessionState (messages, status, model, cost)
- `runnersByWorktree` — Worktree → Runner[] (off-screen terminal pool)
- `appSettings` — Global settings

Agent tab state persists to SQLite via debounced saves (500ms). Trace events persist separately (lazy-loaded).

### Terminal Management

- `PtyManager` (`services/pty_manager.rs`) holds `HashMap<String, PtySession>`.
- PTY output buffered at 50ms intervals, emitted as Tauri events.
- Terminal xterm.js instances render off-screen at position -9999,-9999, reparented into visible DOM on tab switch.
- Cross-platform shell: Windows (pwsh > powershell.exe > cmd.exe), Unix ($SHELL > /bin/bash).

### Database

SQLite WAL mode, foreign keys ON. Schema and migrations in `src-tauri/src/db/mod.rs`.
- `projects` — project metadata, commands, settings
- `worktrees` — branch, PR info, status, linked to project
- `agent_tab_cache` — full agent session state (messages JSON, trace JSON, cost JSON)

Migrations use `ALTER TABLE ADD COLUMN` with defaults. Location: `~/.local/share/coppice/coppice.db` (platform equiv via `dirs` crate).

### Settings

TOML file at `~/.local/share/coppice/settings.toml` (`src-tauri/src/settings.rs`).
Includes: terminal config, theme, agent defaults (model, effort, permission mode), API keys, base URLs for LiteLLM proxy, MCP server configs, tool output limits.

## Key Patterns

- **IPC structs**: derive `Debug, Clone, Serialize, Deserialize`.
- **Shared state**: `Arc<Mutex<T>>` managed by Tauri.
- **Child processes**: always use `services::shell_env::user_command()` — resolves login shell PATH, strips AppImage LD_LIBRARY_PATH pollution, handles sidecar resolution.
- **Sidecar binaries**: Node.js and `gh` CLI bundled as `coppice-node-*` / `coppice-gh-*` per target triple. Resolved by `shell_env.rs` (check exe dir first, fallback to PATH).
- **Agent permissions**: Three modes in bridge.mjs — `bypassPermissions` (auto-allow all), `acceptEdits` (auto-allow file ops + safe bash), `default` (prompt frontend for dangerous ops).

## Cross-Platform Rules

- Platform-specific code: `#[cfg(target_os = "...")]` for all three OSes. See `commands/external.rs` for examples.
- Paths: `PathBuf` / `dirs` crate. Never hardcode separators.
- Windows: `CREATE_NO_WINDOW` flag on child processes to hide console windows.
- Frontend: Tauri APIs for filesystem/OS access, not browser APIs.

## Conventions

- **TS**: strict mode, functional components, PascalCase components, camelCase utils, no `I` prefix on interfaces.
- **Rust**: snake_case fns, PascalCase structs, `?` operator with `.map_err(|e| e.to_string())?` at command boundaries.
- **Version**: kept in sync across `package.json`, `Cargo.toml`, `tauri.conf.json` — CI auto-syncs.
- **Adding a new command**: implement in `commands/*.rs`, register in `lib.rs` invoke_handler, add invoke wrapper in `commands.ts`.

## CI

GitHub Actions: macOS ARM64 + x86_64, Ubuntu 22.04, Windows. Auto-release on tag push. Outputs: .dmg/.app (macOS), .deb/.AppImage (Linux), .msi/.exe (Windows).
