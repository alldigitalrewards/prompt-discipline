import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { insertEvents, getLastIndexedTimestamp, getIndexedProjects, getEventsTable } from "../lib/timeline-db.js";
import { findSessionDirs, parseAllSessions } from "../lib/session-parser.js";
import { extractGitHistory } from "../lib/git-extractor.js";
import { createEmbeddingProvider } from "../lib/embeddings.js";
import { execSync } from "child_process";

const GIT_DEPTH_MAP: Record<string, number | undefined> = {
  all: undefined,
  "3months": 90,
  "6months": 180,
  "1year": 365,
};

export function registerOnboardProject(server: McpServer) {
  server.tool(
    "onboard_project",
    "Index a project's Claude Code sessions and git history into the timeline database for semantic search and chronological viewing.",
    {
      project_dir: z.string().describe("Absolute path to the project directory"),
      embedding_provider: z.enum(["local", "openai"]).default("local"),
      openai_api_key: z.string().optional(),
      git_depth: z.enum(["all", "6months", "1year", "3months"]).default("all"),
      git_since: z.string().optional().describe("Override git_depth with exact start date (ISO: '2025-08-01')"),
      git_authors: z.array(z.string()).optional().describe("Filter git commits to these authors. If omitted, auto-detects the primary author (most commits)."),
      reindex: z.boolean().default(false).describe("If true, drop existing data and rebuild from scratch"),
    },
    async (params) => {
      const { project_dir, embedding_provider, openai_api_key, git_depth, git_since, git_authors, reindex } = params;

      // 1. Validate project_dir
      if (!fs.existsSync(project_dir)) {
        return { content: [{ type: "text", text: `❌ Directory not found: ${project_dir}` }] };
      }
      if (!fs.existsSync(path.join(project_dir, ".git"))) {
        return { content: [{ type: "text", text: `❌ Not a git repository: ${project_dir}` }] };
      }

      const projectName = path.basename(project_dir);
      const progress: string[] = [];
      progress.push(`🔍 Onboarding project: **${projectName}** (${project_dir})`);

      // Auto-detect git authors if not provided
      let effectiveAuthors = git_authors;
      if (!effectiveAuthors || effectiveAuthors.length === 0) {
        try {
          // Get the configured git user for this repo
          const gitUser = execSync("git config user.name", { cwd: project_dir, encoding: "utf-8" }).trim();
          if (gitUser) {
            // Also find authors with >5% of commits to include collaborators
            const authorCounts = execSync(
              'git log --all --format="%an" | sort | uniq -c | sort -rn | head -10',
              { cwd: project_dir, encoding: "utf-8", maxBuffer: 1024 * 1024 }
            ).trim().split("\n").map(line => {
              const match = line.trim().match(/^(\d+)\s+(.+)$/);
              return match ? { count: parseInt(match[1]), name: match[2] } : null;
            }).filter(Boolean) as { count: number; name: string }[];

            const totalCommits = authorCounts.reduce((s, a) => s + a.count, 0);
            // Include git user + any author with >5% of commits (skip bots)
            const botPatterns = /\[bot\]|dependabot|renovate|github-actions/i;
            effectiveAuthors = authorCounts
              .filter(a => (a.name === gitUser || a.count / totalCommits > 0.05) && !botPatterns.test(a.name))
              .map(a => a.name);

            if (effectiveAuthors.length === 0) effectiveAuthors = [gitUser];
            progress.push(`👤 Auto-detected authors: ${effectiveAuthors.join(", ")} (from git config + commit history)`);
          }
        } catch {
          // If auto-detect fails, include all authors
          progress.push("👤 Could not auto-detect authors — including all commits");
        }
      }

      // 2. Find Claude session dir
      const sessionDirs = findSessionDirs();
      const projectSession = sessionDirs.find(
        (s) => s.project === project_dir || s.projectName === projectName
      );

      // 3. Determine incremental timestamps
      let sessionSince: Date | undefined;
      let gitSince: Date | undefined;

      if (reindex) {
        progress.push("♻️ Reindex requested — rebuilding from scratch");
        // Drop existing data for this project
        try {
          const table = await getEventsTable();
          await table.delete(`project = "${projectName}"`);
        } catch {
          // Table may not exist yet
        }
      } else {
        const lastSession = await getLastIndexedTimestamp(projectName, "session");
        const lastGit = await getLastIndexedTimestamp(projectName, "git");
        if (lastSession) {
          sessionSince = new Date(lastSession);
          progress.push(`📋 Incremental session scan since ${lastSession}`);
        }
        if (lastGit) {
          gitSince = new Date(lastGit);
          progress.push(`📋 Incremental git scan since ${lastGit}`);
        }
      }

      // 4. Parse sessions
      let sessionEvents: any[] = [];
      if (projectSession) {
        progress.push(`📂 Scanning sessions in ${projectSession.sessionDir}`);
        sessionEvents = parseAllSessions(projectSession.sessionDir, sessionSince ? { since: sessionSince } : undefined);
        progress.push(`  Found ${sessionEvents.length} new session events`);
      } else {
        progress.push("⚠️ No Claude Code session directory found for this project");
      }

      // 5. Extract git history
      let gitSinceDate: Date | undefined;
      if (git_since) {
        gitSinceDate = new Date(git_since);
        progress.push(`📅 Git history since ${git_since}`);
      } else {
        const depthDays = GIT_DEPTH_MAP[git_depth];
        gitSinceDate = gitSince ?? (depthDays ? new Date(Date.now() - depthDays * 86400000) : undefined);
      }
      let gitEvents = extractGitHistory(project_dir, {
        since: gitSinceDate,
        maxCount: 10000,
      });

      // Filter by authors
      if (effectiveAuthors && effectiveAuthors.length > 0) {
        const authorPatterns = effectiveAuthors.map(a => a.toLowerCase());
        const beforeCount = gitEvents.length;
        gitEvents = gitEvents.filter((e: any) => {
          try {
            const meta = JSON.parse(e.metadata || "{}");
            const author = (meta.author || "").toLowerCase();
            return authorPatterns.some(p => author.includes(p));
          } catch { return true; }
        });
        progress.push(`👤 Filtered to authors [${effectiveAuthors.join(", ")}]: ${gitEvents.length}/${beforeCount} commits`);
      }

      progress.push(`📦 Found ${gitEvents.length} new git events`);

      const allEvents = [...sessionEvents, ...gitEvents];

      if (allEvents.length === 0) {
        progress.push("\n✅ No new events to index. Database is up to date.");
        return { content: [{ type: "text", text: progress.join("\n") }] };
      }

      // 6. Embed all events in batches
      const embedder = createEmbeddingProvider({
        provider: embedding_provider,
        apiKey: openai_api_key,
      });

      const BATCH_SIZE = 50;
      const totalBatches = Math.ceil(allEvents.length / BATCH_SIZE);
      progress.push(`\n🧠 Embedding ${allEvents.length} events (${totalBatches} batches)...`);

      for (let i = 0; i < allEvents.length; i += BATCH_SIZE) {
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const batch = allEvents.slice(i, i + BATCH_SIZE);
        const texts = batch.map((e: any) => e.content || e.summary || "");
        const vectors = await embedder.embedBatch(texts);
        for (let j = 0; j < batch.length; j++) {
          (batch[j] as any).vector = vectors[j];
        }
        progress.push(`  Embedding batch ${batchNum}/${totalBatches}...`);
      }

      // 7. Insert into LanceDB
      await insertEvents(allEvents);
      progress.push("💾 Inserted into database");

      // 8. Summary
      const prompts = allEvents.filter((e: any) => e.type === "prompt").length;
      const commits = allEvents.filter((e: any) => e.type === "commit").length;
      const corrections = allEvents.filter((e: any) => e.type === "correction").length;
      const others = allEvents.length - prompts - commits - corrections;

      // Get total count
      const projects = await getIndexedProjects();
      const thisProject = projects.find((p) => p.project === projectName);
      const totalEvents = thisProject?.event_count ?? allEvents.length;

      progress.push(
        `\n✅ Indexed **${allEvents.length}** new events (${prompts} prompts, ${commits} commits, ${corrections} corrections${others > 0 ? `, ${others} other` : ""}). Total: **${totalEvents}** events.`
      );

      return { content: [{ type: "text", text: progress.join("\n") }] };
    }
  );
}
