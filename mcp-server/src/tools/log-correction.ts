import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBranch } from "../lib/git.js";
import { appendLog, readLog, now } from "../lib/state.js";

const CATEGORIES = [
  "vague_prompt",
  "stale_context",
  "wrong_assumption",
  "wrong_file",
  "wrong_scope",
  "misread_intent",
  "incomplete_work",
  "style_mismatch",
  "other",
] as const;

export function registerLogCorrection(server: McpServer): void {
  server.tool(
    "log_correction",
    `Log when the user corrected your action. Tracks error patterns over time to identify what kinds of prompts lead to wrong outputs. Call this whenever the user says "no", "wrong", "not that", "I meant", or otherwise corrects your work.`,
    {
      what_user_said: z.string().describe("The user's correction message"),
      what_you_did_wrong: z.string().describe("What you did that was incorrect"),
      root_cause: z.string().describe("Why — was it a vague prompt, stale context, wrong assumption, or something else?"),
      category: z.enum(CATEGORIES).describe("Error category"),
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
      const total = corrections.length;

      if (total === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `## Correction Logged ✅\n\n**Category**: ${category}\n**Root cause**: ${root_cause}\n\nFirst correction logged.`,
          }],
        };
      }

      const categoryCounts: Record<string, number> = {};
      for (const c of corrections) {
        const cat = c.category || "other";
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
      }

      const sorted = Object.entries(categoryCounts).sort((a, b) => b[1] - a[1]);
      const topCategory = sorted[0];

      const hints: Record<string, string> = {
        vague_prompt: "💡 Most errors come from vague prompts. Call `clarify_intent` more aggressively.",
        stale_context: "💡 Most errors from stale context. Call `checkpoint` more often and read workspace docs at session start.",
        wrong_file: "💡 Most errors from wrong files. Always verify file paths before editing.",
        wrong_assumption: "💡 Most errors from wrong assumptions. Ask clarifying questions instead of guessing.",
        wrong_scope: "💡 Most errors from wrong scope. Confirm boundaries before starting work.",
        misread_intent: "💡 Most errors from misread intent. Re-read user messages carefully before acting.",
        incomplete_work: "💡 Most errors from incomplete work. Use `verify_completion` before declaring done.",
        style_mismatch: "💡 Most errors from style mismatches. Check existing patterns before writing new code.",
      };

      return {
        content: [{
          type: "text" as const,
          text: `## Correction Logged ✅

**Category**: ${category}
**Root cause**: ${root_cause}

### Error Pattern Summary (${total} total corrections)
${sorted.map(([k, v]) => `- ${k}: ${v} (${Math.round(v / total * 100)}%)`).join("\n")}

### Most Common: ${topCategory[0]} (${topCategory[1]}x)

${hints[topCategory[0]] || ""}`,
        }],
      };
    }
  );
}
