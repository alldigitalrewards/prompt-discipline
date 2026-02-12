import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getStatus } from "../lib/git.js";
import { PROJECT_DIR } from "../lib/files.js";
import { existsSync } from "fs";
import { join } from "path";

/** Detect package manager from lockfiles */
function detectPM(): string {
  if (existsSync(join(PROJECT_DIR, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(PROJECT_DIR, "yarn.lock"))) return "yarn";
  if (existsSync(join(PROJECT_DIR, "bun.lockb"))) return "bun";
  return "npx";
}

/** Detect test runner from config/dependencies */
function detectTestRunner(): string | null {
  // Check for common test configs
  const configs = [
    "playwright.config.ts", "playwright.config.js",
    "vitest.config.ts", "vitest.config.js",
    "jest.config.ts", "jest.config.js", "jest.config.mjs",
  ];
  for (const c of configs) {
    if (existsSync(join(PROJECT_DIR, c))) {
      if (c.startsWith("playwright")) return "playwright";
      if (c.startsWith("vitest")) return "vitest";
      if (c.startsWith("jest")) return "jest";
    }
  }
  return null;
}

/** Check if a build script exists in package.json */
function hasBuildScript(): boolean {
  try {
    const pkg = JSON.parse(run("cat package.json 2>/dev/null"));
    return !!pkg?.scripts?.build;
  } catch { return false; }
}

export function registerVerifyCompletion(server: McpServer): void {
  server.tool(
    "verify_completion",
    `Verify that work is actually complete before declaring done. Runs type check, relevant tests, checks for uncommitted files, and validates against the original task criteria. Call this BEFORE saying "done" or committing final work.`,
    {
      task_description: z.string().describe("What was the task? Used to check if success criteria are met."),
      test_scope: z.string().optional().describe("Which tests to run: 'all', a directory/keyword, or a specific spec file path. Default: auto-detect from changed files."),
      skip_tests: z.boolean().optional().describe("Skip running tests (only check types + git state). Default: false."),
      skip_build: z.boolean().optional().describe("Skip build check. Default: false."),
    },
    async ({ task_description, test_scope, skip_tests, skip_build }) => {
      const pm = detectPM();
      const sections: string[] = [];
      const checks: { name: string; passed: boolean; detail: string }[] = [];

      // 1. Type check (single invocation, extract both result and count)
      const tscOutput = run(`${pm === "npx" ? "npx" : pm} tsc --noEmit 2>&1 | tail -20`);
      const errorLines = tscOutput.split("\n").filter(l => /error TS\d+/.test(l));
      const typePassed = errorLines.length === 0;
      checks.push({
        name: "Type Check",
        passed: typePassed,
        detail: typePassed
          ? "✅ Clean"
          : `❌ ${errorLines.length} errors\n${errorLines.slice(0, 10).join("\n")}${errorLines.length > 10 ? `\n... and ${errorLines.length - 10} more` : ""}`,
      });

      // 2. Git state
      const dirty = getStatus();
      const dirtyCount = dirty ? dirty.split("\n").filter(Boolean).length : 0;
      checks.push({
        name: "Git State",
        passed: true, // informational, not a blocker
        detail: dirtyCount > 0
          ? `${dirtyCount} uncommitted files:\n\`\`\`\n${dirty}\n\`\`\``
          : "✅ Clean working tree",
      });

      // 3. Tests
      if (!skip_tests) {
        const runner = detectTestRunner();
        const changedFiles = run("git diff --name-only HEAD~1 2>/dev/null").split("\n").filter(Boolean);
        let testCmd = "";

        if (runner === "playwright") {
          const runnerCmd = `${pm === "npx" ? "npx" : `${pm} exec`} playwright test`;
          if (test_scope && test_scope !== "all") {
            testCmd = test_scope.endsWith(".spec.ts") || test_scope.endsWith(".test.ts")
              ? `${runnerCmd} ${test_scope} --reporter=line 2>&1 | tail -20`
              : `${runnerCmd} --grep "${test_scope}" --reporter=line 2>&1 | tail -20`;
          } else {
            // Auto-detect from changed files
            const changedTests = changedFiles.filter(f => /\.(spec|test)\.(ts|tsx|js)$/.test(f)).slice(0, 5);
            if (changedTests.length > 0) {
              testCmd = `${runnerCmd} ${changedTests.join(" ")} --reporter=line 2>&1 | tail -20`;
            }
          }
        } else if (runner === "vitest" || runner === "jest") {
          const runnerCmd = `${pm === "npx" ? "npx" : `${pm} exec`} ${runner}`;
          if (test_scope && test_scope !== "all") {
            testCmd = `${runnerCmd} --run ${test_scope} 2>&1 | tail -20`;
          } else {
            const changedTests = changedFiles.filter(f => /\.(spec|test)\.(ts|tsx|js)$/.test(f)).slice(0, 5);
            if (changedTests.length > 0) {
              testCmd = `${runnerCmd} --run ${changedTests.join(" ")} 2>&1 | tail -20`;
            }
          }
        } else if (test_scope) {
          // No recognized runner but scope given — try npm test
          testCmd = `${pm} test 2>&1 | tail -20`;
        }

        if (testCmd) {
          const testResult = run(testCmd, { timeout: 120000 });
          const testPassed = /pass/i.test(testResult) && !/fail/i.test(testResult);
          checks.push({
            name: "Tests",
            passed: testPassed,
            detail: testPassed ? `✅ Tests passed\n${testResult}` : `❌ Tests failed\n${testResult}`,
          });
        } else {
          checks.push({
            name: "Tests",
            passed: true,
            detail: `⚠️ No relevant tests identified${runner ? ` (runner: ${runner})` : ""}. Consider running full suite.`,
          });
        }
      }

      // 4. Build check (only if build script exists and not skipped)
      if (!skip_build && hasBuildScript()) {
        const buildCheck = run(`${pm === "npx" ? "npm run" : pm} build 2>&1 | tail -10`, { timeout: 60000 });
        const buildPassed = !/\b[Ee]rror\b/.test(buildCheck) || /Successfully compiled/.test(buildCheck);
        checks.push({
          name: "Build",
          passed: buildPassed,
          detail: buildPassed ? "✅ Build succeeds" : `❌ Build failed\n${buildCheck}`,
        });
      } else if (!skip_build) {
        checks.push({ name: "Build", passed: true, detail: "⚠️ No build script found — skipped" });
      }

      const allPassed = checks.every(c => c.passed);
      sections.push(`## Verification Report\n**Task**: ${task_description}\n\n${checks.map(c => `### ${c.name}\n${c.detail}`).join("\n\n")}`);

      sections.push(`## Verdict\n${allPassed
        ? "✅ **ALL CHECKS PASSED.** Safe to commit and declare done."
        : "❌ **CHECKS FAILED.** Fix the issues above before committing."
      }`);

      if (!allPassed) {
        sections.push(`## Do NOT:\n- Commit with failing checks\n- Say "done" without green tests\n- Push broken code to remote\n\n## DO:\n- Fix each failing check\n- Re-run \`verify_completion\` after fixes\n- Then commit`);
      }

      return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
    }
  );
}
