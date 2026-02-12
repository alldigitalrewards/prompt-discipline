// CATEGORY 4: sharpen_followup — Follow-up Specificity
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { now } from "../lib/state.js";

export function registerSharpenFollowup(server: McpServer): void {
  server.tool(
    "sharpen_followup",
    `Detects vague follow-up prompts and sharpens them with specific files, scope, and context from previous actions and git state. Call when the user says things like "fix it", "do the same for the others", "now the tests" without specifying files or scope.`,
    {
      followup_message: z.string().describe("The user's follow-up message to analyze"),
      previous_action: z.string().describe("Description of what was just done"),
      previous_files: z.array(z.string()).optional().describe("Files involved in the previous action"),
    },
    async ({ followup_message, previous_action, previous_files }) => {
      const msg = followup_message.trim();
      const assumptions: string[] = [];
      const questions: string[] = [];
      let confidence: "high" | "medium" | "low" = "high";

      // Vagueness detection
      const pronounPattern = /\b(it|them|this|that|those|the others?|these)\b/gi;
      const scopePattern = /\b(all|everything|the rest|everywhere|each one|every)\b/gi;
      const hasPathRef = /[\/\\]|\.(?:ts|js|tsx|jsx|py|rs|go|md|json|yaml|yml|toml|css|html|sh)\b/.test(msg);
      const isBareCommand = msg.length < 30 && !hasPathRef;

      const pronounMatches = [...msg.matchAll(pronounPattern)].map(m => m[0].toLowerCase());
      const scopeMatches = [...msg.matchAll(scopePattern)].map(m => m[0].toLowerCase());

      const vagueSignals: string[] = [];
      if (pronounMatches.length > 0) vagueSignals.push(`pronouns without antecedents: ${[...new Set(pronounMatches)].join(", ")}`);
      if (scopeMatches.length > 0) vagueSignals.push(`scope words without specifics: ${[...new Set(scopeMatches)].join(", ")}`);
      if (isBareCommand) vagueSignals.push("bare command with no file/path reference");

      // If no vagueness detected, pass through
      if (vagueSignals.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              original: msg,
              sharpened: msg,
              confidence: "high",
              assumptions: [],
              vague_signals: [],
              note: "Follow-up is already specific enough.",
            }, null, 2),
          }],
        };
      }

      // Gather context to resolve ambiguity
      const contextFiles: string[] = [...(previous_files ?? [])];
      const recentChanged = run("git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || git diff --name-only 2>/dev/null")
        .split("\n").filter(Boolean);
      const untrackedOrModified = run("git status --porcelain 2>/dev/null")
        .split("\n").filter(Boolean).map(l => l.slice(3));

      const allKnownFiles = [...new Set([...contextFiles, ...recentChanged, ...untrackedOrModified])].filter(Boolean);

      let sharpened = msg;

      // Resolve "it" / "this" / "that"
      if (pronounMatches.some(p => ["it", "this", "that"].includes(p))) {
        if (contextFiles.length === 1) {
          sharpened = sharpened.replace(/\b(it|this|that)\b/i, contextFiles[0]);
          assumptions.push(`Resolved "${pronounMatches[0]}" → ${contextFiles[0]} (only file from previous action)`);
        } else if (contextFiles.length > 1) {
          confidence = "low";
          questions.push(`Which file do you mean? Previous action touched: ${contextFiles.join(", ")}`);
        } else if (recentChanged.length === 1) {
          sharpened = sharpened.replace(/\b(it|this|that)\b/i, recentChanged[0]);
          assumptions.push(`Resolved "${pronounMatches[0]}" → ${recentChanged[0]} (only recent git change)`);
          confidence = "medium";
        } else {
          confidence = "low";
          questions.push("Which file or component are you referring to? No single obvious target found.");
        }
      }

      // Resolve "them" / "the others" / "these" / "those"
      if (pronounMatches.some(p => ["them", "the others", "those", "these"].includes(p))) {
        const otherFiles = allKnownFiles.filter(f => !contextFiles.slice(0, 1).includes(f));
        if (otherFiles.length > 0 && otherFiles.length <= 10) {
          sharpened = sharpened.replace(/\b(them|the others|those|these)\b/i, otherFiles.join(", "));
          assumptions.push(`Resolved to remaining files: ${otherFiles.join(", ")}`);
          confidence = otherFiles.length <= 3 ? "medium" : "low";
        } else if (otherFiles.length > 10) {
          confidence = "low";
          questions.push(`Found ${otherFiles.length} candidate files — too many to assume. Which subset do you mean?`);
        } else {
          confidence = "low";
          questions.push('What does "the others" refer to? No additional files found in context.');
        }
      }

      // Resolve scope words
      if (scopeMatches.length > 0 && !hasPathRef) {
        if (allKnownFiles.length > 0 && allKnownFiles.length <= 8) {
          assumptions.push(`Scope "${scopeMatches[0]}" interpreted as: ${allKnownFiles.join(", ")}`);
          confidence = confidence === "high" ? "medium" : "low";
        } else if (allKnownFiles.length > 8) {
          confidence = "low";
          questions.push(`"${scopeMatches[0]}" is ambiguous — ${allKnownFiles.length} files in scope. Please specify a directory or glob pattern.`);
        } else {
          confidence = "low";
          questions.push(`What does "${scopeMatches[0]}" cover? No files found in recent context.`);
        }
      }

      // Bare command enrichment
      if (isBareCommand && contextFiles.length > 0) {
        sharpened = `${sharpened} in ${contextFiles.join(", ")}`;
        assumptions.push(`Added file scope from previous action: ${contextFiles.join(", ")}`);
        if (confidence === "high") confidence = "medium";
      }

      // If we couldn't resolve, ask
      if (questions.length > 0 && confidence === "low") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              original: msg,
              sharpened: null,
              confidence: "low",
              vague_signals: vagueSignals,
              assumptions,
              clarifying_questions: questions,
              previous_action,
              available_context: allKnownFiles.slice(0, 20),
              timestamp: now(),
            }, null, 2),
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            original: msg,
            sharpened,
            confidence,
            vague_signals: vagueSignals,
            assumptions,
            clarifying_questions: questions.length > 0 ? questions : undefined,
            previous_action,
            resolved_files: allKnownFiles.slice(0, 20),
            timestamp: now(),
          }, null, 2),
        }],
      };
    }
  );
}
