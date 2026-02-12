#!/usr/bin/env node
// =============================================================================
// prompt-discipline init — Zero-config MCP server setup for Claude Code
// =============================================================================

import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

async function main(): Promise<void> {
  console.log("\n🧠 prompt-discipline — MCP server setup\n");

  const mcpPath = join(process.cwd(), ".mcp.json");
  let config: McpConfig;

  try {
    const existing = await readFile(mcpPath, "utf-8");
    config = JSON.parse(existing);
    if (!config.mcpServers) config.mcpServers = {};
    console.log("Found existing .mcp.json\n");
  } catch {
    config = { mcpServers: {} };
    console.log("Creating new .mcp.json\n");
  }

  console.log("Choose a profile:\n");
  console.log("  1) minimal  — 4 tools: clarify_intent, check_session_health, session_stats, prompt_score");
  console.log("  2) standard — 16 tools: all prompt discipline + session_stats + prompt_score");
  console.log("  3) full     — 20 tools: everything + timeline/vector search (needs LanceDB)\n");

  const choice = await ask("Profile [1/2/3] (default: 2): ");
  const profileMap: Record<string, string> = { "1": "minimal", "2": "standard", "3": "full" };
  const profile = profileMap[choice.trim()] || "standard";

  const env: Record<string, string> = {
    PROMPT_DISCIPLINE_PROFILE: profile,
  };

  if (profile === "full") {
    console.log("\nFull profile uses embeddings for vector search.");
    const provider = await ask("Embedding provider [local/openai] (default: local): ");
    if (provider.trim().toLowerCase() === "openai") {
      const key = await ask("OpenAI API key (or set OPENAI_API_KEY later): ");
      if (key.trim()) {
        env.OPENAI_API_KEY = key.trim();
      }
      env.EMBEDDING_PROVIDER = "openai";
    } else {
      env.EMBEDDING_PROVIDER = "local";
    }
  }

  config.mcpServers["prompt-discipline"] = {
    command: "npx",
    args: ["-y", "prompt-discipline@latest"],
    env,
  };

  // For the actual server entry point, we need to point to index.ts via tsx
  // But npx will resolve the bin entry which is the init script
  // So use a different approach: command runs the server
  config.mcpServers["prompt-discipline"] = {
    command: "npx",
    args: ["-y", "tsx", "node_modules/prompt-discipline/src/index.ts"],
    env,
  };

  await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\n✅ prompt-discipline added! (profile: ${profile})`);
  console.log("Restart Claude Code to connect.\n");

  rl.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
