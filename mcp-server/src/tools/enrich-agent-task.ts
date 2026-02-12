import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getDiffFiles } from "../lib/git.js";
import { PROJECT_DIR } from "../lib/files.js";
import { existsSync } from "fs";
import { join } from "path";

/** Sanitize user input for safe use in shell commands */
function shellEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_\-./]/g, "");
}

/** Detect package manager from lockfiles */
function detectPackageManager(): string {
  if (existsSync(join(PROJECT_DIR, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(PROJECT_DIR, "yarn.lock"))) return "yarn";
  if (existsSync(join(PROJECT_DIR, "bun.lockb"))) return "bun";
  return "npm";
}

/** Find files in a target area using git-tracked files (project-agnostic) */
function findAreaFiles(area: string): string {
  if (!area) return getDiffFiles("HEAD~3");

  const safeArea = shellEscape(area);

  // If area looks like a path, search directly
  if (area.includes("/")) {
    return run(`git ls-files -- '${safeArea}*' 2>/dev/null | head -20`);
  }

  // Search for area keyword in git-tracked file paths
  const files = run(`git ls-files 2>/dev/null | grep -i '${safeArea}' | head -20`);
  if (files && !files.startsWith("[command failed")) return files;

  // Fallback to recently changed files
  return getDiffFiles("HEAD~3");
}

/** Find related test files for an area */
function findRelatedTests(area: string): string {
  if (!area) return run("git ls-files 2>/dev/null | grep -E '\\.(spec|test)\\.(ts|tsx|js|jsx)$' | head -10");

  const safeArea = shellEscape(area.split(/\s+/)[0]);
  const tests = run(`git ls-files 2>/dev/null | grep -E '\\.(spec|test)\\.(ts|tsx|js|jsx)$' | grep -i '${safeArea}' | head -10`);
  return tests || run("git ls-files 2>/dev/null | grep -E '\\.(spec|test)\\.(ts|tsx|js|jsx)$' | head -10");
}

/** Get an example pattern from the first matching file */
function getExamplePattern(files: string): string {
  const firstFile = files.split("\n").filter(Boolean)[0];
  if (!firstFile) return "no pattern available";
  return run(`head -30 '${shellEscape(firstFile)}' 2>/dev/null || echo 'could not read file'`);
}

export function registerEnrichAgentTask(server: McpServer): void {
  server.tool(
    "enrich_agent_task",
    `Enrich a vague sub-agent task with project context. Call before spawning a Task/sub-agent to add file paths, patterns, scope boundaries, and done conditions.`,
    {
      task_description: z.string().describe("The raw task for the sub-agent"),
      target_area: z.string().optional().describe("Codebase area: directory path, keyword, or description like 'auth tests', 'api routes'"),
    },
    async ({ task_description, target_area }) => {
      const area = target_area || "";
      const pm = detectPackageManager();
      const fileList = findAreaFiles(area);
      const testFiles = findRelatedTests(area);
      const pattern = getExamplePattern(area.includes("test") ? testFiles : fileList);

      const fileSummary = fileList
        ? fileList.split("\n").filter(Boolean).slice(0, 5).join(", ")
        : "Specify exact files";
      const testSummary = testFiles
        ? testFiles.split("\n").filter(Boolean).slice(0, 3).join(", ")
        : "Run relevant tests";

      return {
        content: [{
          type: "text" as const,
          text: `## Files in Target Area
\`\`\`
${fileList || "none found — specify a more precise area"}
\`\`\`

## Related Tests
\`\`\`
${testFiles || "none"}
\`\`\`

## Existing Pattern
\`\`\`typescript
${pattern}
\`\`\`

## Enriched Task
Original: "${task_description}"

- **Files**: ${fileSummary}
- **Pattern**: Follow existing pattern above
- **Tests**: ${testSummary}
- **Scope**: Do NOT modify files outside target area
- **Done when**: All relevant tests pass + \`${pm} tsc --noEmit\` clean`,
        }],
      };
    }
  );
}
