// =============================================================================
// Profile system — controls which tools are registered
// =============================================================================

export type Profile = "minimal" | "standard" | "full";

const MINIMAL_TOOLS = new Set([
  "clarify_intent",
  "check_session_health",
  "session_stats",
  "prompt_score",
]);

const STANDARD_TOOLS = new Set([
  // All 14 prompt discipline tools
  "scope_work",
  "clarify_intent",
  "enrich_agent_task",
  "sharpen_followup",
  "token_audit",
  "sequence_tasks",
  "checkpoint",
  "check_session_health",
  "log_correction",
  "audit_workspace",
  "session_handoff",
  "what_changed",
  "verify_completion",
  // New lightweight tools
  "session_stats",
  "prompt_score",
]);

const FULL_TOOLS = new Set([
  ...STANDARD_TOOLS,
  // Timeline tools (need LanceDB)
  "onboard_project",
  "search_history",
  "timeline_view",
  "scan_sessions",
]);

export function getProfile(): Profile {
  const env = process.env.PROMPT_DISCIPLINE_PROFILE?.toLowerCase();
  if (env === "minimal") return "minimal";
  if (env === "standard") return "standard";
  return "full";
}

export function isToolEnabled(toolName: string): boolean {
  const profile = getProfile();
  switch (profile) {
    case "minimal":
      return MINIMAL_TOOLS.has(toolName);
    case "standard":
      return STANDARD_TOOLS.has(toolName);
    case "full":
      return FULL_TOOLS.has(toolName);
  }
}
