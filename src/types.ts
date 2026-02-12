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

/** Per-project metadata stored alongside the LanceDB */
export interface ProjectMeta {
  project_dir: string;
  onboarded_at: string;
  event_count: number;
}

/** Project registry entry in index.json */
export interface ProjectRegistryEntry {
  hash: string;
  onboarded_at: string;
}

/** Project registry mapping absolute paths to metadata */
export type ProjectRegistry = Record<string, ProjectRegistryEntry>;

/** Search scope for timeline queries */
export type SearchScope = "current" | "related" | "all";

/** Triage classification levels for prompt analysis */
export type TriageLevel = 'trivial' | 'clear' | 'ambiguous' | 'cross-service' | 'multi-step';

/** Result from triage classification with recommendations */
export interface TriageResult {
  level: TriageLevel;
  confidence: number; // 0-1
  reasons: string[];  // why this classification
  recommended_tools: string[]; // which tools should fire
  cross_service_hits?: string[]; // which related projects matched
}

/** Configuration for preflight checks and triage system */
export interface PreflightConfig {
  related_projects?: Record<string, string>; // alias -> path mapping
  triage?: {
    always_check?: string[];
    skip?: string[];
    cross_service_keywords?: string[];
    strictness?: 'relaxed' | 'standard' | 'strict';
  };
  correction_pattern_count?: number;
}
