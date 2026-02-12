import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type RegisterToolFn = (server: McpServer) => void;

/** Standard MCP tool return format. */
export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export interface DocInfo {
  content: string;
  mtime: Date;
  size: number;
}

/** Metadata-only doc info (no content read). */
export interface DocMeta {
  mtime: Date;
  size: number;
}

export interface CorrectionEntry {
  timestamp: string;
  branch: string;
  user_said: string;
  wrong_action: string;
  root_cause: string;
  category: string;
}

export interface CheckpointLogEntry {
  timestamp: string;
  branch: string;
  summary: string;
  next_steps: string;
  blockers: string | null;
  dirty_files: number;
}

/** Error details from a failed shell command. */
export interface RunError {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  stdout: string;
}
