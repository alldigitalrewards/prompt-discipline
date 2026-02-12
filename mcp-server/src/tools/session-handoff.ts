import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { run, getBranch, getRecentCommits, getStatus } from "../lib/git.js";
import { readIfExists, findWorkspaceDocs } from "../lib/files.js";
import { STATE_DIR, now } from "../lib/state.js";

/** Check if a CLI tool is available */
function hasCommand(cmd: string): boolean {
  const result = run(`command -v ${cmd} 2>/dev/null`);
  return !!result && !result.startsWith("[command failed");
}

export function registerSessionHandoff(server: McpServer): void {
  server.tool(
    "session_handoff",
    `Generate a handoff brief for the next session. Reads last checkpoint, recent commits, open PRs, workspace state, and correction patterns to create a "here's where we are" document. Call at session end or when starting a new session to catch up on what happened.`,
    {
      direction: z.enum(["outgoing", "incoming"]).describe("'outgoing' = ending this session, 'incoming' = starting a new one"),
    },
    async ({ direction }) => {
      const branch = getBranch();
      const sections: string[] = [];

      if (direction === "incoming") {
        const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 50);
        const recentLog = getRecentCommits(10);
        const dirty = getStatus();

        sections.push(`## Session Handoff — INCOMING\n**Branch**: ${branch}\n**Time**: ${now()}`);

        if (lastCheckpoint) {
          sections.push(`## Last Checkpoint\n${lastCheckpoint}`);
        } else {
          sections.push(`## Last Checkpoint\nNone found. This may be the first session or checkpoints weren't saved.`);
        }

        sections.push(`## Recent Commits\n\`\`\`\n${recentLog}\n\`\`\``);

        if (dirty) {
          sections.push(`## Uncommitted Work\n\`\`\`\n${dirty}\n\`\`\``);
        }

        // Only try gh if it exists
        if (hasCommand("gh")) {
          const openPRs = run("gh pr list --state open --json number,title,headRefName 2>/dev/null || echo '[]'");
          if (openPRs && openPRs !== "[]") {
            sections.push(`## Open PRs\n\`\`\`json\n${openPRs}\n\`\`\``);
          }
        }

        const docs = findWorkspaceDocs();
        const freshDocs = Object.entries(docs)
          .sort((a, b) => b[1].mtime.getTime() - a[1].mtime.getTime())
          .slice(0, 5);
        if (freshDocs.length > 0) {
          sections.push(`## Most Recently Updated Workspace Docs\n${freshDocs.map(([n, d]) =>
            `- .claude/${n} (updated ${Math.round((Date.now() - d.mtime.getTime()) / 3600000)}h ago)`
          ).join("\n")}`);
        }

        // Correction patterns
        const correctionFile = join(STATE_DIR, "corrections.jsonl");
        if (existsSync(correctionFile)) {
          try {
            const raw = readFileSync(correctionFile, "utf-8").trim();
            if (raw) {
              const corr = raw.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
              if (corr.length > 0) {
                const cats: Record<string, number> = {};
                for (const c of corr) cats[c.category] = (cats[c.category] || 0) + 1;
                sections.push(`## Known Error Patterns\n${Object.entries(cats).map(([k, v]) => `- ${k}: ${v}x`).join("\n")}\n\n**Watch out for these patterns.**`);
              }
            }
          } catch { /* ignore parse errors */ }
        }

        sections.push(`## Recommendation\n1. Read the last checkpoint to understand where previous session left off\n2. Check git status for uncommitted work\n3. Read the most recently updated workspace docs\n4. Start with a specific task — don't try to "continue where we left off" without reading state first`);

      } else {
        // OUTGOING
        const dirty = getStatus();
        const dirtyCount = dirty ? dirty.split("\n").filter(Boolean).length : 0;
        const recentLog = getRecentCommits(5);

        sections.push(`## Session Handoff — OUTGOING\n**Branch**: ${branch}\n**Time**: ${now()}`);

        if (dirtyCount > 0) {
          sections.push(`## ⚠️ Uncommitted Work (${dirtyCount} files)\n\`\`\`\n${dirty}\n\`\`\`\n\n**Action**: Commit this work or it will be lost to the next session.`);

          // Suggest stash if there's dirty work
          const stashSuggestion = dirtyCount > 10
            ? "\n💡 **Tip**: Consider `git stash` if you want to save work without committing."
            : "";
          if (stashSuggestion) sections.push(stashSuggestion);
        }

        sections.push(`## Recent Commits This Session\n\`\`\`\n${recentLog}\n\`\`\``);

        // Check for today's checkpoint using date comparison
        const lastCheckpoint = readIfExists(".claude/last-checkpoint.md", 10);
        const hasRecentCheckpoint = (() => {
          if (!lastCheckpoint) return false;
          // Look for a timestamp line and compare dates
          const match = lastCheckpoint.match(/\*\*Time\*\*:\s*(\S+)/);
          if (!match) return false;
          try {
            const cpDate = new Date(match[1]);
            // Consider "recent" if within last 4 hours
            return (Date.now() - cpDate.getTime()) < 4 * 60 * 60 * 1000;
          } catch { return false; }
        })();

        if (!hasRecentCheckpoint) {
          sections.push(`## ⚠️ No recent checkpoint\nRun the \`checkpoint\` tool to save session state for the next session.`);
        }

        sections.push(`## Before ending:\n1. Commit all work\n2. Run \`checkpoint\` with summary + next steps\n3. Update any stale workspace docs (run \`audit_workspace\`)\n4. Push to remote`);
      }

      return { content: [{ type: "text" as const, text: sections.join("\n\n") }] };
    }
  );
}
