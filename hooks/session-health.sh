#!/bin/bash
# Prompt Discipline: Session health monitor
# Fires after tool use to track session depth and warn before compaction

INPUT=$(cat)

# Count approximate session depth by checking conversation turn indicators
# This is a heuristic - hooks don't have direct access to turn count
# Instead, we track via a temp file that increments per tool call
SESSION_ID="${CLAUDE_SESSION_ID:-default}"
COUNTER_FILE="/tmp/prompt-discipline-${SESSION_ID}.count"

if [[ -f "$COUNTER_FILE" ]]; then
  COUNT=$(cat "$COUNTER_FILE")
  COUNT=$((COUNT + 1))
else
  COUNT=1
fi
echo "$COUNT" > "$COUNTER_FILE"

# Warn at thresholds
if [[ $COUNT -eq 100 ]]; then
  cat <<'EOF'
📊 SESSION HEALTH: ~100 tool calls in this session.
Consider: Is this a good point to commit current work and start a fresh session for the next task?
Long sessions lose context quality as they approach compaction.
EOF
elif [[ $COUNT -eq 200 ]]; then
  cat <<'EOF'
⚠️ SESSION HEALTH: ~200 tool calls. Context compaction is likely soon.
Strongly recommend: commit all work now, document current state in workspace, start fresh.
EOF
elif [[ $COUNT -eq 300 ]]; then
  cat <<'EOF'
🚨 SESSION HEALTH: ~300 tool calls. You are deep into compaction territory.
Action: Stop new work. Commit everything. Update workspace docs with current state. Start a new session.
EOF
fi

exit 0
