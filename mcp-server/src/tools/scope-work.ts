// CATEGORY 1: scope_work — Plans
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getBranch, getRecentCommits, getStatus } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs, PROJECT_DIR } from "../lib/files.js";
import { now } from "../lib/state.js";
import { existsSync } from "fs";
import { join, normalize, resolve } from "path";

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "should", "would", "could",
  "into", "have", "been", "will", "just", "also", "when", "then", "than", "what",
  "where", "which", "there", "their", "about", "after", "before", "does", "make",
  "like", "some", "each", "only", "need", "want", "please", "update", "change",
]);

/** Shell-escape a string for use inside single quotes */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/** Safely parse git porcelain status lines */
function parsePortelainFiles(porcelain: string): string[] {
  if (!porcelain.trim()) return [];
  return porcelain.split("\n").filter(Boolean).flatMap((line) => {
    // Porcelain format: XY filename  or  XY orig -> renamed
    if (line.length < 4) return [];
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    // Handle renames/copies: "R  old -> new"
    if (status.startsWith("R") || status.startsWith("C")) {
      const parts = rest.split(" -> ");
      return parts.map((p) => p.trim()).filter(Boolean);
    }
    return [rest.trim()];
  }).filter(Boolean);
}

/** Validate a dir path is within PROJECT_DIR (no traversal) */
function isSafePath(dir: string): boolean {
  const resolved = resolve(PROJECT_DIR, dir);
  return resolved.startsWith(resolve(PROJECT_DIR));
}

export function registerScopeWork(server: McpServer): void {
  server.tool(
    "scope_work",
    `Break down a task into a structured execution plan BEFORE writing any code. Call this tool whenever you receive a new task, feature request, or bug report. It analyzes the current project state (git, files, workspace docs) and returns an ordered plan with scope boundaries, complexity estimate, and done conditions. Use this to avoid scope creep and ensure you touch only what's needed.`,
    {
      task: z.string().describe("The raw user task or request to plan"),
      branch: z.string().optional().describe("Git branch to scope against (defaults to current branch)"),
    },
    async ({ task, branch }) => {
      const timestamp = now();
      const currentBranch = branch ?? getBranch();
      const recentCommits = getRecentCommits(10);
      const porcelain = run("git status --porcelain");
      const dirtyFiles = parsePortelainFiles(porcelain);
      const diffStat = dirtyFiles.length > 0 ? run("git diff --stat") : "(clean working tree)";

      // Scan for relevant files based on task keywords
      const keywords = task.toLowerCase().split(/\s+/);
      const scanDirs = [
        { pattern: "test", dirs: ["tests/", "test/", "__tests__/", "spec/"] },
        { pattern: "api", dirs: ["api/", "src/api/", "app/api/", "routes/"] },
        { pattern: "app", dirs: ["app/", "src/app/", "src/pages/"] },
        { pattern: "database", dirs: ["prisma/", "migrations/", "db/"] },
        { pattern: "prisma", dirs: ["prisma/"] },
        { pattern: "schema", dirs: ["prisma/", "schema/", "schemas/"] },
        { pattern: "component", dirs: ["components/", "src/components/"] },
        { pattern: "hook", dirs: ["hooks/", "src/hooks/"] },
        { pattern: "style", dirs: ["styles/", "src/styles/"] },
        { pattern: "config", dirs: ["config/", ".config/"] },
      ];

      const relevantDirs = new Set<string>();
      for (const { pattern, dirs } of scanDirs) {
        if (keywords.some((k) => k.includes(pattern))) {
          dirs.forEach((d) => relevantDirs.add(d));
        }
      }

      // Grep for files matching task keywords — sanitize for shell safety
      let matchedFiles = "";
      const grepTerms = keywords
        .filter((k) => k.length > 3 && !STOP_WORDS.has(k))
        .map((k) => k.replace(/[^a-z0-9_-]/g, "")) // strip non-alphanumeric to prevent injection
        .filter((k) => k.length > 2)
        .slice(0, 5);
      if (grepTerms.length > 0) {
        const pattern = shellEscape(grepTerms.join("|"));
        matchedFiles = run(`git ls-files | head -500 | grep -iE '${pattern}' | head -30`);
      }

      // Check which relevant dirs actually exist (with path traversal protection)
      const existingDirs: string[] = [];
      for (const dir of relevantDirs) {
        if (isSafePath(dir) && existsSync(join(PROJECT_DIR, dir))) {
          existingDirs.push(dir);
        }
      }

      // Workspace docs
      const workspaceDocs = findWorkspaceDocs();
      const docEntries = Object.entries(workspaceDocs);

      // Project instructions
      const claudeMd = readIfExists("CLAUDE.md", 50);
      const agentsMd = readIfExists(".claude/AGENTS.md", 50);

      // Complexity estimate — count unique files from matched + dirty
      const allTouchedFiles = [
        ...matchedFiles.split("\n").filter(Boolean),
        ...dirtyFiles,
      ];
      const uniqueFiles = [...new Set(allTouchedFiles)];
      const fileCount = uniqueFiles.length;
      const complexity = fileCount <= 3 ? "SMALL" : fileCount <= 10 ? "MEDIUM" : "LARGE";

      const dirLine = existingDirs.length > 0
        ? `**Relevant directories:** ${existingDirs.map((d) => `\`${d}\``).join(", ")}`
        : "";

      const docLines = docEntries.length > 0
        ? docEntries.map(([name]) => `- \`${name}\``).join("\n")
        : "- (none found)";

      const plan = `# 📋 Scope Work Plan
**Generated:** ${timestamp}
**Task:** ${task}
**Branch:** ${currentBranch}
**Complexity:** ${complexity} (${fileCount} files in scope)

---

## 🔍 Current State
**Recent commits:**
\`\`\`
${recentCommits || "(no commits)"}
\`\`\`

**Working tree:**
\`\`\`
${porcelain || "(clean)"}
\`\`\`

${diffStat !== "(clean working tree)" ? `**Uncommitted changes:**\n\`\`\`\n${diffStat}\n\`\`\`` : ""}

