#!/usr/bin/env node
// Download Node.js and GitHub CLI binaries for a given target triple and
// place them in src-tauri/binaries/ using Tauri's sidecar naming convention
// (<name>-<target-triple>[.exe]). Called from CI before `tauri build` so the
// packaged app does not require the user to have node or gh on PATH.
//
// Usage: node scripts/download-sidecars.mjs [target-triple]

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "20.18.1";
const GH_VERSION = "2.63.2";

// target triple -> { node, gh } download metadata
const MATRIX = {
  "aarch64-apple-darwin": {
    node: {
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
      archive: "tar.gz",
      inner: `node-v${NODE_VERSION}-darwin-arm64/bin/node`,
    },
    gh: {
      url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_arm64.zip`,
      archive: "zip",
      inner: `gh_${GH_VERSION}_macOS_arm64/bin/gh`,
    },
  },
  "x86_64-apple-darwin": {
    node: {
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz`,
      archive: "tar.gz",
      inner: `node-v${NODE_VERSION}-darwin-x64/bin/node`,
    },
    gh: {
      url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_macOS_amd64.zip`,
      archive: "zip",
      inner: `gh_${GH_VERSION}_macOS_amd64/bin/gh`,
    },
  },
  "x86_64-unknown-linux-gnu": {
    node: {
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`,
      archive: "tar.xz",
      inner: `node-v${NODE_VERSION}-linux-x64/bin/node`,
    },
    gh: {
      url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz`,
      archive: "tar.gz",
      inner: `gh_${GH_VERSION}_linux_amd64/bin/gh`,
    },
  },
  "aarch64-unknown-linux-gnu": {
    node: {
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz`,
      archive: "tar.xz",
      inner: `node-v${NODE_VERSION}-linux-arm64/bin/node`,
    },
    gh: {
      url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_arm64.tar.gz`,
      archive: "tar.gz",
      inner: `gh_${GH_VERSION}_linux_arm64/bin/gh`,
    },
  },
  "x86_64-pc-windows-msvc": {
    node: {
      url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
      archive: "zip",
      inner: `node-v${NODE_VERSION}-win-x64/node.exe`,
    },
    gh: {
      url: `https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_windows_amd64.zip`,
      archive: "zip",
      inner: `gh_${GH_VERSION}_windows_amd64/bin/gh.exe`,
    },
  },
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
const spec = MATRIX[target];
if (!spec) {
  console.error(`Unknown target: ${target}`);
  console.error(`Known: ${Object.keys(MATRIX).join(", ")}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const binariesDir = join(repoRoot, "src-tauri", "binaries");
const workDir = join(repoRoot, ".sidecar-cache", target);
mkdirSync(binariesDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const isWindowsTarget = target.includes("windows");
const exeSuffix = isWindowsTarget ? ".exe" : "";

async function download(url, dest) {
  console.log(`  fetching ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
}

function extract(archivePath, archiveType, destDir) {
  // Pass the archive by basename and run from its parent dir. GNU tar (Git
  // Bash on Windows) interprets `D:\...` as a remote host because of the
  // colon, so absolute paths with drive letters fail with "Cannot connect
  // to D: resolve failed".
  const cwd = dirname(archivePath);
  const name = basename(archivePath);

  if (archiveType === "zip") {
    if (process.platform === "win32") {
      // Some Windows runners ship a tar that cannot extract zip archives.
      const psPath = archivePath.replace(/'/g, "''");
      const psDest = destDir.replace(/'/g, "''");
      execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${psPath}' -DestinationPath '${psDest}' -Force`,
        ],
        { stdio: "inherit" },
      );
      return;
    }
    execFileSync("tar", ["-xf", name, "-C", destDir], { stdio: "inherit", cwd });
    return;
  }

  const flags = archiveType === "tar.gz" ? "-xzf" : archiveType === "tar.xz" ? "-xJf" : null;
  if (!flags) throw new Error(`Unknown archive type: ${archiveType}`);
  execFileSync("tar", [flags, name, "-C", destDir], { stdio: "inherit", cwd });
}

function listFilesRecursive(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function resolveExtractedBinary(extractDir, expectedInnerPath) {
  const directPath = join(extractDir, expectedInnerPath);
  if (existsSync(directPath)) return directPath;

  const files = listFilesRecursive(extractDir);
  const normalizedExpected = expectedInnerPath.replace(/\\/g, "/").toLowerCase();
  const withoutTopDir = normalizedExpected.split("/").slice(1).join("/");
  const expectedSuffixes = [normalizedExpected, withoutTopDir].filter(Boolean);

  const suffixMatches = files.filter((filePath) => {
    const rel = relative(extractDir, filePath).replace(/\\/g, "/").toLowerCase();
    return expectedSuffixes.some((suffix) => rel === suffix || rel.endsWith(`/${suffix}`));
  });
  if (suffixMatches.length === 1) return suffixMatches[0];
  if (suffixMatches.length > 1) {
    console.warn(`  Warning: ${suffixMatches.length} suffix matches for ${expectedInnerPath}, falling back to basename match`);
  }

  const expectedName = basename(expectedInnerPath).toLowerCase();
  const basenameMatches = files.filter(
    (filePath) => basename(filePath).toLowerCase() === expectedName,
  );
  if (basenameMatches.length === 1) return basenameMatches[0];

  const sample = files
    .slice(0, 10)
    .map((filePath) => relative(extractDir, filePath).replace(/\\/g, "/"));
  const matchInfo = suffixMatches.length > 1
    ? `${suffixMatches.length} ambiguous suffix matches, ${basenameMatches.length} basename matches.`
    : `${basenameMatches.length} basename matches.`;
  throw new Error(
    `Expected binary not found inside archive: ${expectedInnerPath}. ` +
      `${matchInfo} Found ${files.length} files. Sample entries: ${sample.join(", ") || "(none)"}`,
  );
}

async function fetchBinary(name, meta) {
  // `coppice-` prefix keeps these distinct from any system-installed
  // node/gh on Linux (.deb installs alongside /usr/bin/coppice) and matches
  // the externalBin names in tauri.conf.json.
  const outName = `coppice-${name}-${target}${exeSuffix}`;
  const outPath = join(binariesDir, outName);
  if (existsSync(outPath)) {
    console.log(`  ${outName} already present — skipping`);
    return;
  }

  console.log(`${name} (${target})`);
  const archiveName = `${name}.${meta.archive}`;
  const archivePath = join(workDir, archiveName);
  await download(meta.url, archivePath);

  const extractDir = join(workDir, `${name}-extract`);
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  extract(archivePath, meta.archive, extractDir);

  const innerPath = resolveExtractedBinary(extractDir, meta.inner);
  renameSync(innerPath, outPath);
  if (!isWindowsTarget) chmodSync(outPath, 0o755);
  console.log(`  -> ${outPath}`);
}

await fetchBinary("node", spec.node);
await fetchBinary("gh", spec.gh);

console.log(`\nSidecars ready in ${binariesDir}`);
