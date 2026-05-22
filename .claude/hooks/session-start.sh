#!/bin/bash
# SessionStart hook — emits a compact orientation summary into every new
# Claude Code session in this repo. Phase 0++.1.
#
# Output protocol: print a JSON object on stdout with
# hookSpecificOutput.additionalContext. Claude Code injects that string
# into the new session's system context. Hook failures must not block the
# session — every branch here is wrapped to default to "unknown" rather
# than exit non-zero.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 0

branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
last_commit="$(git log -1 --pretty='%h %s' 2>/dev/null || echo 'unknown')"
last_commit_date="$(git log -1 --pretty='%cr' 2>/dev/null || echo 'unknown')"

# Behind / ahead of origin/main — useful to know if the branch is stale.
ahead_behind="$(git rev-list --left-right --count origin/main...HEAD 2>/dev/null || echo '? ?')"
behind="$(echo "$ahead_behind" | awk '{print $1}')"
ahead="$(echo "$ahead_behind" | awk '{print $2}')"

# Working tree status — modified file count, not the full output.
dirty_count="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"

# Sync-queue + test-status hints come from the cached project-status.json
# if it's recent; we don't regenerate here to keep session-start fast.
status_json=".claude/project-status.json"
status_age_line=""
test_files_line=""
if [ -f "$status_json" ]; then
  # macOS-compatible mtime; GNU stat differs but both repos run on darwin.
  mtime_epoch="$(stat -f '%m' "$status_json" 2>/dev/null || stat -c '%Y' "$status_json" 2>/dev/null || echo 0)"
  if [ "$mtime_epoch" != "0" ]; then
    now_epoch="$(date +%s)"
    age_hours=$(( (now_epoch - mtime_epoch) / 3600 ))
    status_age_line="status.json: ${age_hours}h old"
  fi
  test_files=$(grep -o '"files":[[:space:]]*[0-9]*' "$status_json" 2>/dev/null | head -1 | grep -o '[0-9]*' || echo '?')
  test_files_line="${test_files} test files tracked"
fi

# Open PR count (best-effort; doesn't run if gh isn't logged in)
open_prs=""
if command -v gh >/dev/null 2>&1; then
  pr_count="$(gh pr list --state open --json number --jq 'length' 2>/dev/null || echo '?')"
  open_prs="${pr_count} open PR(s)"
fi

# Assemble the context block. Keep it terse — this lands in every session
# before the user's first message.
read -r -d '' context <<EOF || true
## Compass — session start snapshot

- **Branch:** \`${branch}\` · ${last_commit_date}
- **Last commit:** ${last_commit}
- **vs origin/main:** ${behind} behind, ${ahead} ahead · ${dirty_count} dirty file(s)
- **PRs:** ${open_prs:-(gh unavailable)}
- **Tests:** ${test_files_line:-(no status.json — run \`npm run status\`)}${status_age_line:+ · $status_age_line}

Pointers: \`docs/implementation_plan.md\` is the master plan. Run \`npm run status\` to refresh the snapshot. Auto-loaded skills cover most common workflows — see CLAUDE.md.
EOF

# Emit the structured hook response. jq is the safe way to escape into
# JSON; if jq is missing we fall back to a best-effort sed escape so the
# hook never wedges the session.
if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$context" '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $ctx
    }
  }'
else
  # Fallback: escape newlines + quotes by hand.
  escaped=$(printf '%s' "$context" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g')
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$escaped"
fi

exit 0
