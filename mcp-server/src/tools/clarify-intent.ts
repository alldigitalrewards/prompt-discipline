import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getBranch, getStatus, getRecentCommits, getDiffFiles, getStagedFiles } from "../lib/git.js";
import { findWorkspaceDocs, PROJECT_DIR } from "../lib/files.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Parse test failures from common report formats without fragile shell pipelines */
function getTestFailures(): string {
  // Try playwright JSON report
  const reportPath = join(PROJECT_DIR, "playwright-report", "results.json");
  if (existsSync(reportPath)) {
    try {
      const data = JSON.parse(readFileSync(reportPath, "utf-8"));
      const failures: string[] = [];
      const walk = (suites: any[]) => {
        for (const suite of suites || []) {
          for (const spec of suite.specs || []) {
            if (spec.ok === false) failures.push(spec.title);
          }
          walk(suite.suites);
        }
      };
      walk(data.suites);
      return failures.length ? failures.join("\n") : "all passing";
    } catch {
      return "report exists but could not parse";
    }
  }

  // Try jest/vitest JSON output
  for (const p of ["test-results.json", "jest-results.json"]) {
    const fp = join(PROJECT_DIR, p);
    if (existsSync(fp)) {
      try {
        const data = JSON.parse(readFileSync(fp, "utf-8"));
        const failed = data.testResults
          ?.filter((t: any) => t.status === "failed")
          ?.map((t: any) => t.name) || [];
        return failed.length ? failed.join("\n") : "all passing";
      } catch { continue; }
    }
  }

  return "no test report found";
}

/** Extract intent signals using weighted pattern matching */
function extractSignals(msg: string, context: { hasTypeErrors: boolean; hasTestFailures: boolean; hasDirtyFiles: boolean }): string[] {
  const signals: string[] = [];
  const lower = msg.toLowerCase();

  const patterns: [RegExp, string, number][] = [
    [/\b(fix|repair|broken|failing|error|bug|crash|issue)\b/, "FIX", 2],
    [/\b(test|spec|suite|playwright|jest|vitest|e2e)\b/, "TESTS", 2],
    [/\b(commit|push|pr|merge|rebase|cherry.?pick)\b/, "GIT", 2],
    [/\b(add|create|new|build|implement|feature)\b/, "CREATE", 1],
    [/\b(remove|delete|clean|strip|drop|deprecate)\b/, "REMOVE", 1],
    [/\b(check|verify|confirm|status|review|audit)\b/, "VERIFY", 1],
    [/\b(refactor|rename|move|reorganize|extract)\b/, "REFACTOR", 1],
    [/\b(deploy|release|ship|publish)\b/, "DEPLOY", 1],
    [/\b(everything|all|entire|whole)\b/, "⚠️ UNBOUNDED", 3],
  ];

  const matched: { label: string; weight: number; hint: string }[] = [];
  for (const [re, label, weight] of patterns) {
    if (re.test(lower)) matched.push({ label, weight, hint: "" });
  }

  // Add contextual hints
  if (matched.some(m => m.label === "FIX")) {
    if (context.hasTypeErrors) signals.push("FIX: Type errors detected — likely the target.");
    if (context.hasTestFailures) signals.push("FIX: Test failures detected — check test output.");
    if (!context.hasTypeErrors && !context.hasTestFailures) signals.push("FIX: No obvious errors — ask what's broken.");
  }
  if (matched.some(m => m.label === "TESTS")) signals.push("TESTS: Check failing tests and test files below.");
  if (matched.some(m => m.label === "GIT")) signals.push("GIT: Check dirty files and branch state.");
  if (matched.some(m => m.label === "CREATE")) signals.push("CREATE: Check workspace priorities for planned work.");
  if (matched.some(m => m.label === "REMOVE")) signals.push("REMOVE: Clarify what 'them/it' refers to before deleting.");
  if (matched.some(m => m.label === "VERIFY")) signals.push("VERIFY: Use git/test state to answer.");
  if (matched.some(m => m.label === "REFACTOR")) signals.push("REFACTOR: Identify scope boundaries before starting.");
  if (matched.some(m => m.label === "DEPLOY")) signals.push("DEPLOY: Verify all checks pass first.");
  if (matched.some(m => m.label === "⚠️ UNBOUNDED")) signals.push("⚠️ UNBOUNDED: Narrow down using workspace priorities.");

  if (!signals.length) signals.push("UNCLEAR: Ask ONE clarifying question before proceeding.");

  return signals;
}

export function registerClarifyIntent(server: McpServer): void {
  server.tool(
    "clarify_intent",
    `Clarify a vague user instruction by gathering project context. Call BEFORE executing when the user's prompt is missing specific files, actions, scope, or done conditions. Returns git state, test failures, recent changes, and workspace priorities.`,
    {
      user_message: z.string().describe("The user's raw message/instruction to clarify"),
      suspected_area: z.string().optional().describe("Best guess area: 'tests', 'git', 'ui', 'api', 'schema'"),
    },
    async ({ user_message, suspected_area }) => {
      const sections: string[] = [];
      const branch = getBranch();
      const status = getStatus();
      const recentCommits = getRecentCommits(5);
      const recentFiles = getDiffFiles("HEAD~3");
      const staged = getStagedFiles();
      const dirtyCount = status ? status.split("\n").filter(Boolean).length : 0;

      sections.push(`## Git State\nBranch: ${branch}\nDirty files: ${dirtyCount}\n${status ? `\`\`\`\n${status}\n\`\`\`` : "Working tree clean"}\nStaged: ${staged || "nothing"}\n\nRecent commits:\n\`\`\`\n${recentCommits}\n\`\`\`\n\nRecently changed files:\n\`\`\`\n${recentFiles}\n\`\`\``);

      // Gather test/type state when relevant
      const area = (suspected_area || "").toLowerCase();
      let hasTypeErrors = false;
      let hasTestFailures = false;

      if (!area || area.includes("test") || area.includes("fix") || area.includes("ui") || area.includes("api")) {
        const typeErrors = run("pnpm tsc --noEmit 2>&1 | grep -c 'error TS' || echo '0'");
        hasTypeErrors = parseInt(typeErrors, 10) > 0;

        const testFiles = run("find tests -name '*.spec.ts' -maxdepth 4 2>/dev/null | head -20");
        const failingTests = getTestFailures();
        hasTestFailures = failingTests !== "all passing" && failingTests !== "no test report found";

        sections.push(`## Test State\nType errors: ${typeErrors}\nFailing tests: ${failingTests}\nTest files:\n\`\`\`\n${testFiles || "none found"}\n\`\`\``);
      }

      // Workspace priorities
      const workspaceDocs = findWorkspaceDocs();
      const priorityDocs = Object.entries(workspaceDocs)
        .filter(([n]) => /gap|roadmap|current|todo|changelog/i.test(n))
        .slice(0, 3);
      if (priorityDocs.length > 0) {
        sections.push(`## Workspace Priorities\n${priorityDocs.map(([n, d]) => `### .claude/${n}\n\`\`\`\n${d.content}\n\`\`\``).join("\n\n")}`);
      }

      const signals = extractSignals(user_message, {
        hasTypeErrors,
        hasTestFailures,
        hasDirtyFiles: dirtyCount > 0,
      });

      sections.push(`## Intent Signals\n${signals.map(s => `- ${s}`).join("\n")}`);
      sections.push(`## Recommendation\n1. **Proceed with specifics** — state what you'll do and why\n2. **Ask ONE question** — if context doesn't disambiguate`);

      return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
    }
  );
}
