// =============================================================================
// session_stats — Lightweight JSONL session analysis (no embeddings needed)
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface SessionInfo {
  file: string;
  turns: number;
  corrections: number;
  compactions: number;
}

async function findSessionFiles(): Promise<string[]> {
  const baseDir = join(homedir(), ".claude", "projects");
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.endsWith(".jsonl")) {
          files.push(full);
        }
      }
    } catch {
      // skip inaccessible dirs
    }
  }

  await walk(baseDir);
  return files;
}

async function analyzeSession(filePath: string): Promise<SessionInfo> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  let turns = 0;
  let corrections = 0;
  let compactions = 0;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "human" || obj.role === "human" || obj.role === "user") {
        turns++;
      }
      // Detect corrections: messages containing "no", "wrong", "actually", "instead"
      const text = (obj.message || obj.content || "").toString().toLowerCase();
      if (turns > 0 && /\b(no[,.]|wrong|actually|instead|that's not|not what i)\b/.test(text)) {
        corrections++;
      }
      // Detect compactions
      if (obj.type === "summary" || obj.type === "compaction" || text.includes("compacted") || text.includes("context window")) {
        compactions++;
      }
    } catch {
      // skip malformed lines
    }
  }

  return { file: filePath, turns, corrections, compactions };
}

export function registerSessionStats(server: McpServer): void {
  server.tool(
    "session_stats",
    "Analyze Claude Code session history from JSONL files. Returns total sessions, prompts, correction rate, and more. No embeddings needed.",
    {
      projectFilter: z.string().optional().describe("Filter to sessions matching this project path substring"),
    },
    async ({ projectFilter }) => {
      const files = await findSessionFiles();
      const filtered = projectFilter
        ? files.filter((f) => f.includes(projectFilter))
        : files;

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No session files found in ~/.claude/projects/",
            },
          ],
        };
      }

      const sessions = await Promise.all(filtered.map(analyzeSession));
      const totalTurns = sessions.reduce((s, x) => s + x.turns, 0);
      const totalCorrections = sessions.reduce((s, x) => s + x.corrections, 0);
      const totalCompactions = sessions.reduce((s, x) => s + x.compactions, 0);
      const avgTurns = sessions.length > 0 ? (totalTurns / sessions.length).toFixed(1) : "0";
      const correctionRate = totalTurns > 0 ? ((totalCorrections / totalTurns) * 100).toFixed(1) : "0";

      // Find most active branches (group by parent dir)
      const branchCounts = new Map<string, number>();
      for (const s of sessions) {
        const parts = s.file.split("/");
        const branch = parts.slice(-2, -1)[0] || "unknown";
        branchCounts.set(branch, (branchCounts.get(branch) || 0) + s.turns);
      }
      const topBranches = [...branchCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `  ${name}: ${count} prompts`)
        .join("\n");

      const report = [
        `📊 Session Stats`,
        `────────────────────────`,
        `Sessions:        ${sessions.length}`,
        `Total prompts:   ${totalTurns}`,
        `Corrections:     ${totalCorrections} (${correctionRate}% rate)`,
        `Compactions:     ${totalCompactions}`,
        `Avg session len: ${avgTurns} turns`,
        ``,
        `Most active branches:`,
        topBranches || "  (none)",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: report }],
      };
    }
  );
}
