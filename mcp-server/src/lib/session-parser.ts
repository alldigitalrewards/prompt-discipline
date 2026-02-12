/**
 * session-parser.ts — Parse Claude Code session JSONL files into timeline events.
 */
import { readFileSync, readdirSync, statSync, existsSync, createReadStream } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { createInterface } from "readline";

// ── Types ──────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: string;
  project: string;
  project_name: string;
  branch: string;
  session_id: string;
  source_file: string;
  source_line: number;
  content: string;
  content_preview: string;
  metadata: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB

const CORRECTION_PATTERNS = [
  /\bno\b/i, /\bwrong\b/i, /\bnot that\b/i, /\bi meant\b/i,
  /\bactually\b/i, /\binstead\b/i, /\bundo\b/i,
];

// ── Helpers ────────────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

function extractToolUseBlocks(content: unknown): any[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b: any) => b.type === "tool_use");
}

function normalizeTimestamp(ts: unknown, fallback: string): string {
  if (!ts) return fallback;
  if (typeof ts === "string") {
    const d = new Date(ts);
    return isNaN(d.getTime()) ? fallback : d.toISOString();
  }
  if (typeof ts === "number") {
    // epoch seconds or ms
    const d = new Date(ts < 1e12 ? ts * 1000 : ts);
    return isNaN(d.getTime()) ? fallback : d.toISOString();
  }
  return fallback;
}

function preview(text: string, max = 120): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

function isCorrection(text: string): boolean {
  return CORRECTION_PATTERNS.some((p) => p.test(text));
}

function makeEvent(
  partial: Omit<TimelineEvent, "id" | "content_preview"> & { content_preview?: string },
): TimelineEvent {
  return {
    id: randomUUID(),
    content_preview: partial.content_preview ?? preview(partial.content),
    ...partial,
  } as TimelineEvent;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Discover all Claude project session directories.
 */
export function findSessionDirs(): { project: string; projectName: string; sessionDir: string }[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  const results: { project: string; projectName: string; sessionDir: string }[] = [];
  for (const entry of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = join(CLAUDE_PROJECTS_DIR, entry.name);
    // Decode project path: leading `-` → `/`, internal `-` are ambiguous
    // but the last path segment is a reasonable "name"
    const decoded = entry.name.replace(/^-/, "/").replace(/-/g, "/");
    const projectName = decoded.split("/").filter(Boolean).pop() ?? entry.name;
    results.push({ project: decoded, projectName, sessionDir });
  }
  return results;
}

/**
 * List JSONL session files in a project directory (including subagent files).
 */
export function findSessionFiles(
  projectDir: string,
): { sessionId: string; path: string; mtime: Date }[] {
  if (!existsSync(projectDir)) return [];
  const results: { sessionId: string; path: string; mtime: Date }[] = [];

  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      const p = join(projectDir, entry.name);
      results.push({
        sessionId: basename(entry.name, ".jsonl"),
        path: p,
        mtime: statSync(p).mtime,
      });
    }
    // Check for subagent dirs: <uuid>/subagents/<sub-uuid>.jsonl
    if (entry.isDirectory()) {
      const subDir = join(projectDir, entry.name, "subagents");
      if (existsSync(subDir)) {
        for (const sub of readdirSync(subDir)) {
          if (sub.endsWith(".jsonl")) {
            const p = join(subDir, sub);
            results.push({
              sessionId: basename(sub, ".jsonl"),
              path: p,
              mtime: statSync(p).mtime,
            });
          }
        }
      }
    }
  }
  return results;
}

/**
 * Parse a single JSONL session file into timeline events.
 * For files >10MB, streams line-by-line.
 */
export function parseSession(
  filePath: string,
  project: string,
  projectName: string,
): TimelineEvent[] {
  const stat = statSync(filePath);
  const fallbackTs = stat.mtime.toISOString();

  if (stat.size > LARGE_FILE_THRESHOLD) {
    // Return empty — caller should use parseSessionAsync for large files
    // But for sync API compat, read anyway with a buffer
  }

  const lines = readFileSync(filePath, "utf-8").split("\n");
  return parseLinesSync(lines, filePath, project, projectName, fallbackTs);
}

/**
 * Async streaming parser for large files.
 */
