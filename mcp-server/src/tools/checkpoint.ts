import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { run, getBranch, getStatus, getLastCommit, getStagedFiles } from "../lib/git.js";
import { PROJECT_DIR } from "../lib/files.js";
import { appendLog, now } from "../lib/state.js";

export function registerCheckpoint(server: McpServer): void {
  server.tool(
    "checkpoint",
    `Save a session checkpoint before context compaction hits. Commits current work, writes session state to workspace docs, and creates a resumption note. Call this proactively when session is getting long, or when the session-health hook warns about turn count. This is your "save game" before compaction wipes context.`,
    {
      summary: z.string().describe("What was accomplished so far in this session"),
      next_steps: z.string().describe("What still needs to be done"),
      current_blockers: z.string().optional().describe("Any issues or blockers encountered"),
      commit_mode: z.enum(["staged", "tracked", "all"]).optional().describe("What to commit: 'staged' (only staged files), 'tracked' (modified tracked files), 'all' (git add -A). Default: 'tracked'"),
    },
    async ({ summary, next_steps, current_blockers, commit_mode }) => {
      const mode = commit_mode || "tracked";
      const branch = getBranch();
      const dirty = getStatus();
      const lastCommit = getLastCommit();
      const timestamp = now();

      // Write checkpoint file
      const checkpointDir = join(PROJECT_DIR, ".claude");
      if (!existsSync(checkpointDir)) mkdirSync(checkpointDir, { recursive: true });

      const checkpointFile = join(checkpointDir, "last-checkpoint.md");
      const checkpointContent = `# Session Checkpoint
**Time**: ${timestamp}
**Branch**: ${branch}
**Last Commit**: ${lastCommit}

## Accomplished
${summary}

## Next Steps
${next_steps}

${current_blockers ? `## Blockers\n${current_blockers}\n` : ""}
## Uncommitted Work (at checkpoint time)
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
        dirty_files: dirty ? dirty.split("\n").filter(Boolean).length : 0,
        commit_mode: mode,
      });

      // Commit based on mode
      let commitResult = "no uncommitted changes";
      if (dirty) {
        const shortSummary = summary.split("\n")[0].slice(0, 72);
        const commitMsg = `checkpoint: ${shortSummary}`;

        let addCmd: string = "git add -u";
        switch (mode) {
          case "staged": {
            const staged = getStagedFiles();
            if (!staged) {
              commitResult = "nothing staged — skipped commit (use 'tracked' or 'all' mode, or stage files first)";
            }
            addCmd = "true"; // noop, already staged
            break;
          }
          case "all":
            addCmd = "git add -A";
            break;
          case "tracked":
          default:
            addCmd = "git add -u";
            break;
        }

        if (commitResult === "no uncommitted changes") {
          // Stage the checkpoint file too
          run(`git add "${checkpointFile}"`);
          const result = run(`${addCmd} && git commit -m "${commitMsg.replace(/"/g, '\\"')}" 2>&1`);
          if (result.includes("commit failed") || result.includes("nothing to commit")) {
            // Rollback: unstage if commit failed
            run("git reset HEAD 2>/dev/null");
            commitResult = `commit failed: ${result}`;
          } else {
            commitResult = result;
          }
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `## Checkpoint Saved ✅
**File**: .claude/last-checkpoint.md
**Branch**: ${branch}
**Commit mode**: ${mode}
**Commit**: ${commitResult}

### What's saved:
- Summary of work done
- Next steps for continuation
${current_blockers ? "- Current blockers\n" : ""}- Working tree state at checkpoint time

### To resume after compaction:
Tell the next session/continuation: "Read .claude/last-checkpoint.md for where I left off"`,
        }],
      };
    }
  );
}
