<img alt="Coppice screenshot" src="docs/screenshot.png" />


# Coppice

A desktop app for managing Git worktrees, AI agent sessions, and development workflows in a unified interface. Built with Tauri v2, React, and Rust.

Coppice lets you work across multiple Git worktrees simultaneously, each with its own terminal sessions, AI agent tabs (Claude Agent SDK or Pi Agent), diff viewers, and configurable runners — all in one window.

## Installation

Download the latest build from [GitHub Actions](https://github.com/iamfozzy/coppice/actions) artifacts or [Releases](https://github.com/iamfozzy/coppice/releases).

### macOS — "App is damaged" fix

Since the app is not code-signed, macOS quarantines downloaded apps. After extracting, run:

```sh
xattr -cr /Applications/Coppice.app
```

Then open Coppice normally. You only need to do this once.

### Windows — SmartScreen warning

Since the app is not code-signed, Windows SmartScreen may block it on first launch. When you see the "Windows protected your PC" dialog, click **More info** then **Run anyway**. You only need to do this once.

## Features

### Worktree Management
- Create worktrees from existing or new branches
- Rename, pin, archive, and delete worktrees
- Live branch status polling (3-second intervals)
- Automatic `git worktree prune` before operations

### Integrated Terminal
- Full PTY-backed terminal sessions via xterm.js
- Per-worktree terminal tabs (unlimited)
- Cross-platform shell support (respects `$SHELL` on macOS/Linux, PowerShell on Windows)
- Unicode rendering for Claude Code UI elements
- Buffered output streaming (50ms flush interval) for smooth rendering

### Configurable Runners
- Define setup, build, and run commands per project
- Runners persist across worktree switches via an off-screen terminal pool
- Live status indicators (running/stopped/idle)
- Auto-run setup scripts on new worktree creation

### GitHub Integration
- Fetch PR status and check runs for any branch
- Create PRs directly from the app
- View failed CI logs inline
- CI status badges on worktree entries
- `gh` CLI is bundled with every release — sign in via **App Settings → GitHub** (no separate install required)

### File Diff Viewer
- Side-by-side diffs powered by Monaco Editor
- Two modes: uncommitted changes (HEAD vs working tree) and PR diffs (merge-base vs HEAD)
- Syntax highlighting for 20+ languages

### External Tool Launchers
- Open worktree in VS Code, native terminal, or file manager
- Cross-platform support (Finder/Explorer/xdg-open)

### Agent Backends
- **Claude Agent SDK** sessions are powered by [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and use the `bridge.mjs` Node bridge.
- **Pi Agent** sessions are powered by [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) via `pi-bridge.mjs`.
- Pi Agent supports provider/model selection across many LLM providers (Claude, OpenAI, Gemini, DeepSeek, Mistral, Groq, xAI, OpenRouter, GitHub Copilot, and more), optional web search/fetch tools via `pi-web-access`, and a `subagent` tool for parallel or isolated child-agent work.
- Both backends use a bundled Node "agent bridge" process (`src-tauri/resources/agent-bridge/`) over a JSON-line stdin/stdout protocol — one bridge process per agent session.
- Rust backend (`src-tauri/src/commands/agent.rs`) chooses the bridge, spawns/manages lifecycles, and handles tool-use, permission, and user-question round-trips with the frontend.
- Bridge dependencies install automatically via the root `postinstall` script, so `npm install` in the repo root is all you need.
- Node.js and `gh` binaries are bundled as Tauri sidecars (`src-tauri/binaries/coppice-node-*`, `coppice-gh-*`) so the packaged app has no external runtime dependencies. `npm install` downloads them for the host platform via `scripts/download-sidecars.mjs`; CI re-runs it per target triple.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Tauri 2 |
| Frontend | React 19, TypeScript, Vite 8 |
| Styling | Tailwind CSS 4 |
| State | Zustand 5 |
| Terminal | xterm.js 6 |
| Diff Editor | Monaco Editor |
| Backend | Rust (2021 edition) |
| Database | SQLite via rusqlite (WAL mode) |
| PTY | portable-pty |
| GitHub | `gh` CLI |
| Agents | Claude Agent SDK, Pi Coding Agent |

## Project Structure

```
├── src/                          # React frontend
│   ├── components/
│   │   ├── Sidebar/              # Project tree, changes panel, runners
│   │   ├── WorktreeView/         # Worktree header & tab bar
│   │   ├── Terminal/             # xterm.js terminal wrapper
│   │   ├── DiffViewer/           # Monaco diff editor
│   │   ├── PRStatus/             # GitHub PR info panel
│   │   ├── AgentView/            # Claude/Pi agent UI
│   │   └── ProjectSettings/      # Project configuration modal
│   ├── stores/appStore.ts        # Global state (Zustand)
│   ├── lib/commands.ts           # Tauri IPC wrappers
│   └── lib/types.ts              # Shared TypeScript types
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── commands/
│   │   │   ├── project.rs        # Project CRUD
│   │   │   ├── worktree.rs       # Git worktree operations
│   │   │   ├── terminal.rs       # PTY spawn/write/resize/kill
│   │   │   ├── github.rs         # PR status, CI logs, PR creation
│   │   │   ├── agent.rs          # Claude/Pi agent bridge commands
│   │   │   └── external.rs       # VS Code, terminal, file manager
│   │   ├── db/mod.rs             # SQLite schema & queries
│   │   ├── models/mod.rs         # Project, Worktree structs
│   │   └── services/pty_manager.rs # PTY lifecycle & output streaming
│   ├── resources/agent-bridge/   # Claude and Pi Node bridge scripts
│   ├── Cargo.toml
│   └── tauri.conf.json
└── .github/workflows/build.yml   # Multi-platform CI
```

## Prerequisites

- **Node.js** 20+
- **Rust** (via [rustup](https://rustup.rs))
- **`gh` CLI** (for GitHub features) — [install](https://cli.github.com)

### Platform-specific

**macOS:** Xcode Command Line Tools
```sh
xcode-select --install
```

**Linux (Ubuntu/Debian):**
```sh
sudo apt-get install -y \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

**Windows:** C++ Build Tools (via Visual Studio Installer)

## Development

```sh
# Install dependencies
npm install

# Start dev server with hot reload
npx tauri dev
```

This launches Vite on `http://localhost:1420` and opens the Tauri window with live frontend reloading.

### Build

```sh
# Production build
npx tauri build

# Build for specific target
npx tauri build --target aarch64-apple-darwin
```

Bundles are output to `src-tauri/target/release/bundle/`.

## CI/CD

GitHub Actions builds on every push to `main` and on tags:

| Platform | Target |
|----------|--------|
| macOS | `aarch64-apple-darwin` (Apple Silicon) |
| macOS | `x86_64-apple-darwin` (Intel) |
| Ubuntu 22.04 | native |
| Windows | native |

Build artifacts (`.dmg`, `.app`, `.deb`, `.AppImage`, `.msi`, `.exe`) are uploaded as workflow artifacts. Tagged pushes (`v*`) create draft GitHub releases.

## Architecture Notes

- **Per-worktree isolation** — Each worktree gets its own set of tabs (terminal, agent, diff) and runners, stored in `tabsByWorktree` and `runnersByWorktree` maps.
- **Terminal pool** — Runner terminals are rendered off-screen and reparented into the visible UI on demand, preserving terminal state across tab switches.
- **Event-driven PTY** — Output streams via Tauri events (`pty-output-{sessionId}`) rather than polling. A dedicated flush thread batches output every 50ms.
- **SQLite with WAL** — Database uses Write-Ahead Logging for concurrent read/write. Foreign keys enabled with cascading deletes on worktrees.
- **Git CLI** — All git operations shell out to `git` / `gh` directly (no libgit2), keeping the dependency surface small and behavior consistent with the user's git config.
- **Agent bridge subprocess** — Each Claude Agent SDK or Pi Agent session runs in its own Node subprocess, isolated from the main app. Communication is line-delimited JSON over stdio, letting the Rust backend drive JavaScript agent SDKs without embedding a JS runtime.

## Using Pi Agent

Coppice can use Pi Agent as an alternative to the Claude Agent SDK backend.

1. Open **App Settings → Agent mode** and choose **Pi Agent**.
2. Add one or more providers under **Providers & Authentication**.
3. Authenticate with either an API key or OAuth where supported (Anthropic, GitHub Copilot, OpenAI Codex). OAuth credentials are stored in `~/.pi/agent/auth.json`.
4. Pick the default provider/model and thinking level, then save.

Pi Agent tabs use the same Coppice UI as Claude tabs, including permission prompts, image attachments, persisted session history, slash commands, and IDE tools such as opening files, creating worktrees, and spawning terminals. Pi-specific options include:

- **Web access** — optional `web_search` and `fetch_content` tools via `pi-web-access`.
- **Subagents** — delegate focused research, implementation, or review work to isolated child agents.
- **Provider-scoped models** — model selections use `provider/model` names (for example `openai/gpt-4o` or `google/gemini-2.5-pro`).

## Using Non-Claude Models via LiteLLM

Coppice can route custom model selections (e.g. GPT-4o, Gemini) through a [LiteLLM](https://docs.litellm.ai/) proxy while keeping Claude models on the direct Anthropic API.

### 1. Set up LiteLLM

```sh
pip install 'litellm[proxy]'
```

Create a `config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: o4-mini
    litellm_params:
      model: openai/o4-mini
      api_key: os.environ/OPENAI_API_KEY
```

Start the proxy:

```sh
export OPENAI_API_KEY="sk-..."
litellm --config config.yaml
```

The proxy runs on `http://localhost:4000` by default.

### 2. Configure Coppice

Open **App Settings** and set:

| Setting | Value |
|---------|-------|
| **Anthropic API key** | Your Anthropic key (for Claude models) |
| **Base URL** | `http://localhost:4000` |
| **Use proxy for custom models only** | Enable this toggle |

With this setup, selecting a Claude model (e.g. Sonnet 4.6) routes directly to Anthropic, while typing a custom model name in the model picker (e.g. `gpt-4o`) routes through LiteLLM.

### 3. Select a custom model

In the agent toolbar model picker, click **Custom model...** and enter the `model_name` from your LiteLLM config (e.g. `gpt-4o`). The proxy handles authentication with the upstream provider.

> **Note:** The agentic flow (tool use, extended thinking) relies on Claude-specific features. Non-Claude models work for chat but some agent capabilities may be limited.

## License

MIT
