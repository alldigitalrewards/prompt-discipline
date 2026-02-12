import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "fs";
import { join } from "path";
import { PROJECT_DIR } from "./files.js";

export const STATE_DIR = join(PROJECT_DIR, ".claude", "prompt-coach-state");

/** Max log file size in bytes (5 MB). Triggers rotation. */
const MAX_LOG_SIZE = 5 * 1024 * 1024;

/** Lazily ensures the state directory exists. Called before any write. */
function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

/**
 * Load a JSON state file by name (without extension).
 * Returns empty object if missing or corrupt.
 */
export function loadState(name: string): Record<string, any> {
  const p = join(STATE_DIR, `${name}.json`);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Save a JSON state file by name (without extension).
 */
export function saveState(name: string, data: Record<string, any>): void {
  ensureStateDir();
  writeFileSync(join(STATE_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

/**
 * Append a JSONL entry to a log file. Rotates if file exceeds MAX_LOG_SIZE.
 */
export function appendLog(filename: string, entry: Record<string, any>): void {
  ensureStateDir();
  const logFile = join(STATE_DIR, filename);

  // Rotate if too large
  if (existsSync(logFile)) {
    try {
      const size = statSync(logFile).size;
      if (size > MAX_LOG_SIZE) {
        const backup = logFile + ".old";
        // Keep only one backup; overwrite previous
        renameSync(logFile, backup);
      }
    } catch { /* stat/rename failure is non-fatal */ }
  }

  appendFileSync(logFile, JSON.stringify(entry) + "\n");
}

/**
 * Read a JSONL log file. Pass `lastN` to only return the last N entries
 * (still reads the file, but avoids allocating all parsed objects).
 */
export function readLog(filename: string, lastN?: number): Record<string, any>[] {
  const logFile = join(STATE_DIR, filename);
  if (!existsSync(logFile)) return [];
  try {
    const raw = readFileSync(logFile, "utf-8").trim();
    if (!raw) return [];
    const lines = raw.split("\n");
    const subset = lastN != null && lastN > 0 ? lines.slice(-lastN) : lines;
    const results: Record<string, any>[] = [];
    for (const line of subset) {
      try { results.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return results;
  } catch {
    return [];
  }
}

/** ISO timestamp for the current moment. */
export function now(): string {
  return new Date().toISOString();
}
