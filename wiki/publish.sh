#!/usr/bin/env bash
# Publish wiki/*.md to the GitHub wiki repo.
# Prereq: create the first wiki page once via the GitHub UI (see PUBLISHING.md).
set -euo pipefail

REPO_WIKI="https://github.com/sandgraal/compass.wiki.git"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
# Always clean up the temp clone, on success or failure.
trap 'rm -rf "$TMP"' EXIT

echo "Cloning wiki repo…"
if ! git clone "$REPO_WIKI" "$TMP" 2>/dev/null; then
  echo "ERROR: could not clone $REPO_WIKI"
  echo "The wiki must be initialized once via the GitHub web UI first."
  echo "See wiki/PUBLISHING.md."
  exit 1
fi

echo "Syncing pages…"
# Mirror the source: drop the wiki's existing pages first so renames/deletions
# in wiki/ propagate (a plain copy would leave orphaned pages behind).
find "$TMP" -maxdepth 1 -name '*.md' -delete
cp "$SRC_DIR"/*.md "$TMP"/
# Don't publish the publishing instructions themselves.
rm -f "$TMP/PUBLISHING.md"

cd "$TMP"
git add -A
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi
# Ensure a commit identity exists even on a clean machine / CI shell.
if ! git config user.email >/dev/null 2>&1; then
  git config user.email "noreply@github.com"
  git config user.name "Compass wiki publisher"
fi
git commit -m "docs(wiki): sync Compass documentation"
git push
echo "Published. View at https://github.com/sandgraal/compass/wiki"
