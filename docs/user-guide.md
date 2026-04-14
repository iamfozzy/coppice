# Coppice User Guide

Coppice is a desktop application for managing Git worktrees, terminals, and AI-powered development workflows. It integrates with Claude Code to provide an all-in-one workspace for branching, building, reviewing PRs, and iterating on code.

![Coppice screenshot](screenshot.png)

---

## Table of Contents

- [Overview](#overview)
- [Layout](#layout)
- [Sidebar](#sidebar)
  - [Sidebar Header](#sidebar-header)
  - [Project Tree](#project-tree)
  - [Changes Panel](#changes-panel)
  - [Runners Panel](#runners-panel)
- [Main Area](#main-area)
  - [Worktree Header](#worktree-header)
  - [Tab Bar](#tab-bar)
  - [Terminal View](#terminal-view)
  - [Diff Viewer](#diff-viewer)
- [Modals & Dialogs](#modals--dialogs)
  - [App Settings](#app-settings)
  - [Project Settings](#project-settings)
  - [Create Worktree](#create-worktree)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Status Indicators](#status-indicators)
- [Drag & Drop](#drag--drop)

---

## Overview

Coppice organises your work around **projects** and **worktrees**. A project points at a Git repository. Worktrees are checked-out branches that live in separate directories, so you can work on multiple branches simultaneously without stashing or switching.

Each worktree gets its own set of terminal tabs (including Claude Code sessions), its own build/run runners, and its own PR status view.

---

## Layout

The interface is split into two main regions:

```
┌──────────────────────┬──────────────────────────────────────┐
│                      │                                      │
│      SIDEBAR         │           MAIN AREA                  │
│   (310–500px)        │         (flexible)                   │
│                      │                                      │
│  ┌────────────────┐  │  ┌────────────────────────────────┐  │
│  │ Sidebar Header │  │  │ Worktree Header                │  │
│  ├────────────────┤  │  ├────────────────────────────────┤  │
│  │                │  │  │ Tab Bar                        │  │
│  │ Project Tree   │  │  ├────────────────────────────────┤  │
│  │                │  │  │                                │  │
│  │                │  │  │                                │  │
│  ├────────────────┤  │  │  Terminal / Diff Viewer        │  │
│  │ Changes Panel  │  │  │                                │  │
│  │ (tabs)         │  │  │                                │  │
│  ├────────────────┤  │  │                                │  │
│  │ Runners        │  │  │                                │  │
│  └────────────────┘  │  └────────────────────────────────┘  │
└──────────────────────┴──────────────────────────────────────┘
```

The sidebar is **resizable** — drag its right edge to adjust width between 310px and 500px.

---

## Sidebar

### Sidebar Header

```
┌──────────────────────────────┐
│  🌿 Coppice        ⚙   +    │
└──────────────────────────────┘
```

| Element | Description |
|---------|-------------|
| **Coppice logo & name** | App branding in the top-left corner. |
| **⚙ Gear icon** | Opens [App Settings](#app-settings). Tooltip: *"App settings"*. |
| **+ Plus icon** | Opens the [Project Settings](#project-settings) dialog to add a new project. Tooltip: *"Add project"*. |

---

### Project Tree

The project tree is the main navigation panel. It lists all your projects, each containing its worktrees.

```
┌──────────────────────────────┐
│ ▶ Coppice                + ⋮ │  ← Project row
│   ┌──────────────────────┐   │
│   │ fix-readme-screenshot│←  │  ← Selected worktree
│   │  fix/readme-screenshot   │  ← Branch name
│   ├──────────────────────┤   │
│   │ fix-key-value-tabind │   │  ← Another worktree
│   │  fix/key-value-tabindex  │
│   └──────────────────────┘   │
└──────────────────────────────┘
```

#### Project Row

| Element | Description |
|---------|-------------|
| **▶ / ▼ Chevron** | Click to expand or collapse the project's worktree list. |
| **Project name** | The name you gave the project (e.g. "Coppice"). Click to expand/collapse. |
| **+ Button** | Opens the [Create Worktree](#create-worktree) dialog for this project. Tooltip: *"Add worktree"*. |
| **⋮ Button** | Opens [Project Settings](#project-settings) for this project. Tooltip: *"Project settings"*. |

#### Worktree Row

| Element | Description |
|---------|-------------|
| **Worktree name** | Display name of the worktree directory. **Double-click** to rename it inline. Press Enter to confirm or Escape to cancel. |
| **Branch name** | The Git branch checked out in this worktree, shown in monospace below the name. |
| **PR badge** | If a pull request exists for this branch, the PR number (e.g. `#9`) is shown next to the branch name. |
| **Claude indicator** | A coloured dot showing Claude Code status. See [Status Indicators](#status-indicators). |
| **Run indicator** | A green animated dot if the worktree's Run command is active. |
| **✕ Delete button** | Appears on hover. Deletes the worktree and removes the directory from disk. A confirmation dialog appears first. Tooltip: *"Delete worktree"*. |

---

### Changes Panel

The changes panel sits below the project tree and has three tabs:

```
┌──────────────────────────────┐
│  Changes  │  Files (5)  │ PR │   ← Tab bar
├──────────────────────────────┤
│                              │
│  (content for active tab)    │
│                              │
└──────────────────────────────┘
```

#### Changes Tab

Shows **uncommitted files** in the selected worktree (staged + unstaged).

| Element | Description |
|---------|-------------|
| **File list** | Each row shows a filename and a status badge. |
| **Status badge** | Colour-coded letter: **M** (modified, yellow), **A** (added, green), **D** (deleted, red), **R** (renamed, blue), **??** (untracked, gray). |
| **↵ Revert button** | Appears on hover over a file row. Reverts the file to its last committed state (tracked files) or deletes it (untracked files). A confirmation dialog appears first. |
| **Commit & Push button** | Shown at the top when there are uncommitted changes. Sends a commit instruction to a Claude Code tab. |
| **Push (N) button** | Shown when there are unpushed commits. The number indicates how many commits will be pushed. Sends a push instruction to Claude Code. |

Clicking a file opens its diff in the [Diff Viewer](#diff-viewer).

#### Files Tab

Shows **all files changed** compared to the target/base branch — the PR-level diff.

| Element | Description |
|---------|-------------|
| **File count** | Shown in the tab label, e.g. "Files (5)". |
| **File list** | Same format as Changes tab but compares against the base branch rather than uncommitted changes. |

Clicking a file opens its PR-level diff in the Diff Viewer.

#### PR Tab

Shows the **pull request status** for the current worktree's branch.

| Element | Description |
|---------|-------------|
| **PR state badge** | Coloured label showing the PR state: **OPEN** (green), **DRAFT** (gray), **MERGED** (purple), **CLOSED** (red). |
| **PR title & number** | Clickable — opens the PR on GitHub in your browser. |
| **🔄 Refresh button** | Manually re-fetches PR status, checks, and comments. Tooltip: *"Refresh"*. |
| **Merge conflict warning** | A yellow banner if the PR has merge conflicts. Includes a **"Resolve with Claude"** button that sends merge resolution instructions to Claude Code. |
| **Check runs list** | CI/CD check results. Each shows an icon and name: |
| | ✅ **Green checkmark** — passed |
| | ❌ **Red X** — failed (click **"Fix with Claude"** to send failure logs to Claude) |
| | ⏳ **Gray circle** — pending or queued |
| | 🔄 **Spinning icon** — in progress |
| **PR comments** | Review comments from GitHub, each showing: |
| | **Author** — who wrote the comment |
| | **File & line** — where in the code the comment applies |
| | **Body** — the comment text (long comments are truncated with a "Show more" toggle) |
| | **Resolved badge** — green indicator if resolved |
| | **Checkbox** — select unresolved comments for bulk fixing |
| | **"Fix with Claude" button** — sends this specific comment to Claude Code to address |
| | **"Resolve / Unresolve" button** — toggles the comment's resolution status on GitHub |
| **Bulk actions** | At the top of the comments section: |
| | **"Select all"** — checks all unresolved comments |
| | **"Deselect"** — unchecks all |
| | **"Fix N with Claude"** — sends all selected comments to Claude Code at once |

---

### Runners Panel

Below the changes panel are three configurable command runners:

```
┌──────────────────────────────┐
│  ▶ Setup                 Run │
│  ▶ Build                 Run │
│  ▶ Run                   Run │
└──────────────────────────────┘
```

Each runner corresponds to a command configured in [Project Settings](#project-settings).

| Element | Description |
|---------|-------------|
| **Runner label** | "Setup", "Build", or "Run". Click to expand/collapse the runner's embedded terminal. |
| **▶ Chevron** | Indicates expand/collapse state. |
| **Status dot** | Hidden when idle. **Green animated dot** when running. **Gray dot** when stopped/exited. |
| **Run button** | Starts (or restarts) the runner's command. |
| **Stop button** | Appears only while the command is running. Kills the process. |
| **Embedded terminal** | When expanded, a 150px-tall terminal shows the runner's output in real time. |

**Setup** runs the setup scripts defined in project settings (e.g. `npm install`).
**Build** runs the build command (e.g. `npm run build`).
**Run** runs the run command (e.g. `npm run dev`).

---

## Main Area

### Worktree Header

The header bar at the top of the main area shows context for the selected worktree.

```
┌──────────────────────────────────────────────────────────┐
│  Coppice / fix-readme-screenshot   fix/readme-screenshot │
│                                  → main  🔄   📝 💻 📂  │
└──────────────────────────────────────────────────────────┘
```

| Element | Description |
|---------|-------------|
| **Project / Worktree name** | Shows which project and worktree is selected. |
| **Branch name** | The live Git branch name. Polled every 3 seconds, so it reflects the actual branch even if changed externally. |
| **Target branch (→ main)** | The base branch for PR comparisons. Click to change it. Tooltip: *"Target branch for PR comparisons (click to change)"*. |
| **🔄 Sync button** | Fetches the target branch from origin. Tooltip: *"Fetch {branch} from origin"*. |
| **📝 Open in Editor** | Opens the worktree directory in your configured editor (VS Code, Cursor, etc.). Tooltip: *"Open in editor"*. |
| **💻 Open in Terminal** | Opens the worktree directory in your configured terminal emulator. Tooltip: *"Open terminal"*. |
| **📂 Open in Finder** | Opens the worktree directory in your system file manager. Tooltip: *"Open in Finder"*. |

---

### Tab Bar

Below the header is a tab bar for managing terminal and diff sessions.

```
┌──────────────────────────────────────────────────────────┐
│  Claude #1  │  Claude #2  │           [>_]  [🤖]        │
└──────────────────────────────────────────────────────────┘
```

| Element | Description |
|---------|-------------|
| **Tab** | Click to switch to that terminal or diff view. Each tab shows its name and a close button (✕) on hover. |
| **Tab types** | Tabs can be: **Claude** (Claude Code session), **Terminal** (plain shell), or **Diff** (file diff viewer). |
| **Claude status dot** | Claude tabs show a coloured dot indicating whether Claude is active or idle. |
| **✕ Close button** | Appears on hover. Closes the tab and kills the associated terminal session. |
| **[>_] New Terminal** | Creates a new plain terminal tab. Tooltip: *"New terminal (Ctrl+T)"*. |
| **[🤖] New Claude** | Creates a new Claude Code session tab. Tooltip: *"New Claude session (Ctrl+Shift+T)"*. |

Tabs are scrollable horizontally if there are too many to fit.

---

### Terminal View

The terminal view renders a full-featured terminal emulator powered by xterm.js.

| Feature | Description |
|---------|-------------|
| **Full terminal emulation** | Supports colours, cursor movement, box-drawing characters (Unicode 11), and all standard terminal features. |
| **Clickable links** | URLs in terminal output are clickable and open in your browser. |
| **Copy with Ctrl+C** | When text is selected, Ctrl+C copies it (with smart newline handling for wrapped lines). When nothing is selected, Ctrl+C sends the interrupt signal as normal. |
| **Scrollback** | 10,000 lines of scrollback buffer. Scroll with your mouse wheel or trackpad. |
| **Font** | Uses JetBrains Mono by default. Configurable in [App Settings](#app-settings). |
| **Theme** | Dark theme matching the app's colour scheme. |
| **Exit message** | When a terminal process exits, a message is displayed showing the exit status. |

#### Claude Code Sessions

Claude tabs launch Claude Code in the worktree directory. They have additional behaviours:

| Feature | Description |
|---------|-------------|
| **Auto-creation** | When you select a worktree that has no Claude tabs, one is automatically created. |
| **Idle detection** | After Claude finishes working and is waiting for input, the tab shows an "idle" indicator (see [Status Indicators](#status-indicators)). |
| **Notification sound** | Optionally plays a two-tone chime when Claude becomes idle in a background tab. Enable in [App Settings](#app-settings). |
| **Command injection** | Features like "Fix with Claude" and "Commit & Push" send instructions directly to the active Claude session. |

---

### Diff Viewer

When you click a file in the Changes or Files tab, it opens in a side-by-side diff viewer powered by Monaco Editor.

| Feature | Description |
|---------|-------------|
| **Side-by-side view** | Left pane shows the original version, right pane shows the modified version. |
| **Syntax highlighting** | Automatic language detection based on file extension. Supports 25+ languages. |
| **Colour coding** | Added lines highlighted green, removed lines highlighted red, modified lines highlighted yellow. |
| **PR comments inline** | If viewing a PR-level diff, review comments appear as bubbles in the right margin at the relevant line numbers. |
| **Comment colours** | Blue bubbles for unresolved comments, green for resolved. |
| **Expandable comments** | Long comments are truncated with a "Show more" toggle. |

---

## Modals & Dialogs

### App Settings

Opened via the **⚙ gear icon** in the sidebar header. Configures global defaults that apply to all projects.

| Setting | Description | Example |
|---------|-------------|---------|
| **Editor command** | The CLI command to launch your editor. | `cursor`, `code`, `codium` |
| **Claude command** | The default command to launch Claude Code. | `claude` |
| **Terminal font family** | Font for all terminal views. Must be installed on your system. | `JetBrains Mono`, `Fira Code` |
| **Terminal font size** | Font size in pixels for terminal views. | `14` |
| **Terminal emulator** | App to use for "Open in terminal". | `alacritty`, `kitty`, `ghostty` |
| **Shell** | Override the default shell for terminal sessions. | `/bin/zsh`, `fish` |
| **Window decorations** | Toggle the native title bar on/off. Useful for tiling window managers. | On / Off |
| **Notification sound** | Play a chime when Claude finishes working in a background tab. | On / Off |

A hint at the top reads: *"Global defaults. Leave blank to use platform defaults. Per-project settings override these."*

---

### Project Settings

Opened via the **+ button** (new project) or the **⋮ button** (edit existing project) in the sidebar.

| Setting | Description | Required |
|---------|-------------|----------|
| **Project name** | A display name for the project. | Yes |
| **Local path** | The path to the Git repository on disk. Use the Browse button to select it. | Yes |
| **GitHub remote** | The GitHub repository, as a URL or `owner/repo` format. Enables PR features. | No |
| **Base branch** | The default base branch for comparisons (e.g. `main`). | No |
| **Build command** | Command to run for the Build runner. | No |
| **Run command** | Command to run for the Run runner. | No |
| **Setup scripts** | Commands to run when setting up a new worktree (one per line). | No |
| **Env files to copy** | Env files to copy from the main repo into new worktrees (one per line). | No |
| **Claude command** | Override the global Claude command for this project. | No |
| **PR create skill** | Custom Claude command for creating pull requests. | No |

When editing an existing project, a red **Delete** button appears at the bottom-left.

---

### Create Worktree

Opened via the **+ button** on a project row. Creates a new Git worktree.

The dialog has two modes, toggled at the top:

#### Existing Branch Mode
1. **Filter** — Type to search through existing branches.
2. **Branch list** — Select which branch to check out.
3. **Worktree name** — Name for the worktree directory (auto-filled from branch name).

#### New Branch Mode
1. **Base branch** — Select the branch to create from.
2. **New branch name** — Name for the new Git branch.
3. **Worktree name** — Name for the worktree directory (auto-filled from branch name).

After creation, if setup scripts are configured, they run automatically in the new worktree.

A progress indicator shows the creation status, including file copy operations.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Tab** | Switch to the next tab |
| **Ctrl+Shift+Tab** | Switch to the previous tab |
| **Ctrl+PageDown** | Switch to the next tab (alternative) |
| **Ctrl+PageUp** | Switch to the previous tab (alternative) |
| **Ctrl+T** | Open a new terminal tab |
| **Ctrl+Shift+T** | Open a new Claude Code session |
| **Ctrl+W** | Close the current tab |

In terminal views:
| Shortcut | Action |
|----------|--------|
| **Ctrl+C** (with selection) | Copy selected text |
| **Ctrl+C** (without selection) | Send interrupt signal (SIGINT) |

In modals:
| Shortcut | Action |
|----------|--------|
| **Enter** | Confirm / submit |
| **Escape** | Cancel / close |

In the project tree:
| Action | Trigger |
|--------|---------|
| **Rename worktree** | Double-click the worktree name |
| **Confirm rename** | Press Enter |
| **Cancel rename** | Press Escape |

---

## Status Indicators

Coloured dots appear throughout the UI to show the status of background processes.

### Claude Status (on worktree rows and tabs)

| Indicator | Meaning |
|-----------|---------|
| **Pulsing indigo dot** | Claude is actively working (generating output). Tooltip: *"Claude is working"*. |
| **Static yellow dot** | Claude is idle — waiting for your input. Tooltip: *"Claude is waiting for input"*. |
| **No dot** | No Claude session running, or Claude tab not yet used. |

### Runner Status (on runner rows)

| Indicator | Meaning |
|-----------|---------|
| **Pulsing green dot** | Runner command is actively running. Tooltip: *"Run command active"*. |
| **Static gray dot** | Runner command has stopped/exited. |
| **No dot** | Runner has not been started. |

### PR Check Status (in PR tab)

| Icon | Meaning |
|------|---------|
| **✅ Green checkmark** | Check passed successfully. |
| **❌ Red X** | Check failed. |
| **⏳ Gray circle** | Check is pending or queued. |
| **🔄 Spinning icon** | Check is in progress. |

### File Status Badges (in changes panel)

| Badge | Colour | Meaning |
|-------|--------|---------|
| **M** | Yellow | Modified |
| **A** | Green | Added |
| **D** | Red | Deleted |
| **R** | Blue | Renamed |
| **??** | Gray | Untracked (new file not yet staged) |

---

## Drag & Drop

You can drag files from your system file manager and drop them onto a terminal view. The file path will be written into the terminal as text, making it easy to reference files in commands.

---

## Tips

- **Multiple branches at once**: Create multiple worktrees for the same project to work on several branches simultaneously, each with its own terminal sessions and runners.
- **Quick PR iteration**: Use the PR tab to see check failures and review comments, then click "Fix with Claude" to have Claude address them directly.
- **Bulk comment fixing**: Select multiple unresolved PR comments and fix them all at once with a single Claude instruction.
- **Target branch**: Set the target branch per-worktree to compare against a branch other than `main` (useful for stacked PRs).
- **Setup automation**: Configure setup scripts and env files in project settings so new worktrees are ready to use immediately after creation.
- **Runner shortcuts**: Expand a runner to see its output inline without switching tabs.
