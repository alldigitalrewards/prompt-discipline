#!/usr/bin/env node
// =============================================================================
// Prompt Discipline MCP Server — v3.0
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isToolEnabled, getProfile } from "./profiles.js";

// Category 1: Plans
import { registerScopeWork } from "./tools/scope-work.js";
// Category 2: Clarification
import { registerClarifyIntent } from "./tools/clarify-intent.js";
// Category 3: Delegation
import { registerEnrichAgentTask } from "./tools/enrich-agent-task.js";
// Category 4: Follow-up Specificity
import { registerSharpenFollowup } from "./tools/sharpen-followup.js";
// Category 5: Token Efficiency
import { registerTokenAudit } from "./tools/token-audit.js";
// Category 6: Sequencing
import { registerSequenceTasks } from "./tools/sequence-tasks.js";
// Category 7: Compaction Management
import { registerCheckpoint } from "./tools/checkpoint.js";
// Category 8: Session Lifecycle
import { registerSessionHealth } from "./tools/session-health.js";
// Category 9: Error Recovery
import { registerLogCorrection } from "./tools/log-correction.js";
// Category 10: Workspace Hygiene
import { registerAuditWorkspace } from "./tools/audit-workspace.js";
// Category 11: Cross-Session Continuity
import { registerSessionHandoff } from "./tools/session-handoff.js";
import { registerWhatChanged } from "./tools/what-changed.js";
// Category 12: Verification
import { registerVerifyCompletion } from "./tools/verify-completion.js";
// New lightweight tools
import { registerSessionStats } from "./tools/session-stats.js";
import { registerPromptScore } from "./tools/prompt-score.js";
// Timeline: Project Intelligence
import { registerOnboardProject } from "./tools/onboard-project.js";
import { registerSearchHistory } from "./tools/search-history.js";
import { registerTimeline } from "./tools/timeline-view.js";
import { registerScanSessions } from "./tools/scan-sessions.js";

const profile = getProfile();
const server = new McpServer({
  name: "prompt-discipline",
  version: "3.0.0",
});

// Register tools based on profile
type RegisterFn = (server: McpServer) => void;

const toolRegistry: Array<[string, RegisterFn]> = [
  ["scope_work", registerScopeWork],
  ["clarify_intent", registerClarifyIntent],
  ["enrich_agent_task", registerEnrichAgentTask],
  ["sharpen_followup", registerSharpenFollowup],
  ["token_audit", registerTokenAudit],
  ["sequence_tasks", registerSequenceTasks],
  ["checkpoint", registerCheckpoint],
  ["check_session_health", registerSessionHealth],
  ["log_correction", registerLogCorrection],
  ["audit_workspace", registerAuditWorkspace],
  ["session_handoff", registerSessionHandoff],
  ["what_changed", registerWhatChanged],
  ["verify_completion", registerVerifyCompletion],
  ["session_stats", registerSessionStats],
  ["prompt_score", registerPromptScore],
  ["onboard_project", registerOnboardProject],
  ["search_history", registerSearchHistory],
  ["timeline_view", registerTimeline],
  ["scan_sessions", registerScanSessions],
];

let registered = 0;
for (const [name, register] of toolRegistry) {
  if (isToolEnabled(name)) {
    register(server);
    registered++;
  }
}

process.stderr.write(`prompt-discipline: profile=${profile}, tools=${registered}\n`);

// Graceful shutdown
function shutdown() {
  process.stderr.write("prompt-discipline: shutting down\n");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Connect transport
try {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("prompt-discipline: server started\n");
} catch (err) {
  process.stderr.write(`prompt-discipline: failed to start — ${err}\n`);
  process.exit(1);
}
