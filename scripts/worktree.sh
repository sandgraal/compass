#!/bin/bash
# Worktree helper for parallel agent development.
#
# Usage:
#   scripts/worktree.sh new <branch>    # create worktree at .claude/worktrees/<sanitized> with branch <branch>
#   scripts/worktree.sh list             # list all worktrees
#   scripts/worktree.sh remove <branch>  # remove worktree + delete the branch (after merge)

set -euo pipefail

CMD="${1:-help}"
BRANCH="${2:-}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"

# Sanitize branch name for filesystem (replace / with -)
sanitize() {
  echo "$1" | tr '/' '-'
}

case "$CMD" in
  new)
    [ -z "$BRANCH" ] && { echo "usage: worktree.sh new <branch>"; exit 1; }

    SAFE_NAME="$(sanitize "$BRANCH")"
    WORKTREE_PATH="$WORKTREE_DIR/$SAFE_NAME"

    [ -d "$WORKTREE_PATH" ] && { echo "worktree already exists: $WORKTREE_PATH"; exit 1; }

    mkdir -p "$WORKTREE_DIR"

    # Branch off main; if branch already exists, just check it out
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git worktree add "$WORKTREE_PATH" "$BRANCH"
    else
      git worktree add -b "$BRANCH" "$WORKTREE_PATH" main
    fi

    echo ""
    echo "✓ Worktree ready: $WORKTREE_PATH"
    echo "  cd $WORKTREE_PATH"
    echo "  npm install   # if you need fresh node_modules"
    ;;

  list)
    git worktree list
    ;;

  remove)
    [ -z "$BRANCH" ] && { echo "usage: worktree.sh remove <branch>"; exit 1; }

    SAFE_NAME="$(sanitize "$BRANCH")"
    WORKTREE_PATH="$WORKTREE_DIR/$SAFE_NAME"

    if [ -d "$WORKTREE_PATH" ]; then
      git worktree remove "$WORKTREE_PATH" --force
    fi

    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git branch -D "$BRANCH" 2>/dev/null || echo "branch $BRANCH not deleted (may be unmerged)"
    fi

    echo "✓ Removed $WORKTREE_PATH"
    ;;

  help|*)
    echo "Compass worktree helper"
    echo ""
    echo "  scripts/worktree.sh new <branch>     Create a new worktree + branch"
    echo "  scripts/worktree.sh list             List all worktrees"
    echo "  scripts/worktree.sh remove <branch>  Remove a worktree + delete the branch"
    echo ""
    echo "Worktrees live at .claude/worktrees/<sanitized-branch-name>"
    ;;
esac
