# Hook Installation

Add these entries to your project's `.claude/settings.json` under `hooks`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit|Bash|Task",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/Developer/claude-plugins/plugins/prompt-discipline/hooks/prompt-sharpener.sh\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/Developer/claude-plugins/plugins/prompt-discipline/hooks/session-health.sh\""
          }
        ]
      }
    ]
  }
}
```

## Prompt Sharpener (PreToolUse)

Fires before **Write, Edit, Bash, and Task** (sub-agent spawn). Runs 5 categories of checks:

### 1. File Existence & Edit Safety
| Check | Trigger | Message |
|-------|---------|---------|
| Edit nonexistent file | `Edit` on missing path | "File doesn't exist, use `find` to verify" |
| Edit old_string mismatch | `Edit` where text not found in file | "Text not in file, re-read first" |
| Overwrite large file | `Write` on file >50 lines | "Consider `Edit` for surgical changes" |

### 2. Bash Command Safety
| Check | Trigger | Message |
|-------|---------|---------|
| Destructive delete | `rm -r`, `rm -f`, `rmdir` | "Use `trash` instead, verify scope" |
| Full test suite | `pnpm test`, `playwright test` (no args) | "Run specific specs if request targets an area" |
| Push without ask | `git push` | "Confirm user asked to push, not just commit" |
| Force push | `git push -f` | "Rewrites history, are you sure?" |
| Branch switch with dirty state | `git checkout` with uncommitted changes | "Stash or commit first" |
| Package install | `pnpm install` | "Only if package.json changed" |
| Unbounded grep | `grep -r` without limits | "Add `-l` or pipe to `head`" |

### 3. Sub-Agent Spawn Quality
| Check | Trigger | Message |
|-------|---------|---------|
| Vague task | Task description <15 words | "Add files, done condition, boundaries" |
| Unbounded scope | Words like "everything/all/entire" | "Scope it down for better results" |

### 4. Write Content Quality
| Check | Trigger | Message |
|-------|---------|---------|
| Tiny source file | <20 chars to .ts/.tsx/.js | "Is this complete or truncated?" |
| Placeholder content | TODO/FIXME/placeholder in content | "User expects working code, not stubs" |

### 5. Context-Aware (Changemaker-specific)
| Check | Trigger | Message |
|-------|---------|---------|
| Schema change | Edit prisma/schema.prisma | "3-database sync rule reminder" |
| Fixture change | Edit test fixtures | "Check which specs share this fixture" |
| Shared component | Edit components/ (not ui/) | "Check cross-role imports first" |

## Session Health (PostToolUse)

Fires after every tool call. Tracks depth via counter file in `/tmp/`.

| Threshold | Level | Message |
|-----------|-------|---------|
| 100 calls | 📊 Info | "Consider committing and starting fresh" |
| 200 calls | ⚠️ Warning | "Compaction likely soon, commit all work" |
| 300 calls | 🚨 Critical | "Stop new work, commit, update docs, new session" |

## Combining with Existing Hooks

Your project already has these hooks in `.claude/settings.json`:
- `enforce-supabase-first.sh` (PreToolUse on Write|Edit)
- `schema-change-reminder.sh` (PostToolUse on Write|Edit)

Add the new hooks as additional entries in the same arrays — don't replace existing ones. Multiple hooks on the same matcher run in order.
