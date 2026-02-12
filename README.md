# Prompt Discipline

Stop burning tokens on vague prompts. This plugin catches ambiguous instructions before they cause wrong outputs, extra round-trips, and context bloat.

## Quick Start

```bash
# Install globally via npx
npx prompt-discipline init
```

This adds `prompt-discipline` to your `.mcp.json` and prompts you to choose a profile.

## Profiles

| Profile | Tools | Requires |
|---------|-------|----------|
| **minimal** | 4 tools: `clarify_intent`, `check_session_health`, `session_stats`, `prompt_score` | Nothing extra |
| **standard** | 16 tools: all prompt discipline + session_stats + prompt_score | Nothing extra |
| **full** | 20 tools: everything + timeline/vector search | LanceDB |

Set via `PROMPT_DISCIPLINE_PROFILE` env var or choose during `npx prompt-discipline init`.

## The Problem

In real Claude Code sessions, 40%+ of prompts are under 50 characters — things like "fix the tests", "commit this", "remove them". These force Claude to guess, leading to:
- Wrong outputs that need correction (2-3x token cost)
- Extra round-trips asking for clarification
- Context bloat that triggers compaction sooner

## What This Plugin Does

### Hooks
- **Pre-tool ambiguity check**: Before Claude executes Write/Edit/Bash on a vague instruction, it pauses to verify it has the specific file, change, and done condition
- **Session health monitor**: Warns when turn count is high and suggests starting fresh

### Commands
- `/commit-all` — Atomic git commit workflow
- `/execute-plan` — Load and execute a structured plan with batch checkpoints
- `/finish-branch` — Push, PR, review workflow
- `/agent-status` — Check all sub-agents in one prompt
- `/scope-first` — Enumerate pages/routes/roles before starting open-ended work

### Skills
- **prompt-coach** — When Claude detects an ambiguous instruction, it gathers project context and either proceeds with full context or asks one sharp clarifying question

## MCP Server Tools

### Core Tools (standard profile)

| # | Category | Tool(s) |
|---|----------|---------|
| 1 | Plans | `scope_work` |
| 2 | Clarification | `clarify_intent` |
| 3 | Delegation | `enrich_agent_task` |
| 4 | Follow-up Specificity | `sharpen_followup` |
| 5 | Token Efficiency | `token_audit` |
| 6 | Sequencing | `sequence_tasks` |
| 7 | Compaction Management | `checkpoint` |
| 8 | Session Lifecycle | `check_session_health` |
| 9 | Error Recovery | `log_correction` |
| 10 | Workspace Hygiene | `audit_workspace` |
| 11 | Cross-Session Continuity | `session_handoff`, `what_changed` |
| 12 | Verification | `verify_completion` |

### New in v3.0

| Tool | Description | Profile |
|------|-------------|---------|
| `session_stats` | Lightweight JSONL session analysis — no embeddings needed | minimal+ |
| `prompt_score` | Gamified prompt quality scoring (A-F grade, 4 axes) | minimal+ |

### Timeline Tools (full profile)

| Tool | Description |
|------|-------------|
| `onboard_project` | Index project history with embeddings |
| `search_history` | Semantic search across session history |
| `timeline_view` | Chronological timeline view |
| `scan_sessions` | Live session scanning |

## Installation

### npm (recommended)

```bash
npx prompt-discipline init
```

### Manual MCP config

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "prompt-discipline": {
      "command": "npx",
      "args": ["-y", "tsx", "node_modules/prompt-discipline/src/index.ts"],
      "env": {
        "PROMPT_DISCIPLINE_PROFILE": "standard"
      }
    }
  }
}
```

### Full plugin (hooks + commands + skills + MCP server)

```bash
claude plugin link /path/to/prompt-discipline
```

## How the Ambiguity Hook Works

The hook scores the user's last message against 4 criteria:
1. **Target**: Is a specific file/component/test named?
2. **Action**: Is the verb unambiguous?
3. **Scope**: Are boundaries defined?
4. **Done condition**: Is there a way to verify completion?

If 2+ criteria are missing, Claude asks ONE clarifying question before proceeding.

## Measured Impact

Based on session analysis of 125 prompts across 9 sessions:
- 41% of prompts were under 50 chars (most missing 2+ criteria)
- ~33K chars of duplicate content per day from repeated skill pastes
- 6 context compactions from unbounded session scope
- Estimated 30-40% token savings from eliminating vague→wrong→fix cycles

## License

MIT — Jack Felke 2026
