#!/usr/bin/env node
/**
 * One-shot Claude Agent SDK title generator for Coppice tabs.
 *
 * Reads JSON from stdin: { prompt: string, cwd?: string }
 * Writes JSON to stdout: { title: string }
 */

import { query } from "@anthropic-ai/claude-agent-sdk";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function cleanTitle(text) {
  return String(text || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

async function main() {
  const raw = await readStdin();
  const payload = JSON.parse(raw || "{}");
  const prompt = String(payload.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");

  const cwd = typeof payload.cwd === "string" && payload.cwd.trim()
    ? payload.cwd.trim()
    : process.cwd();

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 30_000);
  try {
    const titleQuery = query({
      prompt: `Generate a very short tab title (2-5 words) summarizing this task. Respond with ONLY the title, no quotes or punctuation.\n\nTask: ${prompt.slice(0, 500)}`,
      options: {
        cwd,
        model: "claude-haiku-4-5-20251001",
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        includePartialMessages: false,
        abortController: abort,
      },
    });

    let title = "";
    for await (const message of titleQuery) {
      if (message.type !== "assistant") continue;
      const content = message.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text) title += block.text;
      }
    }

    title = cleanTitle(title);
    if (!title) throw new Error("empty title");
    process.stdout.write(`${JSON.stringify({ title })}\n`);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.message || String(err)}\n`);
  process.exitCode = 1;
});
