import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run } from "../lib/git.js";

export function registerEnrichAgentTask(server: McpServer): void {
  server.tool(
    "enrich_agent_task",
    `Enrich a vague sub-agent task with project context. Call before spawning a Task/sub-agent to add file paths, patterns, scope boundaries, and done conditions.`,
    {
      task_description: z.string().describe("The raw task for the sub-agent"),
      target_area: z.string().optional().describe("Codebase area: 'admin tests', 'participant pages', 'api routes'"),
    },
    async ({ task_description, target_area }) => {
      const area = target_area || "";
      let fileList = "";
      if (area.includes("admin")) fileList = run("find app/w -path '*/admin/*' -name '*.tsx' 2>/dev/null | head -20");
      else if (area.includes("participant")) fileList = run("find app/w -path '*/participant/*' -name '*.tsx' 2>/dev/null | head -20");
      else if (area.includes("manager")) fileList = run("find app/w -path '*/manager/*' -name '*.tsx' 2>/dev/null | head -20");
      else if (area.includes("test")) fileList = run("find tests -name '*.spec.ts' 2>/dev/null | head -20");
      else if (area.includes("api")) fileList = run("find app/api -name 'route.ts' 2>/dev/null | head -20");
      else fileList = run("git diff --name-only HEAD~3 2>/dev/null | head -15");

      const testFiles = run(`find tests -name '*.spec.ts' 2>/dev/null | grep -i '${area.split(" ")[0] || ""}' | head -10`);
      const pattern = area.includes("test")
        ? run("head -30 $(find tests -name '*.spec.ts' -maxdepth 4 2>/dev/null | head -1) 2>/dev/null || echo 'no pattern'")
        : run("head -30 $(find app/w -name 'page.tsx' -maxdepth 6 2>/dev/null | head -1) 2>/dev/null || echo 'no pattern'");

      return {
        content: [{ type: "text" as const, text: `## Files in Target Area\n\`\`\`\n${fileList || "none found"}\n\`\`\`\n\n## Related Tests\n\`\`\`\n${testFiles || "none"}\n\`\`\`\n\n## Existing Pattern\n\`\`\`typescript\n${pattern}\n\`\`\`\n\n## Enriched Task\nOriginal: "${task_description}"\n\n- **Files**: ${fileList ? fileList.split("\n").slice(0, 5).join(", ") : "Specify exact files"}\n- **Pattern**: Follow existing pattern above\n- **Tests**: ${testFiles ? testFiles.split("\n").slice(0, 3).join(", ") : "Run relevant tests"}\n- **Scope**: Do NOT modify files outside target area\n- **Done when**: All relevant tests pass + \`pnpm tsc --noEmit\` clean` }],
      };
    }
  );
}
