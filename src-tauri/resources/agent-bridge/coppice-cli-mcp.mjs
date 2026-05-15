#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

const url = process.env.COPPICE_MCP_URL;
const token = process.env.COPPICE_MCP_TOKEN;
const cwd = process.env.COPPICE_MCP_CWD || process.cwd();

if (!url || !token) {
  console.error("Coppice MCP server missing COPPICE_MCP_URL/COPPICE_MCP_TOKEN");
  process.exit(1);
}

async function callCoppice(toolName, args = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ toolName, args, cwd }),
  });
  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { ok: false, error: text || `HTTP ${res.status}` };
  }
  if (!res.ok || payload.ok === false) {
    return { content: [{ type: "text", text: payload.error || `Coppice tool failed (HTTP ${res.status})` }], isError: true };
  }
  return { content: [{ type: "text", text: String(payload.result ?? "") }] };
}

const instructions = `Use Coppice tools for IDE-integrated actions. Use list_projects/list_worktrees from scratchpad before creating worktrees. Use run_runner/stop_runner/runner_status for configured setup/build/run tasks; do not run those configured tasks via shell yourself, and if a runner is unavailable do not invent an equivalent command unless the user explicitly asks.`;

const server = new McpServer(
  { name: "coppice", version: "1.0.0" },
  { instructions },
);

server.registerTool("list_projects", {
  description: "List Coppice projects available in the IDE. Use this from the scratchpad before asking the user which project to target.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => callCoppice("list_projects"));

server.registerTool("create_project", {
  description: "Create a Coppice project. Ask the user for the project name and local repository path before calling this tool.",
  inputSchema: {
    name: z.string().describe("Project display name"),
    local_path: z.string().describe("Absolute path to the repository/project root"),
    github_remote: z.string().optional().describe("GitHub remote URL"),
    base_branch: z.string().optional().describe("Base branch (defaults to main)"),
    target_branch: z.string().optional().describe("Default PR target branch"),
    setup_scripts: z.array(z.string()).optional().describe("Setup scripts shown in the sidepanel"),
    build_command: z.string().optional().describe("Build command shown in the sidepanel"),
    run_command: z.string().optional().describe("Run command shown in the sidepanel"),
    env_files: z.array(z.string()).optional().describe("Env files/directories to copy to new worktrees"),
  },
  annotations: { destructiveHint: true },
}, async (args) => callCoppice("create_project", args));

server.registerTool("create_worktree", {
  description: "Create a new git worktree in the Coppice IDE. Pass project_id/project_name when calling from scratchpad. Provide branch OR new_branch + base_branch. Pass prompt to delegate work into a new Coppice agent tab.",
  inputSchema: {
    project_id: z.string().optional().describe("Target Coppice project ID (required from scratchpad)"),
    project_name: z.string().optional().describe("Target Coppice project name if project_id is unknown"),
    branch: z.string().optional().describe("Existing branch to check out"),
    new_branch: z.string().optional().describe("Name for a new branch to create"),
    base_branch: z.string().optional().describe("Base branch for new_branch (defaults to main)"),
    name: z.string().optional().describe("Worktree folder name (defaults to branch name)"),
    prompt: z.string().optional().describe("Task for a new agent tab to execute in the created worktree"),
  },
  annotations: { destructiveHint: true },
}, async (args) => callCoppice("create_worktree", args));

server.registerTool("list_worktrees", {
  description: "List worktrees registered in a Coppice project. If project_id/project_name is omitted, lists the current project, or all projects when called from scratchpad.",
  inputSchema: {
    project_id: z.string().optional().describe("Project ID to list"),
    project_name: z.string().optional().describe("Project name to list"),
  },
  annotations: { readOnlyHint: true },
}, async (args) => callCoppice("list_worktrees", args));

server.registerTool("list_runners", {
  description: "List Coppice sidepanel runners (setup/build/run) available for a worktree and their running status.",
  inputSchema: {
    project_id: z.string().optional(),
    project_name: z.string().optional(),
    worktree_id: z.string().optional(),
    worktree_name: z.string().optional(),
  },
  annotations: { readOnlyHint: true },
}, async (args) => callCoppice("list_runners", args));

server.registerTool("run_runner", {
  description: "Run a configured Coppice sidepanel runner (setup, build, or run) so output/status appears in the UI. Do not use this if the runner is unavailable.",
  inputSchema: {
    runner: z.enum(["setup", "build", "run"]),
    project_id: z.string().optional(),
    project_name: z.string().optional(),
    worktree_id: z.string().optional(),
    worktree_name: z.string().optional(),
  },
  annotations: { destructiveHint: true },
}, async (args) => callCoppice("run_runner", args));

server.registerTool("stop_runner", {
  description: "Stop a running Coppice sidepanel runner.",
  inputSchema: {
    runner: z.enum(["setup", "build", "run"]),
    project_id: z.string().optional(),
    project_name: z.string().optional(),
    worktree_id: z.string().optional(),
    worktree_name: z.string().optional(),
  },
  annotations: { destructiveHint: true },
}, async (args) => callCoppice("stop_runner", args));

server.registerTool("runner_status", {
  description: "Check whether a configured Coppice sidepanel runner is available and currently running.",
  inputSchema: {
    runner: z.enum(["setup", "build", "run"]),
    project_id: z.string().optional(),
    project_name: z.string().optional(),
    worktree_id: z.string().optional(),
    worktree_name: z.string().optional(),
  },
  annotations: { readOnlyHint: true },
}, async (args) => callCoppice("runner_status", args));

server.registerTool("spawn_terminal", {
  description: "Open a new terminal tab in the Coppice IDE, optionally running a command in it.",
  inputSchema: {
    cwd: z.string().optional().describe("Working directory for the terminal"),
    command: z.string().optional().describe("Command to run after opening"),
  },
  annotations: { destructiveHint: true },
}, async (args) => callCoppice("spawn_terminal", args));

server.registerTool("open_file", {
  description: "Open a file in the Coppice IDE's editor/diff tab so the user can see it.",
  inputSchema: { path: z.string().describe("Absolute path or path relative to the worktree root") },
  annotations: { readOnlyHint: true },
}, async (args) => callCoppice("open_file", args));

server.registerTool("open_scratchpad", {
  description: "Create a new agent tab in the Coppice scratchpad with pre-filled content.",
  inputSchema: {
    content: z.string().describe("Content to pre-fill as the initial prompt"),
    title: z.string().optional().describe("Label for the scratchpad tab"),
  },
  annotations: { readOnlyHint: true },
}, async (args) => callCoppice("open_scratchpad", args));

server.registerTool("open_url", {
  description: "Open a URL in the user's system browser.",
  inputSchema: { url: z.string().describe("The URL to open") },
  annotations: { readOnlyHint: true },
}, async (args) => callCoppice("open_url", args));

const transport = new StdioServerTransport();
await server.connect(transport);
