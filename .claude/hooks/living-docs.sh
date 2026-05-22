#!/bin/bash
# PostToolUse hook — when an API-surface file changes, prompt the agent to
# run the docs-keeper subagent so docs/ don't drift. Phase 0++.3
# (supersedes the 0+.6 placeholder).
#
# The three files below own Compass's API surface: the DB schema, the
# IPC bridge, and the renderer-facing type definitions. When any of them
# changes, docs/architecture.md (IPC map + schema overview) and
# docs/implementation_plan.md almost always need a follow-up edit — and
# they're the docs that rot first.
#
# A shell hook can't spawn a subagent directly, so this emits an
# additionalContext nudge instructing the agent to invoke docs-keeper
# before wrapping up. It's advisory: exit 0 always, never blocks the edit.

set -u

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

surface=""
case "$FILE_PATH" in
  *electron/db/schema.ts|*electron/db/schema.finance.ts)
    surface="DB schema (electron/db/schema*.ts)" ;;
  *electron/preload.ts)
    surface="IPC bridge (electron/preload.ts)" ;;
  *src/types/electron.d.ts)
    surface="renderer API types (src/types/electron.d.ts)" ;;
esac

if [ -z "$surface" ]; then
  exit 0
fi

context="📚 Living-docs check: you edited the ${surface}. This is part of Compass's API surface — docs/architecture.md (IPC map + schema overview) and docs/implementation_plan.md commonly drift when it changes. Before you wrap up this task, run the \`docs-keeper\` subagent to reconcile the docs with the new surface. If the edit was cosmetic (rename, comment, formatting) and the documented API is unchanged, you may skip it — say so explicitly."

if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$context" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $ctx
    }
  }'
else
  # Fallback: emit to stderr so the nudge is never silently lost.
  echo "$context" >&2
fi

exit 0
