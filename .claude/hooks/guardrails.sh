#!/bin/bash
# UserPromptSubmit hook — pattern-matches risky prompts before they reach
# the agent. Phase 0++.2.
#
# Behavior:
# - WARNs go to stderr with exit 0 (the prompt still flows through; the
#   user sees the warning attached to the agent's first response).
# - BLOCKs (currently none — see comment below) would exit 2 and the
#   prompt would never reach the agent.
#
# We deliberately do NOT block. Hard blocks at the prompt level are
# brittle — the matchers will mis-fire and the user will get frustrated.
# All the real enforcement (force-push, data-dir writes) is at the
# tool-call layer where the rule is unambiguous. This hook is a courtesy
# nudge that prepends helpful context to the conversation.

set -u

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null || echo "")

if [ -z "$PROMPT" ]; then
  exit 0
fi

# Lowercase copy for case-insensitive matching.
PROMPT_LC=$(echo "$PROMPT" | tr '[:upper:]' '[:lower:]')

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT" || exit 0
branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"

warnings=()

# --- Push to main warning ----------------------------------------------
# Heuristic: prompt mentions "push" AND (branch is main OR prompt mentions
# main/master explicitly). Force-push to main is already blocked at the
# Bash-tool layer; this is a heads-up before the agent even tries.
if echo "$PROMPT_LC" | grep -qE '\b(force[ -]?push|push --force|push -f)\b'; then
  warnings+=("⚠️ Prompt mentions force-push. The Bash-tool layer blocks force-push to main/master. Verify the branch in the command — main/master will refuse, feature branches are fine.")
elif echo "$PROMPT_LC" | grep -qE '\bpush\b'; then
  if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
    warnings+=("⚠️ You're on \`$branch\` and the prompt mentions push. Pushing directly to $branch is unusual — confirm a feature branch is intended (see CLAUDE.md branch convention).")
  elif echo "$PROMPT_LC" | grep -qE '\b(to|onto|into)\s+(main|master)\b'; then
    warnings+=("⚠️ Prompt mentions pushing to main/master. Direct push to main is unusual — confirm a feature branch + PR is the intended flow.")
  fi
fi

# --- Commit with empty staging area ------------------------------------
# Heuristic: prompt mentions "commit" AND `git diff --cached` is empty.
# In that case nudge toward the safe-commit skill, which stages the right
# files for the user.
if echo "$PROMPT_LC" | grep -qE '\bcommit\b'; then
  staged_count=$(git diff --cached --name-only 2>/dev/null | wc -l | tr -d ' ')
  if [ "$staged_count" = "0" ]; then
    warnings+=("ℹ️ Prompt mentions commit but nothing is staged. Try \`/safe-commit\` — it runs the typecheck/lint/test gauntlet, drafts the message, and confirms before committing.")
  fi
fi

# --- Data-dir mention --------------------------------------------------
# CLAUDE.md hard rule: never write to knowledge-base/, .vault/, .data/,
# .env*, *.db*. The tool-layer hook (block-data-dirs.sh) enforces this on
# every Edit/Write. This is a prompt-level heads-up so the agent doesn't
# even attempt edits there.
if echo "$PROMPT_LC" | grep -qE '(knowledge[- ]base|\.vault/|\.data/|\.env[a-z.]*|\.db[a-z.-]*)'; then
  warnings+=("⚠️ Prompt mentions a protected path (knowledge-base/, .vault/, .data/, .env*, *.db*). These dirs are read-only from the agent — Edit/Write tools will refuse. Use IPC handlers if you need to mutate user data.")
fi

if [ "${#warnings[@]}" -eq 0 ]; then
  exit 0
fi

# Emit the warnings as additionalContext so they ride along into the
# agent's first response surface, not just stderr. Same JSON-shaped
# response Claude Code expects from UserPromptSubmit hooks.
context=$(printf '## Guardrail notes\n\n%s\n' "$(printf '%s\n' "${warnings[@]}")")

if command -v jq >/dev/null 2>&1; then
  jq -n --arg ctx "$context" '{
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: $ctx
    }
  }'
else
  # Newline-escape fallback. Keep it simple — warnings are short.
  escaped=$(printf '%s' "$context" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e ':a;N;$!ba;s/\n/\\n/g')
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' "$escaped"
fi

exit 0
