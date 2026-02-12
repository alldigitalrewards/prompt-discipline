#!/usr/bin/env node
// =============================================================================
// Prompt Coach MCP Server — v2.0 (TypeScript)
// =============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

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

const server = new McpServer({
  name: "prompt-coach",
  version: "2.1.0",
});

// Register all 12 category tools (14 tools total)
registerScopeWork(server);          // 1. Plans
registerClarifyIntent(server);      // 2. Clarification
registerEnrichAgentTask(server);    // 3. Delegation
registerSharpenFollowup(server);    // 4. Follow-up Specificity
registerTokenAudit(server);         // 5. Token Efficiency
registerSequenceTasks(server);      // 6. Sequencing
registerCheckpoint(server);         // 7. Compaction Management
registerSessionHealth(server);      // 8. Session Lifecycle
registerLogCorrection(server);      // 9. Error Recovery
registerAuditWorkspace(server);     // 10. Workspace Hygiene
registerSessionHandoff(server);     // 11a. Cross-Session Continuity
registerWhatChanged(server);        // 11b. Cross-Session Continuity
registerVerifyCompletion(server);   // 12. Verification

// Connect transport
const transport = new StdioServerTransport();
await server.connect(transport);
