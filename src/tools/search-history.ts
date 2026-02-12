import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchSemantic, listIndexedProjects } from "../lib/timeline-db.js";
import type { SearchScope } from "../types.js";

const RELATIVE_DATE_RE = /^(\d+)(days?|weeks?|months?|years?)$/;

function parseRelativeDate(input: string): string {
  const match = input.match(RELATIVE_DATE_RE);
  if (!match) return input; // assume ISO already
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  const d = new Date();
  if (unit.startsWith("day")) d.setDate(d.getDate() - num);
  else if (unit.startsWith("week")) d.setDate(d.getDate() - num * 7);
  else if (unit.startsWith("month")) d.setMonth(d.getMonth() - num);
  else if (unit.startsWith("year")) d.setFullYear(d.getFullYear() - num);
  return d.toISOString();
}

const TYPE_BADGES: Record<string, string> = {
  prompt: "💬 prompt",
  assistant: "🤖 assistant",
  correction: "❌ correction",
  commit: "📦 commit",
  tool_call: "🔧 tool_call",
  compaction: "🗜️ compaction",
  sub_agent_spawn: "🚀 sub_agent_spawn",
  error: "⚠️ error",
};

/** Parse PREFLIGHT_RELATED env var into project paths */
function getRelatedProjects(): string[] {
  const related = process.env.PREFLIGHT_RELATED;
  if (!related) return [];
  return related.split(",").map(p => p.trim()).filter(Boolean);
}

/** Get project directories to search based on scope */
async function getSearchProjects(scope: SearchScope): Promise<string[]> {
  const currentProject = process.env.CLAUDE_PROJECT_DIR;
  
  switch (scope) {
    case "current":
      return currentProject ? [currentProject] : [];
      
    case "related":
      const related = getRelatedProjects();
      return currentProject ? [currentProject, ...related] : related;
      
    case "all":
      const projects = await listIndexedProjects();
      return projects.map(p => p.project);
      
    default:
      return currentProject ? [currentProject] : [];
  }
}

export function registerSearchHistory(server: McpServer) {
  server.tool(
    "search_history",
    "Semantic search across the unified timeline of prompts, commits, corrections, and tool calls. Find relevant events using natural language queries.",
    {
      query: z.string().describe("Natural language search query"),
      scope: z.enum(["current", "related", "all"]).default("current").describe("Search scope: current project, related projects (PREFLIGHT_RELATED), or all indexed projects"),
      project: z.string().optional().describe("Filter to a specific project name (overrides scope)"),
      branch: z.string().optional(),
      author: z.string().optional().describe("Filter commits to this author (partial match, case-insensitive)"),
      type: z.enum(["prompt", "assistant", "correction", "commit", "tool_call", "compaction", "sub_agent_spawn", "error", "all"]).default("all"),
      since: z.string().optional().describe("ISO date or relative: '2025-06-01', '3months'"),
      until: z.string().optional().describe("ISO date or relative"),
      limit: z.number().default(10),
    },
    async (params) => {
      const since = params.since ? parseRelativeDate(params.since) : undefined;
      const until = params.until ? parseRelativeDate(params.until) : undefined;

      // Determine which projects to search
      let projectDirs: string[];
      if (params.project) {
        // Specific project overrides scope
        projectDirs = [params.project];
      } else {
        projectDirs = await getSearchProjects(params.scope);
      }

      if (projectDirs.length === 0) {
        return { 
          content: [{ 
            type: "text", 
            text: `## Search Results for "${params.query}"\n_No projects found for scope "${params.scope}". Make sure CLAUDE_PROJECT_DIR is set or projects are onboarded._` 
          }] 
        };
      }

      let results = await searchSemantic(params.query, {
        project_dirs: projectDirs,
        project: undefined, // Don't filter by single project when using project_dirs
        branch: params.branch,
        type: params.type === "all" ? undefined : params.type,
        since,
        until,
        limit: params.author ? params.limit * 3 : params.limit, // over-fetch if filtering by author
      });

      // Post-filter by author (stored in metadata JSON)
      if (params.author) {
        const authorLower = params.author.toLowerCase();
        results = results.filter((r: any) => {
          try {
            const meta = JSON.parse(r.metadata || "{}");
            return (meta.author || "").toLowerCase().includes(authorLower);
          } catch { return false; }
        }).slice(0, params.limit);
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: `## Search Results for "${params.query}"\n_No results found._` }] };
      }

      const projects = new Set(results.map((r: any) => r.project || "unknown"));
      const lines: string[] = [
        `## Search Results for "${params.query}"`,
        `_${results.length} result${results.length !== 1 ? "s" : ""} across ${projects.size} project${projects.size !== 1 ? "s" : ""}_`,
        "",
      ];

      results.forEach((event: any, i: number) => {
        const badge = TYPE_BADGES[event.type] || event.type;
        const ts = event.timestamp ? new Date(event.timestamp).toISOString().replace("T", " ").slice(0, 16) : "unknown";
        const proj = event.project || "unknown";
        const branch = event.branch ? ` / ${event.branch}` : "";
        const score = event._distance != null ? (1 - event._distance).toFixed(2) : "?";

        lines.push(`### ${i + 1}. [${badge}] ${proj}${branch} — ${ts}`);

        const content = (event.content || event.summary || "").slice(0, 200);
        lines.push(`> ${content.replace(/\n/g, "\n> ")}`);

        const meta: string[] = [`Score: ${score}`];
        if (event.session_id) meta.push(`Session: ${event.session_id.slice(0, 8)}`);
        if (event.commit_hash) meta.push(`Hash: ${event.commit_hash.slice(0, 7)}`);
        lines.push(meta.join(" | "));
        lines.push("");
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
