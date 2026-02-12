import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getBranch, getStatus, getLastCommit, getLastCommitTime, run } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs } from "../lib/files.js";

export function registerSessionHealth(server: McpServer): void {
  server.tool(
    "check_session_health",
    `Check session health and recommend whether to continue, checkpoint, or start fresh. Tracks session depth, uncommitted work, workspace staleness, and time since last commit. Call periodically during long sessions.`,
    {},
    async () => {
      const branch = getBranch();
      const dirty = getStatus();
      const dirtyCount = dirty ? dirty.split("\n").length : 0;
      const lastCommit = getLastCommit();
      const lastCommitTime = getLastCommitTime();
      const uncommittedDiff = run("git diff --stat | tail -1");

      const commitDate = new Date(lastCommitTime);
      const minutesSinceCommit = Math.round((Date.now() - commitDate.getTime()) / 60000);

      const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 20);

      const docs = findWorkspaceDocs();
      const staleThreshold = 2 * 60 * 60 * 1000;
      const staleDocs = Object.entries(docs)
        .filter(([, d]) => (Date.now() - d.mtime.getTime()) > staleThreshold)
        .map(([n]) => n);

      const issues: string[] = [];
      let severity = "healthy";

      if (dirtyCount > 15) { issues.push(`🚨 ${dirtyCount} uncommitted files — commit now`); severity = "critical"; }
      else if (dirtyCount > 5) { issues.push(`⚠️ ${dirtyCount} uncommitted files — consider committing`); severity = "warning"; }

      if (minutesSinceCommit > 120) { issues.push(`🚨 ${minutesSinceCommit}min since last commit — checkpoint immediately`); severity = "critical"; }
      else if (minutesSinceCommit > 60) { issues.push(`⚠️ ${minutesSinceCommit}min since last commit — commit soon`); if (severity !== "critical") severity = "warning"; }

      if (staleDocs.length > 3) { issues.push(`📝 ${staleDocs.length} workspace docs are >2h stale: ${staleDocs.slice(0, 3).join(", ")}`); }

      const recommendation = severity === "critical"
        ? "🚨 **STOP and checkpoint.** Run `checkpoint` tool now. Commit all work, save state, consider starting fresh."
        : severity === "warning"
          ? "⚠️ **Checkpoint soon.** Commit current batch, update workspace docs if needed."
          : "✅ **Session is healthy.** Continue working.";

      return {
        content: [{
          type: "text" as const,
          text: `## Session Health Report

**Branch**: ${branch}
**Uncommitted**: ${dirtyCount} files
**Last commit**: ${lastCommit} (${minutesSinceCommit}min ago)
**Changes**: ${uncommittedDiff || "none"}
**Stale docs**: ${staleDocs.length > 0 ? staleDocs.join(", ") : "none"}
**Last checkpoint**: ${lastCheckpoint ? "exists" : "none"}

### Issues
${issues.length ? issues.join("\n") : "None — session is healthy"}

### Recommendation
${recommendation}`,
        }],
      };
    }
  );
}
