#!/usr/bin/env node
// Prune agent-bridge/node_modules to keep only the binaries for a single
// target triple. Run this before `tauri build` in CI to strip ~40 MB of
// unused ripgrep platform binaries (claude-agent-sdk ships all 5) and any
// stray cross-platform @img/sharp variants.
//
// Usage: node scripts/prune-agent-bridge.mjs [target-triple]
// If no target is passed, the host platform is auto-detected.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TARGET_MAP = {
  "aarch64-apple-darwin": { rg: "arm64-darwin", sharp: "darwin-arm64" },
  "x86_64-apple-darwin": { rg: "x64-darwin", sharp: "darwin-x64" },
  "x86_64-unknown-linux-gnu": { rg: "x64-linux", sharp: "linux-x64" },
  "aarch64-unknown-linux-gnu": { rg: "arm64-linux", sharp: "linux-arm64" },
  "x86_64-pc-windows-msvc": { rg: "x64-win32", sharp: "win32-x64" },
};

function hostTarget() {
  const { platform, arch } = process;
  if (platform === "darwin")
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (platform === "linux")
    return arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : "x86_64-unknown-linux-gnu";
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported host: ${platform}/${arch}`);
}

const target = process.argv[2] || hostTarget();
const map = TARGET_MAP[target];
if (!map) {
  console.error(`Unknown target triple: ${target}`);
  console.error(`Known: ${Object.keys(TARGET_MAP).join(", ")}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const bridgeRoot = join(here, "..", "src-tauri", "resources", "agent-bridge");
const nodeModules = join(bridgeRoot, "node_modules");

if (!existsSync(nodeModules)) {
  console.warn(`agent-bridge node_modules not found at ${nodeModules}`);
  console.warn(`Skipping pruning (node_modules may not be installed yet).`);
  process.exit(0);
}

console.log(`Pruning agent-bridge for target: ${target}`);

let bytesFreed = 0;
function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    const st = statSync(cur);
    if (st.isDirectory()) {
      for (const child of readdirSync(cur)) stack.push(join(cur, child));
    } else {
      total += st.size;
    }
  }
  return total;
}

function prune(dir, keepPredicate, label) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (keepPredicate(entry)) continue;
    const size = dirSize(full);
    rmSync(full, { recursive: true, force: true });
    bytesFreed += size;
    console.log(`  removed ${label}/${entry} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

// Prune ripgrep platform binaries
const rgDir = join(
  nodeModules,
  "@anthropic-ai",
  "claude-agent-sdk",
  "vendor",
  "ripgrep"
);
prune(rgDir, (name) => name === map.rg, "ripgrep");

// Prune @img/sharp native packages that don't match the active target.
// npm's optionalDependencies usually only installs the matching platform,
// but this catches any cross-platform leakage (e.g. linuxmusl variants
// installed on glibc Linux, which already had a bespoke cleanup step).
const imgDir = join(nodeModules, "@img");
prune(imgDir, (name) => name.includes(map.sharp), "@img");

console.log(
  `Pruned ${(bytesFreed / 1024 / 1024).toFixed(1)} MB for target ${target}.`
);
