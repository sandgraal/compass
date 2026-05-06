#!/bin/bash
# Pre-Edit/Write hook: warn (but allow) edits to high-impact files.
# These files SHOULD be edited carefully; warning surfaces this so the agent
# can decide whether to delegate to security-auditor afterwards.

set -e

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

SENSITIVE_FILES=(
  "electron/ipc/vault.ts"
  "electron/ipc/auth.ts"
  "electron/db/schema.ts"
  "electron/db/schema.finance.ts"
  "electron/main.ts"
  "electron/preload.ts"
  "src/types/electron.d.ts"
)

for sensitive in "${SENSITIVE_FILES[@]}"; do
  if [[ "$FILE_PATH" == *"$sensitive" ]]; then
    echo "⚠️  Editing security-sensitive file: $sensitive" >&2
    echo "   After this change, consider invoking the security-auditor subagent." >&2
    exit 0  # exit 0 = allow with stderr warning
  fi
done

exit 0