export async function parseSessionAsync(
  filePath: string,
  project: string,
  projectName: string,
): Promise<TimelineEvent[]> {
  const stat = statSync(filePath);
  const fallbackTs = stat.mtime.toISOString();
  const events: TimelineEvent[] = [];
  let branch = "";
  let sessionId = basename(filePath, ".jsonl");
  let lastType = "";
  let lineNum = 0;

  const rl = createInterface({ input: createReadStream(filePath, "utf-8"), crlfDelay: Infinity });

  for await (const line of rl) {
    lineNum++;
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      process.stderr.write(`[session-parser] malformed line ${lineNum} in ${filePath}\n`);
      continue;
    }
    const evts = processRecord(obj, filePath, project, projectName, branch, sessionId, fallbackTs, lineNum, lastType);
    if (obj.type === "summary") {
      branch = obj.gitBranch ?? "";
      if (obj.sessionId) sessionId = obj.sessionId;
    }
    if (obj.type === "user" || obj.type === "assistant") lastType = obj.type;
    events.push(...evts);
  }
  return events;
}

// ── Internal ───────────────────────────────────────────────────────────────

function parseLinesSync(
  lines: string[],
  filePath: string,
  project: string,
  projectName: string,
  fallbackTs: string,
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let branch = "";
  let sessionId = basename(filePath, ".jsonl");
  let lastType = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      process.stderr.write(`[session-parser] malformed line ${i + 1} in ${filePath}\n`);
      continue;
    }

    if (obj.type === "summary") {
      branch = obj.gitBranch ?? "";
      if (obj.sessionId) sessionId = obj.sessionId;
      continue;
    }

    const evts = processRecord(obj, filePath, project, projectName, branch, sessionId, fallbackTs, i + 1, lastType);
    if (obj.type === "user" || obj.type === "assistant") lastType = obj.type;
    events.push(...evts);
  }
  return events;
}

function processRecord(
  obj: any,
  filePath: string,
  project: string,
  projectName: string,
  branch: string,
  sessionId: string,
  fallbackTs: string,
  lineNum: number,
  lastType: string,
): TimelineEvent[] {
  const ts = normalizeTimestamp(obj.timestamp, fallbackTs);
  const base = { project, project_name: projectName, branch, session_id: sessionId, source_file: filePath, source_line: lineNum };
  const events: TimelineEvent[] = [];

  if (obj.type === "user") {
    const text = extractText(obj.message?.content);
    if (!text) return events;
    const isCorr = lastType === "assistant" && isCorrection(text);
    events.push(makeEvent({ ...base, timestamp: ts, type: isCorr ? "correction" : "prompt", content: text, metadata: "{}" }));
  } else if (obj.type === "assistant") {
    const content = obj.message?.content;
    const text = extractText(content);
    if (text) {
      events.push(makeEvent({ ...base, timestamp: ts, type: "assistant", content: text, metadata: JSON.stringify({ model: obj.model ?? "" }) }));
    }
    for (const tool of extractToolUseBlocks(content)) {
      const name: string = tool.name ?? "unknown";
      const argsStr = typeof tool.input === "string" ? tool.input : JSON.stringify(tool.input ?? {});
      const isSub = name === "Task" || name === "dispatch_agent";
      events.push(makeEvent({
        ...base,
        timestamp: ts,
        type: isSub ? "sub_agent_spawn" : "tool_call",
        content: `${name}: ${argsStr.slice(0, 100)}`,
        metadata: JSON.stringify({ tool: name }),
      }));
    }
  } else if (obj.type === "tool_result") {
    const isErr = obj.is_error === true || (typeof obj.content === "string" && /stderr/i.test(obj.content));
    if (isErr) {
      const text = extractText(obj.content) || JSON.stringify(obj.content ?? "").slice(0, 200);
      events.push(makeEvent({ ...base, timestamp: ts, type: "error", content: text, metadata: JSON.stringify({ tool_use_id: obj.tool_use_id ?? "" }) }));
    }
  } else if (obj.type === "system") {
    const text = extractText(obj.message?.content ?? obj.content ?? "");
    if (/compact/i.test(text) || obj.subtype === "compaction") {
      events.push(makeEvent({ ...base, timestamp: ts, type: "compaction", content: text || "context compacted", metadata: "{}" }));
    }
  }

  return events;
}

/**
 * Parse all sessions for a project directory, optionally filtering by mtime.
 */
export function parseAllSessions(
  projectDir: string,
  opts?: { since?: Date },
): TimelineEvent[] {
  const files = findSessionFiles(projectDir);
  const { project, projectName } = inferProject(projectDir);
  const events: TimelineEvent[] = [];

  for (const f of files) {
    if (opts?.since && f.mtime < opts.since) continue;
    try {
      events.push(...parseSession(f.path, project, projectName));
    } catch (err) {
      process.stderr.write(`[session-parser] failed to parse ${f.path}: ${err}\n`);
    }
  }
  return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function inferProject(projectDir: string): { project: string; projectName: string } {
  const dir = basename(projectDir);
  const decoded = dir.replace(/^-/, "/").replace(/-/g, "/");
  const projectName = decoded.split("/").filter(Boolean).pop() ?? dir;
  return { project: decoded, projectName };
}
