#!/usr/bin/env node
// =============================================================================
// preflight init — Zero-config MCP server setup for Claude Code
// =============================================================================

import { createInterface } from "node:readline";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

/** Create .preflight/ directory with template files */
async function createPreflightConfig(): Promise<void> {
  const preflightDir = join(process.cwd(), ".preflight");
  
  if (existsSync(preflightDir)) {
    console.log("⚠️  .preflight/ directory already exists, skipping...\n");
    return;
  }

  try {
    await mkdir(preflightDir, { recursive: true });
    
    // Get the current module's directory to find templates
    const currentFile = fileURLToPath(import.meta.url);
    const srcDir = dirname(dirname(currentFile)); // Go up from cli/ to src/
    const templatesDir = join(srcDir, "templates");
    
    // Copy template files
    await copyFile(join(templatesDir, "config.yml"), join(preflightDir, "config.yml"));
    await copyFile(join(templatesDir, "triage.yml"), join(preflightDir, "triage.yml"));
    
    console.log("✅ Created .preflight/ directory with template config files");
    console.log("   Edit .preflight/config.yml to configure your project settings");
    console.log("   Edit .preflight/triage.yml to customize prompt triage rules\n");
  } catch (error) {
    console.error(`❌ Failed to create .preflight/ directory: ${error}\n`);
  }
}

interface McpConfig {
  mcpServers: Record<string, {
    command: string;
    args: string[];
    env?: Record<string, string>;
  }>;
}

async function main(): Promise<void> {
  console.log("\n✈️ preflight — MCP server setup\n");

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

  // Ask about creating .preflight/ directory
  console.log("\nPreflight can use either environment variables or a .preflight/ directory for configuration.");
  console.log("The .preflight/ directory allows you to configure related projects, custom triage rules, and thresholds.\n");
  
  const createConfig = await ask("Create .preflight/ directory with template config? [y/N]: ");
  if (createConfig.trim().toLowerCase() === "y" || createConfig.trim().toLowerCase() === "yes") {
    await createPreflightConfig();
  }

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

  config.mcpServers["preflight"] = {
    command: "npx",
    args: ["-y", "preflight-dev@latest"],
    env,
  };

  // For the actual server entry point, we need to point to index.ts via tsx
  // But npx will resolve the bin entry which is the init script
  // So use a different approach: command runs the server
  config.mcpServers["preflight"] = {
    command: "npx",
    args: ["-y", "tsx", "node_modules/preflight/src/index.ts"],
    env,
  };

  await writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n");

  console.log(`\n✅ preflight added! (profile: ${profile})`);
  console.log("Restart Claude Code to connect.\n");

  rl.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
