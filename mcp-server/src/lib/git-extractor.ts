/**
 * git-extractor.ts — Extract git commit history as timeline events.
 */
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { TimelineEvent } from "./session-parser.js";

// In git --format, %% produces a literal %. So we use %%…%% in the format
// string, but the actual output contains %…%. We need separate constants.
const COMMIT_SEP_FMT = "%%COMMIT_START%%";
const COMMIT_END_FMT = "%%COMMIT_END%%";
const FIELD_SEP_FMT = "%%F%%";
// What appears in the output after git processes the format:
const COMMIT_SEP = "%COMMIT_START%";
const COMMIT_END = "%COMMIT_END%";
const FIELD_SEP = "%F%";

/**
 * Extract git commits as TimelineEvent[].
 */
export function extractGitHistory(
  projectDir: string,
  opts?: { since?: Date; branch?: string; maxCount?: number },
): TimelineEvent[] {
  if (!existsSync(join(projectDir, ".git"))) {
    // Try bare dir or parent — but most likely just not a repo
    try {
      execSync("git rev-parse --git-dir", { cwd: projectDir, stdio: "pipe" });
    } catch {
      return [];
    }
  }

  const args: string[] = ["git", "log"];

  if (opts?.branch) {
    args.push(opts.branch);
  } else {
    args.push("--all");
  }

  const maxCount = opts?.maxCount ?? 10000;
  args.push(`--max-count=${maxCount}`);

  if (opts?.since) {
    args.push(`--since=${opts.since.toISOString()}`);
  }

  // Format: structured fields separated by known delimiters
  args.push(
    `--format=${COMMIT_SEP_FMT}${FIELD_SEP_FMT}%H${FIELD_SEP_FMT}%aI${FIELD_SEP_FMT}%an${FIELD_SEP_FMT}%s${FIELD_SEP_FMT}%b${FIELD_SEP_FMT}${COMMIT_END_FMT}`,
    "--stat",
  );

  let output: string;
  try {
    output = execSync(args.join(" "), {
      cwd: projectDir,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err: any) {
    // No commits or other git error
    if (err.stdout) output = err.stdout;
    else return [];
  }

  if (!output.trim()) return [];

  const projectName = projectDir.split("/").filter(Boolean).pop() ?? projectDir;
  return parseGitOutput(output, projectDir, projectName);
}

// ── Internal ───────────────────────────────────────────────────────────────

function parseGitOutput(raw: string, project: string, projectName: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // Split on COMMIT_START markers
  const blocks = raw.split(COMMIT_SEP).filter((b) => b.includes(COMMIT_END));

  for (const block of blocks) {
    try {
      const endIdx = block.indexOf(COMMIT_END);
      const headerPart = block.slice(0, endIdx);
      const statPart = block.slice(endIdx + COMMIT_END.length).trim();

      const fields = headerPart.split(FIELD_SEP);
      // fields: ["", hash, date, author, subject, body, ""]
      const hash = fields[1]?.trim() ?? "";
      const dateStr = fields[2]?.trim() ?? "";
      const author = fields[3]?.trim() ?? "";
      const subject = fields[4]?.trim() ?? "";
      const body = fields[5]?.trim() ?? "";

      if (!hash) continue;

      const commitMsg = body ? `${subject}\n\n${body}` : subject;
      const content = statPart ? `${commitMsg}\n\n${statPart}` : commitMsg;

      // Parse diffstat summary (last line like " 3 files changed, 10 insertions(+), 2 deletions(-)")
      const statMatch = statPart.match(
        /(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/,
      );

      const metadata = JSON.stringify({
        hash,
        author,
        files_changed: statMatch ? parseInt(statMatch[1], 10) : 0,
        insertions: statMatch?.[2] ? parseInt(statMatch[2], 10) : 0,
        deletions: statMatch?.[3] ? parseInt(statMatch[3], 10) : 0,
      });

      events.push({
        id: randomUUID(),
        timestamp: new Date(dateStr).toISOString(),
        type: "commit",
        project,
        project_name: projectName,
        branch: "all",
        session_id: "",
        source_file: `git:${hash}`,
        source_line: 0,
        content,
        content_preview: subject.length > 120 ? subject.slice(0, 120) + "…" : subject,
        metadata,
      });
    } catch (err) {
      process.stderr.write(`[git-extractor] failed to parse commit block: ${err}\n`);
    }
  }

  return events;
}
