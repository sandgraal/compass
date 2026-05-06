#!/bin/bash
# Compass Claude Code statusline.
# Reads JSON session metadata from stdin (Claude Code passes this).
# Outputs a compact status string showing: branch, git state, modified files, last test status.
#
# Configured in .claude/settings.json:
#   "statusLine": { "type": "command", "command": ".claude/statusline/compass-statusline.sh" }

set -e

# Read stdin JSON (Claude Code passes session metadata)
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.workspace.current_dir // .cwd // "."' 2>/dev/null || echo ".")
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "claude"' 2>/dev/null || echo "claude")

cd "$CWD" 2>/dev/null || true

# Branch + sync state
BRANCH=$(git branch --show-current 2>/dev/null || echo "—")
MODIFIED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
AHEAD=$(git rev-list --count "@{u}..HEAD" 2>/dev/null || echo "0")
BEHIND=$(git rev-list --count "HEAD..@{u}" 2>/dev/null || echo "0")

# Build the status line
PARTS=()

# Branch
if [ -n "$BRANCH" ] && [ "$BRANCH" != "—" ]; then
  PARTS+=("⎇ $BRANCH")
fi

# Modified files
if [ "$MODIFIED" -gt 0 ]; then
  PARTS+=("●$MODIFIED")
fi

# Ahead/behind
if [ "$AHEAD" -gt 0 ]; then
  PARTS+=("↑$AHEAD")
fi
if [ "$BEHIND" -gt 0 ]; then
  PARTS+=("↓$BEHIND")
fi

# Compass-specific: count integrations connected (if DB exists and we can read it)
DB_PATH="$HOME/Library/Application Support/Compass/.data/compass.db"
if [ -f "$DB_PATH" ] && command -v sqlite3 >/dev/null 2>&1; then
  CONNECTED=$(sqlite3 -readonly "$DB_PATH" "SELECT COUNT(*) FROM integrations WHERE status = 'connected'" 2>/dev/null || echo "")
  if [ -n "$CONNECTED" ] && [ "$CONNECTED" != "0" ]; then
    PARTS+=("🔌${CONNECTED}")
  fi
fi

# Model
PARTS+=("$MODEL")

# Join with " · "
printf '%s' "${PARTS[0]}"
for ((i=1; i<${#PARTS[@]}; i++)); do
  printf ' · %s' "${PARTS[i]}"
done
printf '\n'
