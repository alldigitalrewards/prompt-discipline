import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync } from "fs";
import { join } from "path";
import { run, getBranch, getStatus, getLastCommit } from "../lib/git.js";
import { PROJECT_DIR } from "../lib/files.js";
import { STATE_DIR, appendLog, now } from "../lib/state.js";

export function registerCheckpoint(server: McpServer): void {
  server.tool(
    "checkpoint",
    `Save a session checkpoint before context compaction hits. Commits current work, writes session state to workspace docs, and creates a resumption note. Call this proactively when session is getting long, or when the session-health hook warns about turn count. This is your "save game" before compaction wipes context.`,
    {
      summary: z.string().describe("What was accomplished so far in this session"),
      next_steps: z.string().describe("What still needs to be done"),
      current_blockers: z.string().optional().describe("Any issues or blockers encountered"),
    },
    async ({ summary, next_steps, current_blockers }) => {
      const branch = getBranch();
      const dirty = getStatus();
      const lastCommit = getLastCommit();
      const timestamp = now();

      const checkpointFile = join(PROJECT_DIR, ".claude", "last-checkpoint.md");
      const checkpointContent = `# Session Checkpoint
**Time**: ${timestamp}
**Branch**: ${branch}
**Last Commit**: ${lastCommit}

## Accomplished
${summary}

## Next Steps
${next_steps}

${current_blockers ? `## Blockers\n${current_blockers}\n` : ""}
## Uncommitted Work
\`\`\`
${dirty || "clean"}
\`\`\`
`;
      writeFileSync(checkpointFile, checkpointContent);

      appendLog("checkpoint-log.jsonl", {
        timestamp,
        branch,
        summary,
        next_steps,
        blockers: current_blockers || null,
        dirty_files: dirty ? dirty.split("\n").length : 0,
      });

      let commitResult = "no uncommitted changes";
      if (dirty) {
        commitResult = run('git add -A && git commit -m "checkpoint: session save before compaction" 2>&1 || echo "commit failed"');
      }

      return {
        content: [{
          type: "text" as const,
          text: `## Checkpoint Saved ✅
**File**: .claude/last-checkpoint.md
**Branch**: ${branch}
**Commit**: ${commitResult}

### What's saved:
- Summary of work done
- Next steps for continuation
- Uncommitted files committed with checkpoint message

### To resume after compaction:
Tell the next session/continuation: "Read .claude/last-checkpoint.md for where I left off"

### Next: either continue working or start a fresh session.`,
        }],
      };
    }
  );
}
