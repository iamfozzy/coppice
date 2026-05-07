/**
 * Pi OAuth helper — runs an OAuth login flow for a given provider.
 * Spawned by Coppice as a short-lived Node process.
 *
 * Usage: node pi-oauth.mjs <provider-id>
 *
 * Stdout (JSON lines):
 *   { type: "auth", url, instructions } — user should open this URL
 *   { type: "progress", message } — status update
 *   { type: "success", provider } — login complete, credentials saved
 *   { type: "error", message } — login failed
 */

import {
  loginAnthropic,
  loginGitHubCopilot,
  loginOpenAICodex,
} from "@earendil-works/pi-ai/oauth";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const log = (...args) =>
  process.stderr.write("[pi-oauth] " + args.join(" ") + "\n");

// Safety timeout — if the user doesn't complete the flow within 5 minutes,
// exit cleanly so we don't leave an orphan process holding the callback port.
const TIMEOUT_MS = 5 * 60 * 1000;
const timeout = setTimeout(() => {
  log("timeout: OAuth flow not completed within 5 minutes, exiting");
  emit({ type: "error", message: "OAuth login timed out. Please try again." });
  process.exit(1);
}, TIMEOUT_MS);
// Don't let the timer keep the process alive if everything else finishes
timeout.unref?.();

// Clean exit on SIGTERM (sent by Rust when starting a new OAuth attempt)
process.on("SIGTERM", () => {
  log("received SIGTERM, exiting");
  process.exit(0);
});

const providerId = process.argv[2];
if (!providerId) {
  emit({ type: "error", message: "Usage: pi-oauth.mjs <provider-id>" });
  process.exit(1);
}

const LOGIN_FNS = {
  anthropic: loginAnthropic,
  "github-copilot": loginGitHubCopilot,
  "openai-codex": loginOpenAICodex,
};

const loginFn = LOGIN_FNS[providerId];
if (!loginFn) {
  emit({
    type: "error",
    message: `Unknown OAuth provider: ${providerId}. Supported: ${Object.keys(LOGIN_FNS).join(", ")}`,
  });
  process.exit(1);
}

log(`starting OAuth for: ${providerId}`);

try {
  const credentials = await loginFn({
    onAuth: (...args) => {
      // Different providers call onAuth differently:
      // - Anthropic: onAuth({ url, instructions })
      // - GitHub Copilot: onAuth(url, instructions)  (two separate args)
      // - OpenAI Codex: onAuth({ url, instructions })
      let url, instructions;
      if (typeof args[0] === "string") {
        url = args[0];
        instructions = args[1];
      } else {
        url = args[0]?.url;
        instructions = args[0]?.instructions;
      }
      log(`auth: url=${url} instructions=${instructions || "(none)"}`);
      emit({ type: "auth", url: url || "", instructions: instructions || "" });
    },
    onPrompt: async (prompt) => {
      // Auto-respond to known prompts:
      // - GitHub Enterprise URL → blank (= github.com)
      // - Any other prompt with allowEmpty → blank
      log(`prompt: "${prompt.message}" (allowEmpty=${prompt.allowEmpty})`);
      emit({
        type: "progress",
        message: prompt.message,
      });
      // Return empty string — correct for github.com, harmless for others
      return "";
    },
    onProgress: (message) => {
      log(`progress: ${message}`);
      emit({ type: "progress", message });
    },
  });

  log("login succeeded, saving credentials...");

  // Save credentials to ~/.pi/agent/auth.json
  const authDir = join(homedir(), ".pi", "agent");
  const authPath = join(authDir, "auth.json");

  let data = {};
  try {
    if (existsSync(authPath)) {
      data = JSON.parse(readFileSync(authPath, "utf-8"));
    }
  } catch {
    /* corrupt or missing — start fresh */
  }

  if (!existsSync(authDir)) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
  }

  data[providerId] = { type: "oauth", ...credentials };
  writeFileSync(authPath, JSON.stringify(data, null, 2), { mode: 0o600 });

  log(`credentials saved to ${authPath}`);
  emit({ type: "success", provider: providerId });
} catch (err) {
  log(`error: ${err.message}`);
  emit({ type: "error", message: err.message || String(err) });
}

process.exit(0);
