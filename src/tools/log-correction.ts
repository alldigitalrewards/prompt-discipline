import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBranch } from "../lib/git.js";
import { appendLog, readLog, now } from "../lib/state.js";

export function registerLogCorrection(server: McpServer): void {
  server.tool(
    "log_correction",
    `Log when the user corrected your action. Tracks error patterns over time to identify what kinds of prompts lead to wrong outputs. Call this whenever the user says "no", "wrong", "not that", "I meant", or otherwise corrects your work.`,
    {
      what_user_said: z.string().describe("The user's correction message"),
      what_you_did_wrong: z.string().describe("What you did that was incorrect"),
      root_cause: z.string().describe("Why — was it a vague prompt, stale context, wrong assumption, or something else?"),
      category: z.enum(["vague_prompt", "stale_context", "wrong_assumption", "wrong_file", "wrong_scope", "other"]).describe("Error category"),
    },
    async ({ what_user_said, what_you_did_wrong, root_cause, category }) => {
      const entry = {
        timestamp: now(),
        branch: getBranch(),
        user_said: what_user_said,
        wrong_action: what_you_did_wrong,
        root_cause,
        category,
      };
      appendLog("corrections.jsonl", entry);

      const corrections = readLog("corrections.jsonl");
      const categoryCounts: Record<string, number> = {};
      for (const c of corrections) {
        categoryCounts[c.category] = (categoryCounts[c.category] || 0) + 1;
      }

      const total = corrections.length;
      const topCategory = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1])[0];

      return {
        content: [{
          type: "text" as const,
          text: `## Correction Logged ✅

**Category**: ${category}
**Root cause**: ${root_cause}

### Error Pattern Summary (${total} total corrections)
${Object.entries(categoryCounts).map(([k, v]) => `- ${k}: ${v} (${Math.round(v / total * 100)}%)`).join("\n")}

### Most Common: ${topCategory ? `${topCategory[0]} (${topCategory[1]}x)` : "first correction"}

${topCategory?.[0] === "vague_prompt" ? "💡 Most errors come from vague prompts. The `clarify_intent` tool should be called more aggressively." : ""}
${topCategory?.[0] === "stale_context" ? "💡 Most errors from stale context. Call `checkpoint` more often and read workspace docs at session start." : ""}
${topCategory?.[0] === "wrong_file" ? "💡 Most errors from wrong files. Always verify file paths with `find` or `ls` before editing." : ""}`,
        }],
      };
    }
  );
}
