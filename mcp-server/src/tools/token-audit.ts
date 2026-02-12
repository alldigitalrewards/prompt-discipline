// CATEGORY 5: token_audit — Token Efficiency
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs, PROJECT_DIR } from "../lib/files.js";
import { loadState, saveState, now, STATE_DIR } from "../lib/state.js";
import { readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

/** Shell-escape a filename for safe interpolation */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Grade thresholds rationale:
 * - A (0-10):  Minimal waste — small diffs, targeted reads, lean context
 * - B (11-25): Minor waste — a few large files or slightly bloated docs
 * - C (26-45): Moderate waste — repeated reads, large diffs, or context bloat
 * - D (46-65): Significant waste — multiple anti-patterns compounding
 * - F (66+):   Severe waste — session is burning tokens on avoidable overhead
 *
 * Each pattern contributes a weighted score reflecting its relative token cost.
 */

const MAX_TOOL_LOG_BYTES = 5 * 1024 * 1024; // 5MB limit for tool log parsing

export function registerTokenAudit(server: McpServer): void {
  server.tool(
    "token_audit",
    `Detect token waste patterns in Claude Code sessions — repeated reads, large file dumps, context bloat, skill paste overhead. Call periodically to check efficiency, especially in long sessions.`,
    {
      session_actions: z.string().optional().describe("Description of recent actions if available"),
      check_mode: z.enum(["quick", "deep"]).default("quick").describe("Quick checks git/files; deep also analyzes tool call patterns"),
    },
    async ({ session_actions, check_mode }) => {
      const patterns: string[] = [];
      const recommendations: string[] = [];
      let wasteScore = 0;

      // 1. Git diff size & dirty file count
      const diffStat = run("git diff --stat --no-color 2>/dev/null");
      const dirtyFiles = run("git diff --name-only 2>/dev/null");
      const dirtyList = dirtyFiles.split("\n").filter(Boolean);
      const dirtyCount = dirtyList.length;

      const summaryLine = diffStat.split("\n").pop() || "";
      const insertionsMatch = summaryLine.match(/(\d+) insertion/);
      const deletionsMatch = summaryLine.match(/(\d+) deletion/);
      const totalChanges = (parseInt(insertionsMatch?.[1] || "0") || 0) + (parseInt(deletionsMatch?.[1] || "0") || 0);

      if (totalChanges > 2000) {
        patterns.push(`Large uncommitted diff: ~${totalChanges} changed lines across ${dirtyCount} files`);
        recommendations.push("Commit more frequently — large diffs bloat context when re-read");
        wasteScore += 15;
      }

      // 2. Estimated context size from dirty files (safe line counting)
      const AVG_LINE_BYTES = 45;
      const AVG_TOKENS_PER_BYTE = 0.25;
      let estimatedContextTokens = 0;
      const largeFiles: string[] = [];

      for (const f of dirtyList.slice(0, 30)) {
        // Use shell-safe quoting instead of interpolation
        const wc = run(`wc -l < '${shellEscape(f)}' 2>/dev/null`);
        const lines = parseInt(wc) || 0;
        estimatedContextTokens += lines * AVG_LINE_BYTES * AVG_TOKENS_PER_BYTE;
        if (lines > 500) {
          largeFiles.push(`${f} (${lines} lines)`);
        }
      }

      if (largeFiles.length > 0) {
        patterns.push(`Large files in working set (>500 lines): ${largeFiles.join(", ")}`);
        recommendations.push("Use offset/limit when reading large files — avoid dumping entire contents");
        wasteScore += largeFiles.length * 8;
      }

      // 3. CLAUDE.md bloat check
      const claudeMd = readIfExists("CLAUDE.md", 1);
      if (claudeMd !== null) {
        const stat = run(`wc -c < '${shellEscape("CLAUDE.md")}' 2>/dev/null`);
        const bytes = parseInt(stat) || 0;
        if (bytes > 5120) {
          patterns.push(`CLAUDE.md is ${(bytes / 1024).toFixed(1)}KB — injected every session, burns tokens on paste`);
          recommendations.push("Trim CLAUDE.md to essentials (<5KB). Move reference docs to files read on-demand");
          wasteScore += 12;
        }
      }

      // 4. Workspace doc bloat
      const docs = findWorkspaceDocs();
      const docValues = Object.values(docs);
      const totalDocSize = docValues.length > 0
        ? docValues.reduce((sum, d) => sum + (d.size || 0), 0)
        : 0;
      if (totalDocSize > 20000) {
        patterns.push(`Workspace context docs total ~${(totalDocSize / 1024).toFixed(1)}KB`);
        recommendations.push("Consolidate or slim workspace docs — every byte is injected each turn");
        wasteScore += 8;
      }

      // 5. Sub-agent count — check multiple possible state locations
      let subAgentCount = 0;
      const stateLocations = [
        join(STATE_DIR, "session.json"),
        join(PROJECT_DIR, ".claude", "state.json"),
      ];
      for (const loc of stateLocations) {
        if (!existsSync(loc)) continue;
        try {
          const content = readFileSync(loc, "utf-8");
          const state = JSON.parse(content);
          subAgentCount = state.subAgents?.length || state.sub_agents?.length || 0;
          if (subAgentCount > 0) break;
        } catch { /* ignore malformed state */ }
      }
      if (subAgentCount > 5) {
        patterns.push(`${subAgentCount} sub-agents spawned this session`);
        recommendations.push("Batch related work to reduce sub-agent overhead — each carries full context");
        wasteScore += subAgentCount * 3;
      }

      // 6. Deep mode: tool call pattern analysis (with size limit)
      let repeatedReads: Record<string, number> = {};
      let totalToolCalls = 0;

      if (check_mode === "deep") {
        const toolLogPath = join(STATE_DIR, "tool-calls.jsonl");
        if (existsSync(toolLogPath)) {
          try {
            const stat = statSync(toolLogPath);
            if (stat.size > MAX_TOOL_LOG_BYTES) {
              patterns.push(`Tool call log is ${(stat.size / 1024 / 1024).toFixed(1)}MB — too large for full analysis, sampling tail`);
              wasteScore += 5;
            }

            // Read with size cap: take the tail if too large
            const raw = stat.size <= MAX_TOOL_LOG_BYTES
              ? readFileSync(toolLogPath, "utf-8")
              : run(`tail -c ${MAX_TOOL_LOG_BYTES} '${shellEscape(toolLogPath)}'`);

            const lines = raw.trim().split("\n").filter(Boolean);
            totalToolCalls = lines.length;
            const readCounts: Record<string, number> = {};

            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                const tool = entry.tool || entry.name || "";
                const filePath = entry.params?.path || entry.params?.file_path || "";
                if ((tool === "Read" || tool === "read") && filePath) {
                  readCounts[filePath] = (readCounts[filePath] || 0) + 1;
                }
              } catch { /* skip malformed lines */ }
            }

            repeatedReads = Object.fromEntries(
              Object.entries(readCounts).filter(([, count]) => count >= 3)
            );

            if (Object.keys(repeatedReads).length > 0) {
              const top = Object.entries(repeatedReads)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([f, c]) => `${f} (${c}x)`)
                .join(", ");
              patterns.push(`Repeated file reads: ${top}`);
              recommendations.push("Cache file contents or use targeted reads (offset/limit) to avoid re-reading");
              wasteScore += Object.keys(repeatedReads).length * 6;
            }

            if (totalToolCalls > 100) {
              patterns.push(`High tool call volume: ${totalToolCalls} calls in session`);
              recommendations.push("Plan multi-step work before executing — fewer, more precise tool calls save tokens");
              wasteScore += 10;
            }
          } catch { /* ignore */ }
        }
      }

      // 7. Session action hints
      if (session_actions) {
        const lower = session_actions.toLowerCase();
        if (lower.includes("read") && lower.includes("same file")) {
          patterns.push("User reports repeated reads of same file");
          wasteScore += 10;
        }
        if (lower.includes("full file") || lower.includes("entire file")) {
          patterns.push("User reports full-file reads where partial would suffice");
          wasteScore += 8;
        }
      }

      // Score calculation
      const clampedWaste = Math.min(wasteScore, 100);
      const grade =
        clampedWaste <= 10 ? "A" :
        clampedWaste <= 25 ? "B" :
        clampedWaste <= 45 ? "C" :
        clampedWaste <= 65 ? "D" : "F";

      const savingsEstimate =
        clampedWaste <= 10 ? "< 5%" :
        clampedWaste <= 25 ? "5–15%" :
        clampedWaste <= 45 ? "15–30%" :
        clampedWaste <= 65 ? "30–50%" : "50%+";

      if (patterns.length === 0) {
        patterns.push("No significant token waste patterns detected");
      }
      if (recommendations.length === 0) {
        recommendations.push("Session looks efficient — keep using targeted reads and incremental commits");
      }

      // Persist audit state
      saveState("token_audit", {
        ts: now(),
        grade,
        wasteScore: clampedWaste,
        savingsEstimate,
        patternsFound: patterns.length,
        mode: check_mode,
      });

      const report = [
        `## Token Efficiency Audit (${check_mode} mode)`,
        "",
        `**Score: ${grade}** (waste index: ${clampedWaste}/100)`,
        `**Estimated savings if addressed: ${savingsEstimate}**`,
        "",
        "### Grading Scale",
        "| Grade | Waste | Meaning |",
        "|-------|-------|---------|",
        "| A | 0–10 | Minimal waste |",
        "| B | 11–25 | Minor inefficiencies |",
        "| C | 26–45 | Moderate — worth addressing |",
        "| D | 46–65 | Significant token burn |",
        "| F | 66+ | Severe — immediate action needed |",
        "",
        "### Working Set",
        `- Dirty files: ${dirtyCount}`,
        `- Uncommitted changes: ~${totalChanges} lines`,
        `- Est. context from dirty files: ~${Math.round(estimatedContextTokens).toLocaleString()} tokens`,
        `- Sub-agents spawned: ${subAgentCount}`,
        ...(check_mode === "deep" ? [`- Total tool calls analyzed: ${totalToolCalls}`, `- Files read 3+ times: ${Object.keys(repeatedReads).length}`] : []),
        "",
        "### Waste Patterns",
        ...patterns.map((p) => `- ⚠️ ${p}`),
        "",
        "### Recommendations",
        ...recommendations.map((r) => `- 💡 ${r}`),
      ].join("\n");

      return { content: [{ type: "text" as const, text: report }] };
    }
  );
}
