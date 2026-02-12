import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { DocInfo, DocMeta } from "../types.js";

/** Single source of truth for the project directory. */
export const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const MAX_SCAN_DEPTH = 10;

/**
 * Read a file relative to PROJECT_DIR, returning at most `maxLines` lines.
 * Returns null if the file doesn't exist or can't be read as UTF-8.
 */
export function readIfExists(relPath: string, maxLines = 50): string | null {
  const full = join(PROJECT_DIR, relPath);
  if (!existsSync(full)) return null;
  try {
    const buf = readFileSync(full);
    // Reject likely-binary files: check for null bytes in first 8KB
    if (buf.subarray(0, 8192).includes(0)) return null;
    const lines = buf.toString("utf-8").split("\n");
    return lines.slice(0, maxLines).join("\n");
  } catch {
    return null;
  }
}

/**
 * Scan .claude/ for markdown docs. Returns content + metadata by default.
 * Pass `metadataOnly: true` to skip reading file content.
 */
export function findWorkspaceDocs(opts?: { metadataOnly?: boolean }): Record<string, DocInfo> {
  const docs: Record<string, DocInfo> = {};
  const claudeDir = join(PROJECT_DIR, ".claude");
  if (!existsSync(claudeDir)) return docs;

  const scanDir = (dir: string, prefix = "", depth = 0): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const rel = prefix ? `${prefix}/${entry}` : entry;
        const stat = statSync(full);
        if (stat.isDirectory() && !entry.startsWith(".") && !entry.includes("node_modules") && entry !== "prompt-coach-state") {
          scanDir(full, rel, depth + 1);
        } else if (entry.endsWith(".md") && stat.size < 50000) {
          docs[rel] = {
            content: opts?.metadataOnly ? "" : readFileSync(full, "utf-8").split("\n").slice(0, 40).join("\n"),
            mtime: stat.mtime,
            size: stat.size,
          };
        }
      }
    } catch { /* permission errors, etc. */ }
  };

  scanDir(claudeDir);
  return docs;
}
