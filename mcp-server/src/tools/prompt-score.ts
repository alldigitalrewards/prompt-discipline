// =============================================================================
// prompt_score — Gamified prompt quality scoring
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

interface ScoreHistory {
  scores: number[];
  sessionStart: string;
}

const STATE_DIR = join(homedir(), ".prompt-discipline");
const STATE_FILE = join(STATE_DIR, "score-history.json");

async function loadHistory(): Promise<ScoreHistory> {
  try {
    const data = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { scores: [], sessionStart: new Date().toISOString() };
  }
}

async function saveHistory(history: ScoreHistory): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(history, null, 2));
}

interface ScoreResult {
  specificity: number;
  scope: number;
  actionability: number;
  doneCondition: number;
  total: number;
  grade: string;
  feedback: string[];
}

function scorePrompt(text: string): ScoreResult {
  const feedback: string[] = [];
  let specificity = 0;
  let scope = 0;
  let actionability = 0;
  let doneCondition = 0;

  // Specificity: file paths, function names, specific identifiers
  if (/[\/\\][\w.-]+\.\w+/.test(text) || /`[^`]+`/.test(text)) {
    specificity = 25;
  } else if (/\b(file|component|function|class|module|test|route)\b/i.test(text)) {
    specificity = 15;
    feedback.push("📁 Name the specific file/function for +10 points");
  } else {
    specificity = 5;
    feedback.push("📁 No specific targets mentioned — which file? which function?");
  }

  // Scope: bounded task
  if (/\b(only|just|single|one|specific|this)\b/i.test(text) || text.length > 100) {
    scope = 25;
  } else if (/\b(all|every|entire|whole)\b/i.test(text)) {
    scope = 10;
    feedback.push("🎯 'All/every' is broad — can you narrow the scope?");
  } else {
    scope = 10;
    feedback.push("🎯 Scope unclear — how much should change?");
  }

  // Actionability: clear verb
  const actionVerbs = /\b(add|remove|rename|refactor|fix|create|delete|update|change|replace|move|extract|implement|write|test|migrate)\b/i;
  if (actionVerbs.test(text)) {
    actionability = 25;
  } else if (/\b(make|do|handle|work|improve|clean)\b/i.test(text)) {
    actionability = 15;
    feedback.push("⚡ Vague verb — 'fix' beats 'make work', 'extract' beats 'clean up'");
  } else {
    actionability = 5;
    feedback.push("⚡ What's the action? Use a specific verb (add, remove, rename, etc.)");
  }

  // Done condition: verifiable outcome
  if (/\b(should|must|expect|assert|return|output|pass|fail|error|log|print|display)\b/i.test(text)) {
    doneCondition = 25;
  } else if (/\?$/.test(text.trim())) {
    doneCondition = 20; // questions are inherently verifiable
  } else {
    doneCondition = 5;
    feedback.push("✅ No done condition — how will you know it worked?");
  }

  const total = specificity + scope + actionability + doneCondition;

  let grade: string;
  if (total >= 90) grade = "A+";
  else if (total >= 85) grade = "A";
  else if (total >= 80) grade = "A-";
  else if (total >= 75) grade = "B+";
  else if (total >= 70) grade = "B";
  else if (total >= 65) grade = "B-";
  else if (total >= 60) grade = "C+";
  else if (total >= 55) grade = "C";
  else if (total >= 45) grade = "D";
  else grade = "F";

  if (feedback.length === 0) {
    feedback.push("🏆 Excellent prompt! Clear target, scope, action, and done condition.");
  }

  return { specificity, scope, actionability, doneCondition, total, grade, feedback };
}

export function registerPromptScore(server: McpServer): void {
  server.tool(
    "prompt_score",
    "Score a prompt on specificity, scope, actionability, and done-condition. Returns a letter grade with specific improvement tips.",
    {
      prompt: z.string().describe("The prompt text to score"),
    },
    async ({ prompt }) => {
      const result = scorePrompt(prompt);
      const history = await loadHistory();
      history.scores.push(result.total);
      await saveHistory(history);

      const avg = history.scores.length > 0
        ? (history.scores.reduce((a, b) => a + b, 0) / history.scores.length).toFixed(0)
        : result.total.toString();

      const report = [
        `🎯 Prompt Score: ${result.grade} (${result.total}/100)`,
        `────────────────────────`,
        `Specificity:    ${result.specificity}/25  ${result.specificity >= 20 ? "✓" : "✗"}`,
        `Scope:          ${result.scope}/25  ${result.scope >= 20 ? "✓" : "✗"}`,
        `Actionability:  ${result.actionability}/25  ${result.actionability >= 20 ? "✓" : "✗"}`,
        `Done condition: ${result.doneCondition}/25  ${result.doneCondition >= 20 ? "✓" : "✗"}`,
        ``,
        ...result.feedback,
        ``,
        `Session average: ${avg}/100 (${history.scores.length} prompts scored)`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: report }],
      };
    }
  );
}
