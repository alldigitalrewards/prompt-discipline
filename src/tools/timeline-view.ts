import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getTimeline } from "../lib/timeline-db.js";

const RELATIVE_DATE_RE = /^(\d+)(days?|weeks?|months?|years?)$/;

function parseRelativeDate(input: string): string {
  const match = input.match(RELATIVE_DATE_RE);
  if (!match) return input;
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  const d = new Date();
  if (unit.startsWith("day")) d.setDate(d.getDate() - num);
  else if (unit.startsWith("week")) d.setDate(d.getDate() - num * 7);
  else if (unit.startsWith("month")) d.setMonth(d.getMonth() - num);
  else if (unit.startsWith("year")) d.setFullYear(d.getFullYear() - num);
  return d.toISOString();
}

const TYPE_ICONS: Record<string, string> = {
  prompt: "💬",
  assistant: "🤖",
  tool_call: "🔧",
  correction: "❌",
  commit: "📦",
  compaction: "🗜️",
  sub_agent_spawn: "🚀",
  error: "⚠️",
};

export function registerTimeline(server: McpServer) {
  server.tool(
    "timeline",
    "Chronological view of project events grouped by day. Shows prompts, responses, tool calls, corrections, and commits in order.",
    {
      project: z.string().optional(),
      branch: z.string().optional(),
      author: z.string().optional().describe("Filter commits to this author (partial match, case-insensitive)"),
      since: z.string().optional(),
      until: z.string().optional(),
      type: z.enum(["prompt", "assistant", "correction", "commit", "tool_call", "compaction", "sub_agent_spawn", "error", "all"]).default("all"),
      limit: z.number().default(50),
      offset: z.number().default(0),
    },
    async (params) => {
      const since = params.since ? parseRelativeDate(params.since) : undefined;
      const until = params.until ? parseRelativeDate(params.until) : undefined;

      let events = await getTimeline({
        project: params.project,
        branch: params.branch,
        since,
        until,
        type: params.type === "all" ? undefined : params.type,
        limit: params.limit,
        offset: params.offset,
      });

      // Post-filter by author
      if (params.author) {
        const authorLower = params.author.toLowerCase();
        events = events.filter((e: any) => {
          if (e.type !== "commit") return true; // only filter commits
          try {
            const meta = JSON.parse(e.metadata || "{}");
            return (meta.author || "").toLowerCase().includes(authorLower);
          } catch { return true; }
        });
      }

      if (events.length === 0) {
        return { content: [{ type: "text", text: "## Timeline\n_No events found for the given filters._" }] };
      }

      // Group by day
      const days = new Map<string, any[]>();
      for (const event of events) {
        const day = event.timestamp ? new Date(event.timestamp).toISOString().slice(0, 10) : "unknown";
        if (!days.has(day)) days.set(day, []);
        days.get(day)!.push(event);
      }

      // Header
      const proj = params.project || "all projects";
      const branch = params.branch ? ` / ${params.branch}` : "";
      const sortedDays = [...days.keys()].sort().reverse();
      const dateRange = sortedDays.length > 1
        ? `${sortedDays[sortedDays.length - 1]} to ${sortedDays[0]}`
        : sortedDays[0];

      const lines: string[] = [
        `## Timeline: ${proj}${branch}`,
        `_${dateRange} (${events.length} events)_`,
        "",
      ];

      for (const day of sortedDays) {
        lines.push(`### ${day}`);
        const dayEvents = days.get(day)!;
        // Sort by timestamp within day
        dayEvents.sort((a: any, b: any) => {
          const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return ta - tb;
        });

        for (const event of dayEvents) {
          const time = event.timestamp
            ? new Date(event.timestamp).toISOString().slice(11, 16)
            : "??:??";
          const icon = TYPE_ICONS[event.type] || "❓";
          let content = (event.content || event.summary || "").slice(0, 120).replace(/\n/g, " ");

          // Format based on type
          if (event.type === "commit") {
            const hash = event.commit_hash ? event.commit_hash.slice(0, 7) + ": " : "";
            content = `commit: "${hash}${content}"`;
          } else if (event.type === "tool_call") {
            const tool = event.tool_name || "";
            const target = content ? ` → ${content}` : "";
            content = `${tool}${target}`;
          } else {
            content = `"${content}"`;
          }

          lines.push(`- ${time} ${icon} ${content}`);
        }
        lines.push("");
      }

      if (events.length === params.limit) {
        lines.push(`_Showing ${params.limit} events (offset ${params.offset}). Use offset=${params.offset + params.limit} for more._`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
