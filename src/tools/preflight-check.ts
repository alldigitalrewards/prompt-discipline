// Unified preflight_check — single entry point that triages and chains tools
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { triagePrompt, type TriageLevel, type TriageResult } from "../lib/triage.js";
import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { PROJECT_DIR } from "../lib/files.js";
import { run, getBranch, getStatus, getRecentCommits, getDiffFiles, getStagedFiles } from "../lib/git.js";
import { now } from "../lib/state.js";
import { findWorkspaceDocs } from "../lib/files.js";
import { getConfig } from "../lib/config.js";
import { searchSemantic } from "../lib/timeline-db.js";
import { basename, join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract file paths from prompt text */
function extractFilePaths(prompt: string): string[] {
  const matches = prompt.match(/[\w\-./\\]+\.\w{1,6}/g) || [];
  return [...new Set(matches)];
}

/** Verify files exist and return stats */
function verifyFiles(paths: string[]): string[] {
  const lines: string[] = [];
  for (const p of paths) {
    const abs = resolve(PROJECT_DIR, p);
    if (!abs.startsWith(resolve(PROJECT_DIR))) continue; // path traversal guard
    if (existsSync(abs)) {
      const s = statSync(abs);
      lines.push(`✅ \`${p}\` — ${s.size} bytes, modified ${s.mtime.toISOString().slice(0, 16)}`);
    } else {
      lines.push(`❌ \`${p}\` — not found`);
    }
  }
  return lines;
}

/** Get related project paths from config + env */
function getRelatedProjects(): { alias: string; path: string }[] {
  // From config
  const config = getConfig();
  const projects = [...config.related_projects];

  // From env (legacy)
  const envRelated = process.env.PREFLIGHT_RELATED;
  if (envRelated) {
    for (const p of envRelated.split(",").map(s => s.trim()).filter(Boolean)) {
      if (!projects.some(pr => pr.path === p)) {
        projects.push({ alias: basename(p), path: p });
      }
    }
  }

  return projects.filter(p => existsSync(p.path));
}

/** Search related projects for relevant context */
async function searchRelated(prompt: string, projects: { alias: string; path: string }[]): Promise<string[]> {
  if (projects.length === 0) return [];
  const results: string[] = [];

  for (const query of [`${prompt} type interface schema`, `${prompt} API endpoint`]) {
    try {
      const hits = await searchSemantic(query, {
        project_dirs: projects.map(p => p.path),
        limit: 3,
      });
      for (const hit of hits) {
        const name = basename(hit.project);
        const content = hit.content.slice(0, 200);
        const file = hit.source_file ? ` (${hit.source_file})` : "";
        results.push(`- **${name}:** ${content}${file}`);
      }
    } catch { /* skip */ }
  }

  return results.slice(0, 6);
}

/** Inline clarify logic — extracts intent signals and git state */
function buildClarifySection(prompt: string): string[] {
  const sections: string[] = [];
  const branch = getBranch();
  const status = getStatus();
  const recentCommits = getRecentCommits(5);
  const dirtyCount = status ? status.split("\n").filter(Boolean).length : 0;

  sections.push(`### Git State\nBranch: \`${branch}\` | Dirty files: ${dirtyCount}`);
  if (status) sections.push(`\`\`\`\n${status}\n\`\`\``);

  sections.push(`Recent commits:\n\`\`\`\n${recentCommits || "(none)"}\n\`\`\``);

  // Workspace priorities
  const docs = findWorkspaceDocs();
  const priorityDocs = Object.entries(docs)
    .filter(([n]) => /gap|roadmap|current|todo|changelog/i.test(n))
    .slice(0, 3);
  if (priorityDocs.length > 0) {
    sections.push(`### Workspace Priorities\n${priorityDocs.map(([n]) => `- \`${n}\``).join("\n")}`);
  }

  // Ambiguity signals
  const issues: string[] = [];
  if (/\b(it|them|the thing|that|those|this|these)\b/i.test(prompt)) issues.push("Contains vague pronouns — clarify what 'it'/'them' refers to");
  if (/\b(fix|update|change|refactor|improve)\b/i.test(prompt) && !extractFilePaths(prompt).length) issues.push("Vague verb without specific file targets");
  if (prompt.trim().length < 40) issues.push("Very short prompt — likely missing context");

  if (issues.length > 0) {
    sections.push(`### ⚠️ Clarification Needed\n${issues.map(i => `- ${i}`).join("\n")}`);
  }

  return sections;
}

/** Build scope section for multi-step */
function buildScopeSection(prompt: string): string[] {
  const sections: string[] = [];
  const filePaths = extractFilePaths(prompt);
  const fileVerification = verifyFiles(filePaths);

  if (fileVerification.length > 0) {
    sections.push(`### Referenced Files\n${fileVerification.join("\n")}`);
  }

  // Estimate complexity
  const hasMultipleFiles = filePaths.length > 3;
  const hasMultipleDirs = new Set(filePaths.map(f => f.split("/")[0])).size > 2;
  const complexity = hasMultipleFiles && hasMultipleDirs ? "LARGE" : filePaths.length > 1 ? "MEDIUM" : "SMALL";
  sections.push(`### Scope: ${complexity}`);

  return sections;
}

