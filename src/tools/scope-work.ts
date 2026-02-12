// CATEGORY 1: scope_work — Plans
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getBranch, getRecentCommits, getStatus } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs, PROJECT_DIR } from "../lib/files.js";
import { now } from "../lib/state.js";
import { existsSync } from "fs";
import { join } from "path";

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
      const dirtyFiles = run("git status --porcelain");
      const diffStat = dirtyFiles ? run("git diff --stat") : "(clean working tree)";

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

      // Grep for files matching task keywords
      let matchedFiles = "";
      const grepTerms = keywords
        .filter((k) => k.length > 3 && !/^(the|and|for|with|from|that|this|should|would|could|into|have|been)$/.test(k))
        .slice(0, 5);
      if (grepTerms.length > 0) {
        const pattern = grepTerms.join("|");
        matchedFiles = run(`git ls-files | head -500 | grep -iE '(${pattern})' | head -30`);
      }

      // Check which relevant dirs actually exist
      const existingDirs: string[] = [];
      for (const dir of relevantDirs) {
        if (existsSync(join(PROJECT_DIR, dir))) existingDirs.push(dir);
      }

      // Workspace docs
      const workspaceDocs = findWorkspaceDocs();
      const docNames = Object.keys(workspaceDocs);

      // Project instructions
      const claudeMd = readIfExists("CLAUDE.md", 50);
      const agentsMd = readIfExists(".claude/AGENTS.md", 50);

      // Complexity estimate
      const allTouchedFiles = [
        ...matchedFiles.split("\n").filter(Boolean),
        ...dirtyFiles.split("\n").filter(Boolean).map((l) => l.slice(3)),
      ];
      const uniqueFiles = [...new Set(allTouchedFiles)];
      const fileCount = uniqueFiles.length;
      const complexity = fileCount <= 3 ? "SMALL" : fileCount <= 10 ? "MEDIUM" : "LARGE";

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
${dirtyFiles || "(clean)"}
\`\`\`

${diffStat !== "(clean working tree)" ? `**Uncommitted changes:**\n\`\`\`\n${diffStat}\n\`\`\`` : ""}

## 📁 Relevant Files
${matchedFiles ? matchedFiles.split("\n").map((f) => `- \`${f}\``).join("\n") : "- (no direct file matches — explore manually)"}

${existingDirs.length > 0 ? `**Relevant directories:** ${existingDirs.map((d) => `\`${d}\``).join(", ")}` : ""}

## 📚 Workspace Docs
${docNames.length > 0 ? docNames.map((d) => `- \`.claude/${d}\``).join("\n") : "- (none found in .claude/)"}
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
${dirtyFiles ? "- ⚠️ Working tree is dirty — do NOT commit unrelated changes" : ""}

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
