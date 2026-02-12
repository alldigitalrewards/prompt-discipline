import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as fs from "fs";
import * as path from "path";
import { findSessionDirs, findSessionFiles } from "../lib/session-parser.js";

interface SessionInfo {
  project: string;
  projectName: string;
  sessionId: string;
  path: string;
  mtime: Date;
  size: number;
  branch?: string;
  lastMessage?: string;
  messageCount?: number;
}

function formatAge(ms: number): string {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function readLastLines(filePath: string, n: number): string[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    return lines.slice(-n);
  } catch {
    return [];
  }
}

function readFirstLine(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const text = buf.toString("utf-8", 0, bytesRead);
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } catch {
    return null;
  }
}

function extractBranchFromSession(firstLine: string | null): string | undefined {
  if (!firstLine) return undefined;
  try {
    const obj = JSON.parse(firstLine);
    return obj.branch || obj.metadata?.branch;
  } catch {
    return undefined;
  }
}

function extractMessageContent(line: string): string | undefined {
  try {
    const obj = JSON.parse(line);
    if (obj.type === "human" || obj.type === "prompt") return obj.content?.slice(0, 120);
    if (obj.type === "assistant") return obj.content?.slice(0, 120);
    if (obj.message?.content) return obj.message.content.slice(0, 120);
    if (typeof obj.content === "string") return obj.content.slice(0, 120);
  } catch {
    // not JSON
  }
  return undefined;
}

export function registerScanSessions(server: McpServer) {
  server.tool(
    "scan_sessions",
    "Live scan of Claude Code sessions on disk. Shows active and recent sessions, file sizes, and optionally last messages. Detects parallel sessions on the same branch.",
    {
      project: z.string().optional().describe("Project name or path. If omitted, scans all projects."),
      active_only: z.boolean().default(false).describe("Only show sessions modified in last hour"),
      include_messages: z.number().default(0).describe("Include last N messages from each session"),
      sort: z.enum(["recent", "size", "messages"]).default("recent"),
    },
    async (params) => {
      const allDirs = findSessionDirs();
      const filtered = params.project
        ? allDirs.filter(
            (d) =>
              d.projectName === params.project ||
              d.project === params.project ||
              d.projectName.toLowerCase().includes(params.project!.toLowerCase())
          )
        : allDirs;

      if (filtered.length === 0) {
        return { content: [{ type: "text", text: "## Sessions\n_No session directories found._" }] };
      }

      // Gather all sessions
      const sessions: SessionInfo[] = [];
      for (const dir of filtered) {
        const files = findSessionFiles(dir.sessionDir);
        for (const f of files) {
          let size = 0;
          try {
            size = fs.statSync(f.path).size;
          } catch {}

          const firstLine = readFirstLine(f.path);
          const branch = extractBranchFromSession(firstLine);

          const info: SessionInfo = {
            project: dir.project,
            projectName: dir.projectName,
            sessionId: f.sessionId,
            path: f.path,
            mtime: f.mtime,
            size,
            branch,
          };

          if (params.include_messages > 0) {
            const lastLines = readLastLines(f.path, params.include_messages);
            const messages = lastLines.map(extractMessageContent).filter(Boolean) as string[];
            info.lastMessage = messages[messages.length - 1];
            info.messageCount = messages.length;
          }

          sessions.push(info);
        }
      }

      const now = Date.now();
      const ONE_HOUR = 3600000;

      // Filter active only
      const visible = params.active_only
        ? sessions.filter((s) => now - s.mtime.getTime() < ONE_HOUR)
        : sessions;

      if (visible.length === 0) {
        return { content: [{ type: "text", text: "## Sessions\n_No active sessions found._" }] };
      }

      // Sort
      if (params.sort === "recent") visible.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      else if (params.sort === "size") visible.sort((a, b) => b.size - a.size);
      else visible.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));

      // Group by project
      const byProject = new Map<string, SessionInfo[]>();
      for (const s of visible) {
        if (!byProject.has(s.projectName)) byProject.set(s.projectName, []);
        byProject.get(s.projectName)!.push(s);
      }

      const lines: string[] = ["## Active Sessions", ""];
      const warnings: string[] = [];

      for (const [projName, projSessions] of byProject) {
        const activeCount = projSessions.filter((s) => now - s.mtime.getTime() < ONE_HOUR).length;
        lines.push(`### ${projName} (${projSessions.length} session${projSessions.length !== 1 ? "s" : ""}${activeCount > 0 ? `, ${activeCount} active` : ""})`);

        for (const s of projSessions) {
          const isActive = now - s.mtime.getTime() < ONE_HOUR;
          const prefix = isActive ? "⚡" : "  ";
          const branch = s.branch || "unknown";
          const age = formatAge(now - s.mtime.getTime());
          const size = formatSize(s.size);

          lines.push(`${prefix} **${s.sessionId.slice(0, 8)}** — ${branch} — Last active: ${age} — ${size}`);

          if (s.lastMessage) {
            lines.push(`   Last: "${s.lastMessage}"`);
          }
        }

        // Detect parallel sessions (same branch, both active in last hour)
        const branchGroups = new Map<string, SessionInfo[]>();
        for (const s of projSessions) {
          if (!s.branch || now - s.mtime.getTime() >= ONE_HOUR) continue;
          if (!branchGroups.has(s.branch)) branchGroups.set(s.branch, []);
          branchGroups.get(s.branch)!.push(s);
        }
        for (const [branch, group] of branchGroups) {
          if (group.length > 1) {
            warnings.push(`⚠️ Parallel session warning: ${projName} has ${group.length} sessions on \`${branch}\` branch`);
          }
        }

        lines.push("");
      }

      if (warnings.length > 0) {
        lines.push(...warnings);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
