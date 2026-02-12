<div align="center">

# 🧠 prompt-discipline

**Stop wasting tokens on vague prompts.**

An 18-tool MCP server for Claude Code that catches ambiguous instructions before they cost you 2-3x in wrong→fix cycles — plus semantic search across your entire session history.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blueviolet)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## The Problem

We analyzed 125 prompts across 9 real Claude Code sessions. The findings were brutal:

- **41% of prompts were under 50 characters** — things like `fix the tests`, `commit this`, `remove them`
- Each vague prompt triggers a **wrong→fix cycle costing 2-3x tokens**
- **~33K characters/day** duplicated from repeated context pastes
- **6 context compactions** from unbounded session scope
- Estimated **30-40% of tokens wasted** on avoidable back-and-forth

The pattern is always the same: vague prompt → Claude guesses → wrong output → you correct → repeat. That's your money evaporating.

## The Solution

18 tools in 3 categories that run as an MCP server inside Claude Code:

| Category | What it does |
|----------|-------------|
| 🎯 **Prompt Discipline** (12 tools) | Catches vague prompts, enforces structure, prevents waste |
| 🔍 **Timeline Intelligence** (4 tools) | LanceDB vector search across months of session history |
| ✅ **Verification & Hygiene** (2 tools) | Type-check, test, and audit before declaring done |

## Before / After

```
❌  "fix the auth bug"
     → Claude guesses which auth bug, edits wrong file
     → You correct it, 3 more rounds
     → 12,000 tokens burned

✅  prompt-discipline intercepts → clarify_intent fires
     → "Which auth bug? I see 3 open issues:
        1. JWT expiry not refreshing (src/auth/jwt.ts)
        2. OAuth callback 404 (src/auth/oauth.ts)  
        3. Session cookie SameSite (src/middleware/session.ts)
        Pick one and I'll scope the fix."
     → 4,000 tokens, done right the first time
```

## Quick Start

**1. Clone & install:**
```bash
git clone https://github.com/TerminalGravity/prompt-discipline.git
cd prompt-discipline && npm install
```

**2. Add to your Claude Code config** (`.claude/settings.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "prompt-coach": {
      "command": "npx",
      "args": ["tsx", "/path/to/prompt-discipline/src/index.ts"],
      "env": {
        "CLAUDE_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

**3. Restart Claude Code.** That's it. The tools activate automatically.

## Tool Reference

### 🎯 Prompt Discipline

| Tool | What it does |
|------|-------------|
| `scope_work` | Creates structured execution plans before coding starts |
| `clarify_intent` | Gathers project context to disambiguate vague prompts |
| `enrich_agent_task` | Enriches sub-agent tasks with file paths and patterns |
| `sharpen_followup` | Resolves "fix it" / "do the others" to actual file targets |
| `token_audit` | Detects waste patterns, grades your session A–F |
| `sequence_tasks` | Orders tasks by dependency, locality, and risk |
| `checkpoint` | Save game before compaction — commits + resumption notes |
| `check_session_health` | Monitors uncommitted files, time since commit, turn count |
| `log_correction` | Tracks corrections and identifies recurring error patterns |
| `session_handoff` | Generates handoff briefs for new sessions |
| `what_changed` | Summarizes diffs since last checkpoint |

### 🔍 Timeline Intelligence

| Tool | What it does |
|------|-------------|
| `onboard_project` | Indexes a project's session history into LanceDB vectors |
| `search_history` | Semantic search across all indexed sessions |
| `timeline` | Chronological view of events across sessions |
| `scan_sessions` | Live scanning of active session data |

### ✅ Verification & Hygiene

| Tool | What it does |
|------|-------------|
| `verify_completion` | Runs type check + tests + build before declaring done |
| `audit_workspace` | Finds stale/missing workspace docs vs git activity |

## Timeline Intelligence

This is the feature that makes prompt-discipline more than a linter.

When you run `onboard_project`, the server scans your Claude Code session history (JSONL files in `~/.claude/projects/`) and indexes every event into a local [LanceDB](https://lancedb.github.io/lancedb/) database with vector embeddings.

**What that gives you:**
- 🔎 **Semantic search** — "How did I set up the auth middleware last month?" actually works
- 📊 **32K+ events** indexed across 9 months of real sessions
- 🧭 **Timeline view** — see what happened across sessions chronologically
- 🔄 **Live scanning** — index new sessions as they happen

No data leaves your machine. Embeddings run locally by default (Xenova/transformers.js) or via OpenAI if configured.

## Architecture

```
Claude Code ←→ MCP Protocol ←→ prompt-discipline server
                                      │
                    ┌─────────────────┼─────────────────┐
                    │                 │                  │
              Discipline Tools   Timeline Tools    Verification
              (12 tools)         (4 tools)         (2 tools)
                                      │
                                  LanceDB
                                (local vectors)
                                      │
                              ~/.claude/projects/
                            (session JSONL files)
```

## Configuration

### Embedding Providers

| Provider | Setup | Speed | Quality |
|----------|-------|-------|---------|
| **Local (Xenova)** | Zero config, default | ~50 events/sec | Good |
| **OpenAI** | Set `OPENAI_API_KEY` env var | ~200 events/sec | Excellent |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_PROJECT_DIR` | Project root to monitor | Required |
| `OPENAI_API_KEY` | OpenAI key for embeddings | (uses local Xenova) |

## Contributing

This project is young and there's plenty to do. Check the [issues](https://github.com/TerminalGravity/prompt-discipline/issues) — several are tagged `good first issue`.

PRs welcome. No CLA, no bureaucracy. If it makes the tool better, it gets merged.

## Full Plugin

Want hooks, slash commands, and skills on top of the MCP server? See the full plugin at [alldigitalrewards/claude-plugins](https://github.com/alldigitalrewards/claude-plugins) → `plugins/prompt-discipline/`

## License

MIT — do whatever you want with it.
