// CATEGORY 4: sharpen_followup — Follow-up Specificity
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";
import { now } from "../lib/state.js";

/** Parse git porcelain output into deduplicated file paths, handling renames (R/C) */
function parsePortelainFiles(output: string): string[] {
  if (!output.trim()) return [];
  const files = new Set<string>();
  for (const line of output.split("\n").filter(Boolean)) {
    if (line.length < 4) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) {
      // "R  old -> new" — include both old and new
      const parts = rest.split(" -> ");
      parts.forEach((p) => { const t = p.trim(); if (t) files.add(t); });
    } else {
      const t = rest.trim();
      if (t) files.add(t);
    }
  }
  return [...files];
}

/** Get recently changed files, safe for first commit / shallow clones */
function getRecentChangedFiles(): string[] {
  // Try HEAD~1..HEAD, fall back to just staged, then unstaged
  const commands = [
    "git diff --name-only HEAD~1 HEAD 2>/dev/null",
    "git diff --name-only --cached 2>/dev/null",
    "git diff --name-only 2>/dev/null",
  ];
  const results = new Set<string>();
  for (const cmd of commands) {
    const out = run(cmd);
    if (out) out.split("\n").filter(Boolean).forEach((f) => results.add(f));
    if (results.size > 0) break; // first successful source is enough
  }
  return [...results];
}

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

      const pronounMatches = [...new Set([...msg.matchAll(pronounPattern)].map(m => m[0].toLowerCase()))];
      const scopeMatches = [...new Set([...msg.matchAll(scopePattern)].map(m => m[0].toLowerCase()))];

      const vagueSignals: string[] = [];
      if (pronounMatches.length > 0) vagueSignals.push(`pronouns without antecedents: ${pronounMatches.join(", ")}`);
      if (scopeMatches.length > 0) vagueSignals.push(`scope words without specifics: ${scopeMatches.join(", ")}`);
      if (isBareCommand) vagueSignals.push("bare command with no file/path reference");

      // If no vagueness detected, pass through
      if (vagueSignals.length === 0) {
        const output = [
          "## Follow-up Analysis",
          "",
          `**Original:** ${msg}`,
          `**Sharpened:** ${msg}`,
          `**Confidence:** high`,
          "",
          "_Follow-up is already specific enough — no changes needed._",
        ].join("\n");
        return { content: [{ type: "text" as const, text: output }] };
      }

      // Gather context to resolve ambiguity
      const contextFiles: string[] = [...(previous_files ?? [])];
      const recentChanged = getRecentChangedFiles();
      const porcelainOutput = run("git status --porcelain 2>/dev/null");
      const untrackedOrModified = parsePortelainFiles(porcelainOutput);

      const allKnownFiles = [...new Set([...contextFiles, ...recentChanged, ...untrackedOrModified])].filter(Boolean);

      let sharpened = msg;

      // Resolve singular pronouns: "it" / "this" / "that"
      const singularPronouns = pronounMatches.filter(p => ["it", "this", "that"].includes(p));
      if (singularPronouns.length > 0) {
        if (contextFiles.length === 1) {
          for (const p of singularPronouns) {
            sharpened = sharpened.replace(new RegExp(`\\b${p}\\b`, "i"), contextFiles[0]);
          }
          assumptions.push(`Resolved ${singularPronouns.map(p => `"${p}"`).join(", ")} → ${contextFiles[0]} (only file from previous action)`);
        } else if (contextFiles.length > 1) {
          confidence = "low";
          questions.push(`Which file do you mean? Previous action touched: ${contextFiles.join(", ")}`);
        } else if (recentChanged.length === 1) {
          for (const p of singularPronouns) {
            sharpened = sharpened.replace(new RegExp(`\\b${p}\\b`, "i"), recentChanged[0]);
          }
          assumptions.push(`Resolved ${singularPronouns.map(p => `"${p}"`).join(", ")} → ${recentChanged[0]} (only recent git change)`);
          confidence = "medium";
        } else {
          confidence = "low";
          questions.push("Which file or component are you referring to? No single obvious target found.");
        }
      }

      // Resolve plural pronouns: "them" / "the others" / "these" / "those"
      const pluralPronouns = pronounMatches.filter(p => ["them", "the others", "those", "these"].includes(p));
      if (pluralPronouns.length > 0) {
        const otherFiles = allKnownFiles.filter(f => !contextFiles.slice(0, 1).includes(f));
        if (otherFiles.length > 0 && otherFiles.length <= 10) {
          for (const p of pluralPronouns) {
            sharpened = sharpened.replace(new RegExp(`\\b${p.replace(/\s+/g, "\\s+")}\\b`, "i"), otherFiles.join(", "));
          }
          assumptions.push(`Resolved ${pluralPronouns.map(p => `"${p}"`).join(", ")} → remaining files: ${otherFiles.join(", ")}`);
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

      // Build markdown output
      const lines = [
        "## Follow-up Analysis",
        "",
        `**Original:** ${msg}`,
        `**Sharpened:** ${confidence === "low" && questions.length > 0 ? "(needs clarification)" : sharpened}`,
        `**Confidence:** ${confidence}`,
        `**Previous action:** ${previous_action}`,
        "",
      ];

      if (vagueSignals.length > 0) {
        lines.push("### Vague Signals Detected");
        vagueSignals.forEach((s) => lines.push(`- ⚠️ ${s}`));
        lines.push("");
      }

      if (assumptions.length > 0) {
        lines.push("### Assumptions Made");
        assumptions.forEach((a) => lines.push(`- ${a}`));
        lines.push("");
      }

      if (questions.length > 0) {
        lines.push("### Clarifying Questions");
        questions.forEach((q) => lines.push(`- ❓ ${q}`));
        lines.push("");
      }

      if (allKnownFiles.length > 0) {
        lines.push("### Available Context Files");
        allKnownFiles.slice(0, 20).forEach((f) => lines.push(`- \`${f}\``));
        lines.push("");
      }

      lines.push(`_Generated ${now()}_`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
