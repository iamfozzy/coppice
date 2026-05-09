# Coppice User Guide

Coppice is a desktop app for working across multiple Git worktrees, terminals, and AI-assisted coding sessions in one place. It combines project/worktree management, diffing, GitHub PR workflows, runners, and agent tabs in a single window.

![Coppice screenshot](screenshot.png)

---

## Table of Contents

- [Overview](#overview)
- [Quick start](#quick-start)
- [Layout](#layout)
- [Sidebar](#sidebar)
  - [Sidebar header](#sidebar-header)
  - [Scratchpad and project list](#scratchpad-and-project-list)
  - [Changes panel](#changes-panel)
  - [Runners panel](#runners-panel)
- [Main area](#main-area)
  - [Worktree header](#worktree-header)
  - [Tab bar](#tab-bar)
  - [Agent sessions](#agent-sessions)
  - [Terminal tabs](#terminal-tabs)
  - [Diff viewer](#diff-viewer)
- [Tile view](#tile-view)
- [Dialogs and settings](#dialogs-and-settings)
  - [App Settings](#app-settings)
  - [Project Settings](#project-settings)
  - [Create Worktree](#create-worktree)
  - [Delete Worktree](#delete-worktree)
- [Keyboard shortcuts and interactions](#keyboard-shortcuts-and-interactions)
- [Status indicators](#status-indicators)
- [Tips](#tips)

---

## Overview

Coppice organises your work around:

- **Projects** — Git repositories you add to Coppice.
- **Worktrees** — separate checkouts of branches for the same repo.
- **Tabs** — per-worktree sessions such as agent tabs, Claude CLI terminals, shell terminals, and diffs.
- **Runners** — project-defined Setup, Build, and Run commands.
- **Scratchpad** — a lightweight home workspace for notes, plans, and agent-only work that is not tied to a normal project worktree.

Each worktree keeps its own tabs, branch target, PR context, and runner state.

---

## Quick start

1. Click **+** in the sidebar header to add a project.
2. Create or select a worktree from that project.
3. Open a tab:
   - **Agent** for a built-in coding agent session
   - **CLI** for a Claude Code terminal tab
   - **Terminal** for a normal shell
4. Use the **Uncommitted**, **Files**, and **PR** panels in the sidebar to inspect changes and review status.
5. Run **Setup**, **Build**, or **Run** commands from the runner panel.
6. Use **Tile view** when you want several agent sessions visible at once.

---

## Layout

Coppice has two main regions:

- **Sidebar** — navigation, project/worktree list, change lists, and runners
- **Main area** — worktree header, tabs, agent/terminal/diff content

The sidebar is resizable by dragging its right edge. Its width is clamped between roughly **310px and 500px**.

---

## Sidebar

### Sidebar header

The sidebar header no longer just contains app branding and settings. It now acts as a compact control strip for the whole app.

| Control | Description |
|---|---|
| **Tile view button** | Opens or closes the multi-tile agent grid view. |
| **`Cl` / `Pi` backend button** | Switches the default agent backend between Claude Agent and Pi Agent. |
| **Model picker** | Chooses the default model. For Pi Agent, this also exposes provider/model selection. |
| **+ button** | Opens **New Project**. |
| **About button** | Opens the **About Coppice** modal with app/version info. |
| **Settings button** | Opens **App Settings**. |

These controls affect newly created agent tabs, and in some cases also update an empty idle agent tab.

---

### Scratchpad and project list

At the top of the navigation list is a **Scratchpad** entry.

#### Scratchpad

Scratchpad is a small built-in workspace for free-form agent sessions.

- Good for plans, notes, prompts, and temporary work
- Shows a tab count like normal worktrees
- Shows the same agent activity indicators as normal worktrees
- Does **not** show the Changes or Runners panels

#### Project rows

Each project row can be expanded or collapsed.

| Element | Description |
|---|---|
| **Chevron** | Expand/collapse the project’s worktrees. |
| **Project name** | Main label for the project. |
| **Search/filter button** | Filters the worktree list by branch name. |
| **+ button** | Opens **Create Worktree** for that project. |
| **⋯ button** | Opens **Project Settings**. |

You can also right-click a project header to open project settings.

#### Worktree rows

The current worktree row layout is compact. Rows primarily show the **branch name** rather than a separate “worktree title over branch subtitle” layout.

| Element | Description |
|---|---|
| **Branch label** | Primary label shown for the worktree row. |
| **PR number** | Shown inline when the worktree is associated with a PR. |
| **Tab count** | Small number showing how many tabs are open for that worktree. |
| **Agent status dot** | Shows whether an agent tab in that worktree is active or waiting. |
| **Run indicator** | Shows whether the Run runner is active. |
| **Delete button** | Appears on hover and opens the delete confirmation dialog. |

**Note:** the current UI does **not** support inline renaming of worktrees from the project tree.

---

### Changes panel

The changes area below the project tree has three tabs:

- **Uncommitted**
- **Files**
- **PR**

It is shown only for normal worktrees, not Scratchpad.

#### Uncommitted

Shows the current worktree’s local Git status.

| Feature | Description |
|---|---|
| **Changed file list** | Includes tracked and untracked files. |
| **Status badge** | `M`, `A`, `D`, `R`, or `??`. |
| **Click a file** | Opens an uncommitted diff tab. |
| **Right-click a file** | Opens a context menu with **Open diff**, **Open in editor**, and **Revert changes**. |
| **Commit & Push / Push** | Sends a commit-and-push or push instruction to your current automation flow. |

If there are uncommitted files, the action button reads **Commit & Push**. If the worktree is clean but ahead of origin, it reads **Push (N)**.

#### Files

Shows the PR-level diff for the current worktree relative to its target branch.

| Feature | Description |
|---|---|
| **File count in tab title** | Indicates how many files differ from the target/base branch. |
| **Click a file** | Opens a PR-mode diff tab. |
| **Target branch aware** | Uses the worktree target branch if set, otherwise the project default target/base branch. |

This is the best place to review the branch as a whole before opening or updating a PR.

#### PR

Shows pull request info for the current branch.

If a PR exists, the panel can show:

- PR state badge
- PR title and number
- Link to open the PR in the browser
- Manual **Refresh**
- Merge-conflict warning with **Resolve with Claude**
- Check run status list
- **Fix with Claude** for failed checks
- PR comments and review comments
- Comment selection and bulk-fix actions
- Resolve/unresolve controls for review threads
- Open-commented-file actions into the diff viewer

If no PR exists, the panel offers **Create PR**.

> **Naming note:** some buttons still say **“Fix with Claude”** or **“Resolve with Claude”**. In practice, these actions follow your current app configuration and may open either an Agent tab or a Claude CLI tab.

---

### Runners panel

The runners panel appears below the changes panel when the selected project has commands configured.

Available runners:

- **Setup**
- **Build**
- **Run**

| Element | Description |
|---|---|
| **Runner header** | Expand/collapse the embedded runner terminal. |
| **Status dot** | Hidden when idle, green when running, grey when stopped. |
| **Run button** | Starts or restarts that runner. |
| **Stop button** | Stops a running command. |
| **Embedded terminal** | Shows live output when expanded. |

Notes:

- **Setup** is built from all setup scripts joined together.
- Runner terminals are preserved when you switch between worktrees.
- After creating a worktree, Coppice can automatically trigger **Setup** if setup scripts are configured.

---

## Main area

### Worktree header

The header at the top of the main area shows the selected context.

For a normal worktree it includes:

| Element | Description |
|---|---|
| **Project / worktree label** | Shows the current project and worktree name. |
| **Live branch name** | Polled from Git, so it stays accurate even if the branch changes outside Coppice. |
| **Target branch picker** | Displays `→ target-branch`; click to edit it inline. |
| **Fetch button** | Fetches the current target branch from `origin`. |
| **Open in editor** | Opens the worktree, or the active diff file if a diff tab is selected. |
| **Open terminal** | Opens the worktree in your configured external terminal emulator. |
| **Open in file manager** | Opens the worktree folder in Finder/Explorer/etc. |

When Scratchpad is selected, the header simply shows **Scratchpad**.

---

### Tab bar

The tab bar is more flexible than the older user guide described.

#### New-tab controls

| Position | Control | Description |
|---|---|---|
| **Left** | **New Agent session** | Creates a built-in agent tab. |
| **Right** | **New terminal** | Creates a normal shell tab. |
| **Right** | **CLI** | Creates a Claude CLI terminal tab using the configured Claude command. |

#### Tab types

Tabs can be:

- **Agent**
- **Claude CLI terminal**
- **Terminal**
- **Diff**

#### Tab interactions

| Interaction | Result |
|---|---|
| **Click** | Activate the tab |
| **Double-click tab title** | Rename the tab |
| **Hover X** | Close the tab |
| **Middle-click** | Close the tab |

If you try to close an agent/CLI tab that is still actively working, Coppice asks for confirmation first.

Unlike older versions, Coppice does **not** automatically create a Claude CLI tab when you select a worktree.

---

### Agent sessions

Agent tabs are the main place for AI-assisted work in Coppice.

Depending on your settings, new agent tabs use either:

- **Claude Agent**, or
- **Pi Agent**

#### Agent controls

At the bottom of an agent tab you can configure the session with controls such as:

- **Backend badge** (`Cl` or `Pi`)
- **Model picker**
- **1M** toggle for supported Claude models
- **Effort**
- **Permission mode**
- **Concise** mode
- **Chat** mode

Permission modes are:

- **Default** — ask before edits and shell commands
- **Accept Edits** — auto-allow file edits, still ask for shell commands
- **Allow All** — auto-allow everything
- **Plan Only** — read-only planning / analysis flow

#### Input bar

The agent input bar supports:

- sending a normal message
- queuing a message while the agent is already busy
- attaching images with the image button
- dragging images into the tab
- pasting screenshots/images from the clipboard
- slash-command autocomplete by typing `/`

#### Agent workflow UI

Agent tabs can also show:

- streaming assistant output
- grouped tool calls/results
- inline **Plan Approval Required** blocks in plan mode
- permission prompts for non-plan actions
- “ask user” prompts when the agent needs more information
- stop/interrupt controls while the agent is working
- token/context/cost information in the toolbar

---

### Terminal tabs

Terminal tabs are full PTY-backed shell sessions.

| Feature | Description |
|---|---|
| **Shell session** | Uses your configured shell/platform default. |
| **Clickable links** | URLs open in your browser. |
| **Copy with selection** | `Ctrl/Cmd+C` copies selected text. |
| **Interrupt without selection** | `Ctrl/Cmd+C` sends the normal interrupt signal when nothing is selected. |
| **Scrollback** | 10,000 lines. |
| **Theme-aware** | Matches the current Coppice theme. |
| **Exit message** | Shows `[Process exited]` when the session ends. |

#### Claude CLI tabs

The **CLI** button creates a terminal tab that runs your configured Claude command.

This is separate from the built-in **Agent** tab type:

- **Agent** = integrated agent UI with controls, permissions, and message history
- **CLI** = terminal session running the Claude CLI

#### Drag and drop

Drag-and-drop behaves differently depending on the active tab type:

- On an **agent tab**, dropped image files become image attachments
- On a **terminal/CLI tab**, dropped files are written into the terminal as quoted file paths

---

### Diff viewer

Clicking a file in **Uncommitted** or **Files** opens a Monaco-based side-by-side diff.

| Feature | Description |
|---|---|
| **Uncommitted mode** | `HEAD` vs working tree |
| **PR mode** | merge-base vs `HEAD` |
| **Syntax highlighting** | Language detection based on file type |
| **Inline PR comments** | PR-mode diffs can render review comments inline in the modified pane |
| **Theme-aware editor** | Matches the active Coppice theme |

Opening the same file/mode again reuses the existing diff tab instead of creating duplicates.

---

## Tile view

Tile view is a grid of agent tabs shown full-window.

It is useful when you want to monitor or work with multiple agent sessions at once.

### What it shows

- Agent tabs from all open worktrees
- Agent tabs from Scratchpad
- Empty slots for adding more work

### What you can do there

- open an existing worktree into a new agent tile
- create a new worktree and immediately open an agent tab for it
- switch backend/model from the tile-view header
- close tile view with **Esc** or the tile-view button

Tile view is agent-focused; it is not a multi-terminal grid.

---

## Dialogs and settings

### App Settings

App Settings now covers much more than editor/terminal defaults.

#### GitHub

At the top of settings is a **GitHub** section.

From here you can:

- sign in with GitHub using the bundled `gh` CLI
- sign out
- enable PR/check/comment features without installing `gh` yourself separately in the app bundle

#### General app settings

Global settings include:

- editor command
- Claude command
- terminal font family and size
- terminal emulator
- shell override
- theme (`dark`, `dim`, `atom`, `light`, `system`)
- window decorations
- notification sound
- OS notifications

#### Agent mode

You can choose between:

- **Terminal (CLI)**
- **Claude Agent**
- **Pi Agent**

#### Claude Agent settings

When Claude Agent is selected, App Settings exposes options such as:

- Anthropic API key
- base URL / proxy settings
- default model
- default effort
- small/fast model override
- subagent model
- bash output limits
- task output limits

#### Pi Agent settings

When Pi Agent is selected, App Settings includes Pi-specific configuration such as:

- provider authentication
- provider/model defaults
- thinking level
- optional web access
- optional subagent support

#### MCP servers

App Settings also contains an **MCP Servers** editor for adding extra MCP servers available to agent sessions.

---

### Project Settings

Project Settings defines the per-project defaults that power worktrees and runners.

Fields include:

- **Project name**
- **Local path**
- **GitHub remote**
- **Base branch**
- **Target branch**
- **Build command**
- **Run command**
- **Setup scripts**
- **Env files to copy**
- **Claude command** override
- **PR create skill**

Notes:

- **Target branch** is the default PR comparison branch for that project.
- **Env files to copy** are used when creating new worktrees.
- **PR create skill** lets you customise what happens when you press **Create PR**.
- Existing projects can be deleted from the bottom of this dialog.

---

### Create Worktree

Create Worktree has two modes:

- **New branch**
- **Existing branch**

The current modal opens in **New branch** mode by default.

#### New branch mode

1. Filter/select the base branch
2. Enter the new branch name
3. Confirm the worktree folder name
4. Create the worktree

As you type the branch name, the worktree folder name is auto-filled and sanitised.

#### Existing branch mode

1. Filter/select an existing branch
2. Confirm the worktree folder name
3. Create the worktree

Other notes:

- The branch list supports filtering.
- The project default/base branch is highlighted as the default choice when possible.
- Progress text appears while Coppice creates the worktree and copies configured env files.
- After creation, Coppice selects the new worktree, and Setup can be triggered automatically if configured.

---

### Delete Worktree

Deleting a worktree now has two confirmation actions:

- **Delete** — removes the worktree directory and deletes the local branch
- **Delete, Keep Branch** — removes the worktree directory but keeps the local branch

This is more accurate than the older guide, which implied deletion always removed the branch with no option.

---

## Keyboard shortcuts and interactions

Coppice uses **Ctrl** on Windows/Linux and **Cmd** on macOS for its main shortcuts.

### Tab shortcuts

| Shortcut | Action |
|---|---|
| **Ctrl/Cmd+Tab** | Next tab |
| **Ctrl/Cmd+Shift+Tab** | Previous tab |
| **Ctrl/Cmd+PageDown** | Next tab |
| **Ctrl/Cmd+PageUp** | Previous tab |
| **Ctrl/Cmd+W** | Close current tab |
| **Ctrl/Cmd+T** | New terminal tab |
| **Ctrl/Cmd+Shift+T** | New default coding tab (Agent if agent mode is enabled; Claude CLI tab if terminal mode is selected) |
| **Ctrl/Cmd+Shift+A** | New Agent tab |

### Other interactions

| Interaction | Result |
|---|---|
| **Esc** | Closes tile view; also dismisses many dialogs/popovers |
| **Double-click tab title** | Rename tab |
| **Middle-click tab** | Close tab |
| **Right-click changed file** | Open file actions menu |
| **Right-click project header** | Open project settings |
| **Enter in dialogs** | Confirm/create when valid |
| **Drag images into an agent tab** | Add them as attachments |
| **Drag files into a terminal tab** | Paste file paths into the shell |

### Terminal copy behaviour

| Shortcut | Action |
|---|---|
| **Ctrl/Cmd+C** with selection | Copy selected text |
| **Ctrl/Cmd+C** without selection | Send interrupt |

---

## Status indicators

### Agent status

Shown on Scratchpad, worktree rows, and relevant tabs.

| Indicator | Meaning |
|---|---|
| **Pulsing accent dot** | An agent is actively working |
| **Static yellow dot** | An agent is waiting for input |
| **No dot** | No active/idle agent session for that scope |

### Runner status

| Indicator | Meaning |
|---|---|
| **Pulsing green dot** | Runner is running |
| **Static grey dot** | Runner has stopped |
| **No dot** | Runner has not been started |

### PR checks

| Icon | Meaning |
|---|---|
| **Green check** | Success |
| **Red X** | Failure |
| **Grey dot/circle** | Pending or queued |
| **Spinning indicator** | In progress |

### File status badges

| Badge | Meaning |
|---|---|
| **M** | Modified |
| **A** | Added |
| **D** | Deleted |
| **R** | Renamed |
| **??** | Untracked |

---

## Tips

- **Use Scratchpad for planning** when you want an agent session that is not tied to a specific repo worktree.
- **Use target branches per worktree** for stacked PR workflows.
- **Use Tile view** when you want several agent sessions visible at once.
- **Keep Setup scripts and env-file copying configured** so new worktrees are ready immediately.
- **Use the Files tab before opening a PR** to review the whole branch against its target branch.
- **Remember that “Fix with Claude” actions follow your current app mode** and may open an Agent tab rather than only a CLI session.
- **Use CLI tabs for raw terminal-based Claude workflows** and Agent tabs for the integrated permission/model/tools UI.
