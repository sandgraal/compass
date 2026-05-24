#!/usr/bin/env bash
# Publish wiki/*.md to the GitHub wiki repo.
# Prereq: create the first wiki page once via the GitHub UI (see PUBLISHING.md).
set -euo pipefail

REPO_WIKI="https://github.com/sandgraal/compass.wiki.git"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"

echo "Cloning wiki repo…"
if ! git clone "$REPO_WIKI" "$TMP" 2>/dev/null; then
  echo "ERROR: could not clone $REPO_WIKI"
  echo "The wiki must be initialized once via the GitHub web UI first."
  echo "See wiki/PUBLISHING.md."
  exit 1
fi

echo "Copying pages…"
cp "$SRC_DIR"/*.md "$TMP"/
# Don't publish the publishing instructions themselves.
rm -f "$TMP/PUBLISHING.md"

cd "$TMP"
git add -A
if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi
git commit -m "docs(wiki): sync Compass documentation"
git push
echo "Published. View at https://github.com/sandgraal/compass/wiki"
