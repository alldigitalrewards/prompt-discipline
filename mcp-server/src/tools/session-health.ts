import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getBranch, getStatus, getLastCommit, getLastCommitTime, run } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs } from "../lib/files.js";
import { loadState, saveState } from "../lib/state.js";

/** Parse a git date string safely, returning null on failure */
function parseGitDate(dateStr: string): Date | null {
  if (!dateStr || dateStr.startsWith("[command failed")) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

export function registerSessionHealth(server: McpServer): void {
  server.tool(
    "check_session_health",
    `Check session health and recommend whether to continue, checkpoint, or start fresh. Tracks session depth, uncommitted work, workspace staleness, and time since last commit. Call periodically during long sessions.`,
    {
      stale_threshold_hours: z.number().optional().describe("Hours before a doc is considered stale. Default: 2"),
    },
    async ({ stale_threshold_hours }) => {
      const staleHours = stale_threshold_hours ?? 2;
      const branch = getBranch();
      const dirty = getStatus();
      const dirtyCount = dirty ? dirty.split("\n").filter(Boolean).length : 0;
      const lastCommit = getLastCommit();
      const lastCommitTimeStr = getLastCommitTime();
      const uncommittedDiff = run("git diff --stat | tail -1");

      // Parse commit time safely
      const commitDate = parseGitDate(lastCommitTimeStr);
      const minutesSinceCommit = commitDate
        ? Math.round((Date.now() - commitDate.getTime()) / 60000)
        : null;

      // Track session start time
      const sessionState = loadState("session-health");
      if (!sessionState.sessionStart) {
        sessionState.sessionStart = Date.now();
        sessionState.checkCount = 0;
        saveState("session-health", sessionState);
      }
      sessionState.checkCount = (sessionState.checkCount || 0) + 1;
      saveState("session-health", sessionState);

      const sessionMinutes = Math.round((Date.now() - sessionState.sessionStart) / 60000);

      const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 20);

      const docs = findWorkspaceDocs();
      const staleThresholdMs = staleHours * 60 * 60 * 1000;
      const staleDocs = Object.entries(docs)
        .filter(([, d]) => (Date.now() - d.mtime.getTime()) > staleThresholdMs)
        .map(([n]) => n);

      const issues: string[] = [];
      let severity = "healthy";

      if (dirtyCount > 15) { issues.push(`🚨 ${dirtyCount} uncommitted files — commit now`); severity = "critical"; }
      else if (dirtyCount > 5) { issues.push(`⚠️ ${dirtyCount} uncommitted files — consider committing`); severity = "warning"; }

      if (minutesSinceCommit !== null) {
        if (minutesSinceCommit > 120) { issues.push(`🚨 ${minutesSinceCommit}min since last commit — checkpoint immediately`); severity = "critical"; }
        else if (minutesSinceCommit > 60) { issues.push(`⚠️ ${minutesSinceCommit}min since last commit — commit soon`); if (severity !== "critical") severity = "warning"; }
      } else {
        issues.push("⚠️ Could not determine last commit time");
      }

      if (sessionMinutes > 180) { issues.push(`🚨 Session running ${sessionMinutes}min — consider starting fresh`); severity = "critical"; }
      else if (sessionMinutes > 90) { issues.push(`⚠️ Session running ${sessionMinutes}min — checkpoint soon`); if (severity !== "critical") severity = "warning"; }

      if (staleDocs.length > 3) { issues.push(`📝 ${staleDocs.length} workspace docs are >${staleHours}h stale: ${staleDocs.slice(0, 3).join(", ")}`); }

      const recommendation = severity === "critical"
        ? "🚨 **STOP and checkpoint.** Run `checkpoint` tool now. Commit all work, save state, consider starting fresh."
        : severity === "warning"
          ? "⚠️ **Checkpoint soon.** Commit current batch, update workspace docs if needed."
          : "✅ **Session is healthy.** Continue working.";

      const commitTimeStr = minutesSinceCommit !== null ? `${minutesSinceCommit}min ago` : "unknown";

      return {
        content: [{
          type: "text" as const,
          text: `## Session Health Report

**Branch**: ${branch}
**Session duration**: ${sessionMinutes}min (check #${sessionState.checkCount})
**Uncommitted**: ${dirtyCount} files
**Last commit**: ${lastCommit} (${commitTimeStr})
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
