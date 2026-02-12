#!/bin/bash
# =============================================================================
# Prompt Sharpener — PreToolUse Hook
# =============================================================================
# Fires before Write, Edit, Bash, Task (sub-agent spawn)
#
# PURPOSE: Catch when Claude is about to execute based on a vague/ambiguous
# instruction. Instead of blocking, it injects a prompt that forces Claude
# to state what it's doing and why — making silent guesses visible.
#
# PHILOSOPHY: We don't block tool calls. We make Claude show its work.
# If it can justify the action, great. If it can't, it'll naturally pause.
# =============================================================================

set -euo pipefail

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')
OLD_STRING=$(echo "$INPUT" | jq -r '.tool_input.old_string // empty')

WARNINGS=""

# =============================================================================
# 1. FILE EXISTENCE CHECKS
# =============================================================================

if [[ "$TOOL_NAME" == "Edit" && -n "$FILE_PATH" ]]; then
  # Editing a file that doesn't exist
  if [[ ! -f "$FILE_PATH" ]]; then
    WARNINGS+="🔍 FILE NOT FOUND: '$FILE_PATH' doesn't exist. Did you mean a different path? Use \`find\` or \`ls\` to verify.\n\n"
  fi

  # Editing with old_string that might not match (check if file exists first)
  if [[ -f "$FILE_PATH" && -n "$OLD_STRING" ]]; then
    # Check if the old_string actually exists in the file
    if ! grep -qF "$OLD_STRING" "$FILE_PATH" 2>/dev/null; then
      WARNINGS+="🔍 EDIT MISMATCH: The text you're trying to replace doesn't exist in '$FILE_PATH'. The file may have changed since you last read it. Re-read the file first.\n\n"
    fi
  fi
fi

if [[ "$TOOL_NAME" == "Write" && -n "$FILE_PATH" ]]; then
  # Overwriting an existing file — is this intentional?
  if [[ -f "$FILE_PATH" ]]; then
    LINE_COUNT=$(wc -l < "$FILE_PATH" 2>/dev/null || echo "0")
    if [[ "$LINE_COUNT" -gt 50 ]]; then
      WARNINGS+="⚠️ OVERWRITING LARGE FILE: '$FILE_PATH' has ${LINE_COUNT} lines. Are you sure you want to overwrite the entire file? Consider using Edit for surgical changes.\n\n"
    fi
  fi
fi

# =============================================================================
# 2. BASH COMMAND SAFETY
# =============================================================================

if [[ "$TOOL_NAME" == "Bash" && -n "$COMMAND" ]]; then

  # Destructive commands
  if echo "$COMMAND" | grep -qE 'rm\s+-r|rm\s+-f|rmdir'; then
    WARNINGS+="🗑️ DESTRUCTIVE: This deletes files. Use \`trash\` instead of \`rm\` for recoverability. Verify this is the exact scope the user requested.\n\n"
  fi

  # Running full test suite when a subset might suffice
  if echo "$COMMAND" | grep -qE '(pnpm|npx|yarn)\s+test$|playwright test$|jest$'; then
    WARNINGS+="🧪 FULL SUITE: Running all tests. If the user's request targets a specific area, run only relevant specs (e.g., \`playwright test tests/functional/ui/challenges/admin/\`).\n\n"
  fi

  # Git push without explicit user request to push
  if echo "$COMMAND" | grep -qE 'git push'; then
    BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
    WARNINGS+="📤 PUSHING to remote (branch: $BRANCH). Confirm the user asked to push, not just commit.\n\n"
  fi

  # Force push
  if echo "$COMMAND" | grep -qE 'git push.*(-f|--force)'; then
    WARNINGS+="🚨 FORCE PUSH detected. This rewrites remote history. Are you absolutely sure?\n\n"
  fi

  # Git checkout/switch that might lose work
  if echo "$COMMAND" | grep -qE 'git (checkout|switch)\s+\S'; then
    DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$DIRTY" -gt 0 ]]; then
      WARNINGS+="⚠️ SWITCHING BRANCHES with $DIRTY uncommitted changes. Stash or commit first.\n\n"
    fi
  fi

  # npm/pnpm install (slow, might not be needed)
  if echo "$COMMAND" | grep -qE '(pnpm|npm|yarn)\s+install$'; then
    WARNINGS+="📦 INSTALLING DEPENDENCIES: This is slow. Only needed if package.json changed. Check \`git diff package.json\` first.\n\n"
  fi

  # Broad grep/find without limits (can flood output)
  if echo "$COMMAND" | grep -qE 'grep\s+-r\s+' && ! echo "$COMMAND" | grep -qE '(-l|--files-with-matches|head|tail|\|)'; then
    WARNINGS+="📜 BROAD SEARCH: Recursive grep without output limits can flood context. Add \`-l\` for filenames only, or pipe to \`head -20\`.\n\n"
  fi

