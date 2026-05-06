#!/bin/bash
# Post-Edit/Write hook: when schema.ts changes, remind to regenerate migration.
# Doesn't auto-run npm (would hang the agent); just emits a reminder.

set -e

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

case "$FILE_PATH" in
  *electron/db/schema.ts|*electron/db/schema.finance.ts)
    echo "📝 schema.ts changed — remember to run \`npm run db:generate\` to create the migration." >&2
    ;;
  *electron/preload.ts)
    echo "📝 preload.ts changed — verify src/types/electron.d.ts has matching signatures." >&2
    ;;
esac

exit 0