/** Build sequence section for multi-step */
function buildSequenceSection(prompt: string): string[] {
  // Split prompt into sub-tasks
  const subtasks: string[] = [];

  // Split on "and", "then", numbered lists, bullet points
  const parts = prompt
    .split(/\b(?:then|after that|next|finally)\b|(?:,\s*and\s+)|(?:\band\b(?=\s+(?:update|add|remove|create|fix|change|refactor|implement|deploy)))/i)
    .map(s => s.trim())
    .filter(s => s.length > 5);

  if (parts.length > 1) {
    for (let i = 0; i < parts.length; i++) {
      const risk = /schema|migrat|database|config|env|deploy/i.test(parts[i]) ? "🔴 HIGH" :
                   /api|route|endpoint/i.test(parts[i]) ? "🟡 MEDIUM" : "🟢 LOW";
      subtasks.push(`${i + 1}. ${parts[i].charAt(0).toUpperCase() + parts[i].slice(1)} — Risk: ${risk}`);
    }
  } else {
    subtasks.push(`1. ${prompt.slice(0, 100)} — Risk: 🟡 MEDIUM`);
  }

  return [
    `### Execution Plan`,
    ...subtasks,
    "",
    "### Checkpoints",
    "- [ ] Verify after each step before proceeding",
    "- [ ] Run tests between steps that touch different layers",
    "- [ ] Commit after each successful step",
  ];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPreflightCheck(server: McpServer): void {
  server.tool(
    "preflight_check",
    "Run a preflight check on your prompt before Claude starts working. Catches vague instructions, surfaces missing context from related services, and builds execution plans for complex tasks.",
    {
      prompt: z.string().describe("The user's prompt to check"),
      force_level: z.enum(["skip", "light", "full"]).optional().describe("Override triage — skip passes through, light does clarify only, full does everything"),
    },
    async ({ prompt, force_level }) => {
      const ts = now();

      // --- Force level overrides ---
      if (force_level === "skip") {
        return { content: [{ type: "text" as const, text: "✅ Preflight: clear to proceed." }] };
      }

      // --- Triage ---
      const preflightConfig = getConfig();
      const triageConfig = {
        alwaysCheck: preflightConfig.triage.rules.always_check,
        skip: preflightConfig.triage.rules.skip,
        crossServiceKeywords: preflightConfig.triage.rules.cross_service_keywords,
        strictness: preflightConfig.triage.strictness,
        relatedAliases: preflightConfig.related_projects.map(p => p.alias),
      };
      const triage = triagePrompt(prompt, triageConfig);
      let effectiveLevel: TriageLevel = triage.level;

      if (force_level === "light") effectiveLevel = "ambiguous";
      if (force_level === "full") effectiveLevel = "multi-step";

      // --- Trivial ---
      if (effectiveLevel === "trivial") {
        return { content: [{ type: "text" as const, text: "✅ Preflight: clear to proceed." }] };
      }

      const sections: string[] = [
        `# 🛫 Preflight Check`,
        `_${ts} | Triage: **${effectiveLevel}** (confidence: ${triage.confidence.toFixed(2)})_`,
        `_Reasons: ${triage.reasons.join("; ")}_`,
      ];

      // --- Clear: verify files ---
      if (effectiveLevel === "clear") {
        const filePaths = extractFilePaths(prompt);
        const verification = verifyFiles(filePaths);
        if (verification.length > 0) {
          sections.push("", "## File Verification", ...verification);
        }
        sections.push("", "✅ Preflight: clear to proceed.");
        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      }

      // --- Ambiguous+: clarify ---
      sections.push("", "## Clarification", ...buildClarifySection(prompt));

      if (effectiveLevel === "ambiguous") {
        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      }

      // --- Cross-service: clarify + related projects ---
      const relatedProjects = getRelatedProjects();
      if (effectiveLevel === "cross-service" || effectiveLevel === "multi-step") {
        if (relatedProjects.length > 0) {
          sections.push("", `## Related Services (${relatedProjects.length} configured)`);
          sections.push(relatedProjects.map(p => `- **${p.alias}:** \`${p.path}\``).join("\n"));

          const relatedContext = await searchRelated(prompt, relatedProjects);
          if (relatedContext.length > 0) {
            sections.push("", "### Relevant Context from Related Projects", ...relatedContext);
          }

          if (triage.cross_service_hits && triage.cross_service_hits.length > 0) {
            sections.push("", `### Cross-Service Matches: ${triage.cross_service_hits.join(", ")}`);
          }
        }
      }

      if (effectiveLevel === "cross-service") {
        sections.push("", ...buildScopeSection(prompt));
        return { content: [{ type: "text" as const, text: sections.join("\n") }] };
      }

      // --- Multi-step: clarify + scope + sequence ---
      sections.push("", "## Scope", ...buildScopeSection(prompt));
      sections.push("", "## Sequence", ...buildSequenceSection(prompt));

      return { content: [{ type: "text" as const, text: sections.join("\n") }] };
    }
  );
}