fi

# =============================================================================
# 3. SUB-AGENT SPAWN CHECKS
# =============================================================================

if [[ "$TOOL_NAME" == "Task" ]]; then
  TASK_DESC=$(echo "$INPUT" | jq -r '.tool_input.description // .tool_input.prompt // empty')
  
  # Check for vague agent tasks
  WORD_COUNT=$(echo "$TASK_DESC" | wc -w | tr -d ' ')
  if [[ "$WORD_COUNT" -lt 15 ]]; then
    WARNINGS+="🤖 VAGUE AGENT TASK: Sub-agent prompt is only $WORD_COUNT words. Agents work best with specific targets, scope boundaries, and done conditions. Consider adding:\n- Which files/directories to work in\n- What 'done' looks like (tests pass, type-check clean)\n- What NOT to touch\n\n"
  fi

  # Check for unbounded agent tasks
  if echo "$TASK_DESC" | grep -qiE '(everything|all files|entire|whole project|check all)'; then
    WARNINGS+="🎯 UNBOUNDED AGENT: Task includes words like 'everything/all/entire'. Scope it down — agents with tight boundaries finish faster and produce better results.\n\n"
  fi
fi

# =============================================================================
# 4. WRITE CONTENT QUALITY
# =============================================================================

if [[ "$TOOL_NAME" == "Write" && -n "$CONTENT" ]]; then
  CONTENT_LEN=${#CONTENT}
  
  # Suspiciously short file content (might be a truncated write)
  if [[ "$CONTENT_LEN" -lt 20 && "$FILE_PATH" =~ \.(ts|tsx|js|jsx|py|sh)$ ]]; then
    WARNINGS+="📝 TINY FILE: Writing only $CONTENT_LEN chars to a source file. Is this the complete content, or was it truncated?\n\n"
  fi

  # TODO/placeholder content
  if echo "$CONTENT" | grep -qiE '(TODO|FIXME|PLACEHOLDER|implement this|add code here)'; then
    WARNINGS+="📝 PLACEHOLDER CONTENT: File contains TODO/FIXME/placeholder markers. The user likely expects working code, not stubs.\n\n"
  fi
fi

# =============================================================================
# 5. CONTEXT-AWARE CHECKS (project-specific)
# =============================================================================

# Prisma schema changes without migration plan
if [[ "$FILE_PATH" == *"prisma/schema.prisma"* ]]; then
  WARNINGS+="🗄️ SCHEMA CHANGE: Remember the 3-database rule — local, staging, production must stay in sync. After this change: prisma generate → db:push → apply to staging → apply to production.\n\n"
fi

# Changing test fixtures without understanding the test
if [[ "$FILE_PATH" == *"tests/"* && "$FILE_PATH" == *"fixture"* ]]; then
  WARNINGS+="🧪 FIXTURE CHANGE: Modifying test fixtures can break other tests that share them. Check which specs import this fixture.\n\n"
fi

# Modifying shared components that affect multiple roles
if [[ "$FILE_PATH" == *"components/"* && ! "$FILE_PATH" == *"components/ui/"* ]]; then
  WARNINGS+="🔀 SHARED COMPONENT: This component may be used by multiple roles/pages. Check imports before changing: \`grep -r '$(basename "$FILE_PATH" .tsx)' app/ --include='*.tsx' -l\`\n\n"
fi

# =============================================================================
# OUTPUT
# =============================================================================

if [[ -n "$WARNINGS" ]]; then
  echo "━━━ PROMPT SHARPENER ━━━"
  echo ""
  echo -e "$WARNINGS"
  echo "If all of the above are intentional, proceed. Otherwise, adjust your approach."
  echo "━━━━━━━━━━━━━━━━━━━━━━━"
fi

exit 0
