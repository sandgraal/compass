#!/bin/bash
# Pre-Bash hook: block force-push to main / master.
# Force-pushes to other branches are fine.

set -e

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Block git push --force or -f to main/master
if echo "$COMMAND" | grep -qE 'git\s+push.*(-f|--force|--force-with-lease).*\b(main|master)\b'; then
  echo "BLOCKED: force-push to main/master is not allowed." >&2
  echo "If this is truly necessary, run it yourself outside the agent." >&2
  exit 2
fi

# Also block force-push when origin/HEAD is main/master
if echo "$COMMAND" | grep -qE 'git\s+push.*(-f|--force|--force-with-lease)' && \
   echo "$COMMAND" | grep -qE '\borigin\b' && \
   ! echo "$COMMAND" | grep -qE '\b(feat|fix|chore|docs|refactor|test)/'; then
  echo "BLOCKED: force-push without a feature branch suffix." >&2
  echo "Make sure you're on a feat/fix/chore branch, not main." >&2
  exit 2
fi

exit 0
