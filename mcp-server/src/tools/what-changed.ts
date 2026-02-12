import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { run, getBranch, getDiffStat } from "../lib/git.js";

export function registerWhatChanged(server: McpServer): void {
  server.tool(
    "what_changed",
    `Summarize what changed recently. Useful after sub-agents finish, after a break, when context was compacted, or at the start of a new session. Returns diff summary with commit messages.`,
    {
      since: z.string().optional().describe("Git ref: 'HEAD~5', 'HEAD~3', etc. Default: HEAD~5"),
    },
    async ({ since }) => {
      const ref = since || "HEAD~5";
      const diffStat = getDiffStat(ref);
      const diffFiles = run(`git diff ${ref} --name-only 2>/dev/null || git diff HEAD~3 --name-only`);
      const log = run(`git log ${ref}..HEAD --oneline 2>/dev/null || git log -5 --oneline`);
      const branch = getBranch();

      const fileList = diffFiles.split("\n").filter(Boolean);
      const fileCount = fileList.length;
      const commitCount = log.split("\n").filter(Boolean).length;

      return {
        content: [{
          type: "text" as const,
          text: `## What Changed (since ${ref})
Branch: ${branch}
**${commitCount} commits**, **${fileCount} files** changed

### Commits
\`\`\`
${log || "no commits in range"}
\`\`\`

### Files Changed (${fileCount})
\`\`\`
${diffFiles || "none"}
\`\`\`

### Stats
\`\`\`
${diffStat || "no changes"}
\`\`\``,
        }],
      };
    }
  );
}
