#!/usr/bin/env bash
#
# pr-ready-check — polls a GitHub PR until it's actually safe to merge:
# CI checks green, Copilot's automated review has landed AND a grace
# window has passed since (catching straggler comments), and no
# unresolved review threads remain.
#
# This script NEVER merges anything. It only reports readiness. Exit
# codes:
#   0 = ready to merge (report to user; a human decides to merge)
#   1 = not ready (failing checks or unresolved threads — details printed)
#   2 = timed out before reaching a definite answer — needs a manual look
#
# Usage: check.sh <pr-number> [grace-seconds] [max-wait-seconds]
#   grace-seconds   default 240 (4 min) — idle time required after
#                   Copilot's last review before considering it settled
#   max-wait-seconds default 1800 (30 min) — overall cap before giving up

set -euo pipefail

PR="${1:?Usage: check.sh <pr-number> [grace-seconds] [max-wait-seconds]}"
GRACE_SECONDS="${2:-240}"
MAX_WAIT="${3:-1800}"
POLL_INTERVAL=15
COPILOT_LOGIN="copilot-pull-request-reviewer[bot]"

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${REPO%/*}"
NAME="${REPO#*/}"

echo "Watching ${REPO}#${PR} (grace=${GRACE_SECONDS}s, max-wait=${MAX_WAIT}s)"

to_epoch() {
  # Portable ISO-8601 (UTC, trailing Z) -> epoch. GNU `date -d` is
  # timezone-aware and handles the `Z` correctly on its own. BSD/macOS
  # `date -j -f` does NOT infer UTC from a literal `Z` in the format string —
  # without `-u` it silently parses the fields as local time, corrupting the
  # result by the local UTC offset (caught live: produced a review timestamp
  # in the future, which read as a negative "reviewed Ns ago").
  date -d "$1" +%s 2>/dev/null || date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$1" +%s
}

start=$(date +%s)
last_head_sha="$(gh pr view "$PR" --json headRefOid -q .headRefOid)"

while true; do
  now=$(date +%s)
  elapsed=$((now - start))
  if [ "$elapsed" -gt "$MAX_WAIT" ]; then
    echo "TIMEOUT after ${MAX_WAIT}s — no definite answer. Check manually."
    exit 2
  fi

  # A new push means new code that Copilot hasn't seen yet — restart the clock.
  cur_sha="$(gh pr view "$PR" --json headRefOid -q .headRefOid)"
  if [ "$cur_sha" != "$last_head_sha" ]; then
    echo "[${elapsed}s] New commit pushed (${cur_sha}) — resetting wait clock."
    last_head_sha="$cur_sha"
    start=$now
    continue
  fi

  # 1. CI checks: any failure is an immediate NOT READY; any pending, keep waiting.
  #    A `gh` failure (auth/network) is NOT the same as "no checks configured" —
  #    conflating them by falling back to `[]` would let a fetch error look
  #    identical to "all green," which is exactly the false-READY this script
  #    exists to prevent. Only a genuine "no checks reported" response counts
  #    as zero checks; anything else is retried, never assumed green.
  checks_exit=0
  checks_output="$(gh pr checks "$PR" --json name,state,bucket 2>&1)" || checks_exit=$?
  if [ "$checks_exit" -ne 0 ]; then
    if echo "$checks_output" | grep -qi "no checks reported"; then
      checks_json='[]'
    else
      echo "[${elapsed}s] Couldn't fetch check status (gh exit ${checks_exit}): ${checks_output}"
      echo "[${elapsed}s] Treating as unknown — retrying, not assuming green."
      sleep "$POLL_INTERVAL"
      continue
    fi
  else
    checks_json="$checks_output"
  fi
  failing="$(echo "$checks_json" | jq '[.[] | select(.bucket=="fail")] | length')"
  pending="$(echo "$checks_json" | jq '[.[] | select(.bucket=="pending")] | length')"

  if [ "$failing" -gt 0 ]; then
    echo "NOT READY — failing checks:"
    echo "$checks_json" | jq -r '.[] | select(.bucket=="fail") | "  - " + .name'
    exit 1
  fi
  if [ "$pending" -gt 0 ]; then
    echo "[${elapsed}s] ${pending} check(s) still pending — waiting..."
    sleep "$POLL_INTERVAL"
    continue
  fi

  # 2. Has Copilot's review landed for THIS head commit?
  copilot_review_at="$(gh api "repos/${OWNER}/${NAME}/pulls/${PR}/reviews" --paginate \
    --jq "[.[] | select(.user.login==\"${COPILOT_LOGIN}\") | select(.commit_id==\"${cur_sha}\")] | last | .submitted_at // empty" \
    2>/dev/null || true)"

  if [ -z "$copilot_review_at" ]; then
    echo "[${elapsed}s] Waiting for Copilot's review of ${cur_sha}..."
    sleep "$POLL_INTERVAL"
    continue
  fi

  # 3. Grace window since that review, to catch late/straggler comments.
  review_epoch="$(to_epoch "$copilot_review_at")"
  since_review=$(( $(date +%s) - review_epoch ))
  if [ "$since_review" -lt "$GRACE_SECONDS" ]; then
    remaining=$((GRACE_SECONDS - since_review))
    echo "[${elapsed}s] Copilot reviewed ${since_review}s ago — waiting ${remaining}s more for stragglers..."
    sleep "$POLL_INTERVAL"
    continue
  fi

  # 4. Any unresolved review threads left? `--paginate` walks every page via
  #    $endCursor/pageInfo (verified live against a real >100-threads-forcing
  #    page size) so a PR with more than 100 threads can't hide an unresolved
  #    one past the first page. A fetch failure is retried, never treated as
  #    "zero unresolved" — same fail-safe principle as the checks fetch above.
  threads_exit=0
  unresolved_paths="$(gh api graphql --paginate -f query='
    query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String) {
      repository(owner:$owner,name:$repo){
        pullRequest(number:$pr){
          reviewThreads(first:100, after:$endCursor){
            pageInfo { hasNextPage endCursor }
            nodes { isResolved path }
          }
        }
      }
    }' -F owner="$OWNER" -F repo="$NAME" -F pr="$PR" \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved==false) | .path' \
    2>&1)" || threads_exit=$?

  if [ "$threads_exit" -ne 0 ]; then
    echo "[${elapsed}s] Couldn't fetch review threads (gh exit ${threads_exit}): ${unresolved_paths}"
    echo "[${elapsed}s] Treating as unknown — retrying, not assuming clean."
    sleep "$POLL_INTERVAL"
    continue
  fi

  unresolved_count=0
  if [ -n "$unresolved_paths" ]; then
    unresolved_count="$(printf '%s\n' "$unresolved_paths" | grep -c . || true)"
  fi

  if [ "$unresolved_count" -gt 0 ]; then
    echo "NOT READY — ${unresolved_count} unresolved review thread(s):"
    printf '%s\n' "$unresolved_paths" | sed 's/^/  - /'
    exit 1
  fi

  echo "READY — checks green, Copilot reviewed ${since_review}s ago (grace elapsed), no unresolved threads."
  echo "This script does not merge. A human decides to merge."
  exit 0
done
