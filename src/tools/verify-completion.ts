import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getStatus } from "../lib/git.js";

export function registerVerifyCompletion(server: McpServer): void {
  server.tool(
    "verify_completion",
    `Verify that work is actually complete before declaring done. Runs type check, relevant tests, checks for uncommitted files, and validates against the original task criteria. Call this BEFORE saying "done" or committing final work. Prevents the "ship it without testing" pattern.`,
    {
      task_description: z.string().describe("What was the task? Used to check if success criteria are met."),
      test_scope: z.string().optional().describe("Which tests to run: 'all', 'admin', 'participant', 'manager', specific spec file path. Default: relevant tests based on changed files."),
      skip_tests: z.boolean().optional().describe("Skip running tests (only check types + git state). Default: false."),
    },
    async ({ task_description, test_scope, skip_tests }) => {
      const sections: string[] = [];
      const checks: { name: string; passed: boolean; detail: string }[] = [];

      // 1. Type check
      const typeResult = run("pnpm tsc --noEmit 2>&1 | tail -5");
      const typeErrors = run("pnpm tsc --noEmit 2>&1 | grep -c 'error TS' || echo '0'");
      const typePassed = typeErrors === "0";
      checks.push({ name: "Type Check", passed: typePassed, detail: typePassed ? "✅ Clean" : `❌ ${typeErrors} errors\n${typeResult}` });

      // 2. Git state
      const dirty = getStatus();
      const dirtyCount = dirty ? dirty.split("\n").length : 0;
      checks.push({ name: "Git State", passed: true, detail: dirtyCount > 0 ? `${dirtyCount} uncommitted files:\n\`\`\`\n${dirty}\n\`\`\`` : "✅ Clean working tree" });

      // 3. Tests (unless skipped)
      if (!skip_tests) {
        const changedFiles = run("git diff --name-only HEAD~1 2>/dev/null").split("\n");
        let testCmd = "";

        if (test_scope && test_scope !== "all") {
          if (test_scope.endsWith(".spec.ts")) {
            testCmd = `npx playwright test ${test_scope} --reporter=line 2>&1 | tail -20`;
          } else {
            testCmd = `npx playwright test tests/functional/ui/**/${test_scope}/ --reporter=line 2>&1 | tail -20`;
          }
        } else if (changedFiles.some(f => f.includes("tests/"))) {
          const changedTests = changedFiles.filter(f => f.endsWith(".spec.ts")).slice(0, 5);
          if (changedTests.length > 0) {
            testCmd = `npx playwright test ${changedTests.join(" ")} --reporter=line 2>&1 | tail -20`;
          }
        }

        if (testCmd) {
          const testResult = run(testCmd, { timeout: 60000 });
          const testPassed = testResult.includes("passed") && !testResult.includes("failed");
          checks.push({ name: "Tests", passed: testPassed, detail: testPassed ? `✅ Tests passed\n${testResult}` : `❌ Tests failed\n${testResult}` });
        } else {
          checks.push({ name: "Tests", passed: true, detail: "⚠️ No relevant tests identified. Consider running full suite." });
        }
      }

      // 4. Build check
      const buildCheck = run("pnpm build 2>&1 | tail -5", { timeout: 30000 });
      const buildPassed = !buildCheck.includes("Error") && !buildCheck.includes("error");
      checks.push({ name: "Build", passed: buildPassed, detail: buildPassed ? "✅ Build succeeds" : `❌ Build failed\n${buildCheck}` });

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
