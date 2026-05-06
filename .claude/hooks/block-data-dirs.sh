#!/bin/bash
# Pre-Write/Edit hook: refuse to write to user data dirs or env files.
# These are gitignored AND already blocked by Lefthook/Husky pre-commit;
# this hook stops them BEFORE the agent writes them in the first place.

set -e

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Block-list patterns
BLOCKED_PATTERNS=(
  "knowledge-base/"
  ".vault/"
  ".data/"
  ".env"
  ".db"
  "oauth-tokens/"
)

for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if [[ "$FILE_PATH" == *"$pattern"* ]]; then
    echo "BLOCKED: $FILE_PATH matches sensitive pattern '$pattern'." >&2
    echo "These directories are user data — never write to them from the working tree." >&2
    exit 2  # exit code 2 → tell Claude to stop
  fi
done

exit 0