## 📁 Relevant Files
${matchedFiles ? matchedFiles.split("\n").filter(Boolean).map((f) => `- \`${f}\``).join("\n") : "- (no direct file matches — explore manually)"}

${dirLine}

## 📚 Workspace Docs
${docLines}
${claudeMd ? "- `CLAUDE.md` exists (project instructions)" : ""}
${agentsMd ? "- `.claude/AGENTS.md` exists" : ""}

---

## 📝 Execution Plan

### Steps:
1. **Understand** — Read the relevant files listed above
2. **Plan tests** — Identify or write failing tests first
3. **Implement** — Make the minimal changes needed
4. **Verify** — Run tests, check types, lint
5. **Clean up** — Remove debug code, check diff is tight

### Files to touch:
${uniqueFiles.length > 0 ? uniqueFiles.slice(0, 20).map((f) => `- [ ] \`${f}\``).join("\n") : "- [ ] (determine after reading codebase)"}

### Tests to run:
- [ ] Identify test files related to changed code
- [ ] Run full test suite before AND after changes

### 🚫 Scope Boundaries:
- Do NOT refactor unrelated code
- Do NOT update dependencies unless required by the task
- Do NOT change config files without explicit instruction
${dirtyFiles.length > 0 ? "- ⚠️ Working tree is dirty — do NOT commit unrelated changes" : ""}

### ✅ Done Conditions:
- [ ] All planned steps completed
- [ ] Tests pass
- [ ] Types check
- [ ] Diff reviewed — only expected changes present
- [ ] No TODOs or debug code left behind

---
*Use this plan as your checklist. Deviate only with explicit user approval.*`;

      return { content: [{ type: "text" as const, text: plan }] };
    }
  );
}
