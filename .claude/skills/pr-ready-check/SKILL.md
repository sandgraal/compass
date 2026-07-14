---
name: pr-ready-check
description: Polls a GitHub PR until CI is green, Copilot's automated review has actually landed for the current commit (plus a grace window for stragglers), and no review threads are unresolved — without ever merging it. Auto-loads when asked "is this PR ready to merge", "check PR status", after pushing a fix and wanting to confirm review is settled, or before considering a merge.
---

# PR ready check

## Why this exists

`gh pr merge --auto` merges the instant required CI checks pass. GitHub's
Copilot PR reviewer is asynchronous and can post comments *after* checks
already went green — auto-merge can beat it to the punch, landing code
with review findings nobody addressed. This skill replaces "merge as soon
as checks pass" with "confirm review has actually settled, then tell the
user — let them decide to merge."

**This skill (and the script it runs) never merges anything.** Not even
when everything is green. Report readiness; a human merges.

## Workflow

### 1. Run the poller

```bash
.claude/skills/pr-ready-check/check.sh <pr-number> [grace-seconds] [max-wait-seconds]
```

Defaults: 240s grace window after Copilot's review, 30 min overall cap.
Widen the grace window for PRs you expect a slower/heavier review on;
shorten it for trivial doc-only changes if you want a faster answer.

This blocks (with progress lines) until one of:
- **Exit 0 — READY**: checks green, Copilot reviewed the *current* head
  commit, the grace window since that review has elapsed with nothing new
  landing, and zero unresolved review threads remain.
- **Exit 1 — NOT READY**: prints the specific failing checks or unresolved
  thread paths. Fix those, push, and re-run (a new push resets the wait
  clock automatically since Copilot hasn't seen the new code yet).
- **Exit 2 — TIMEOUT**: no definite answer within `max-wait-seconds`
  (Copilot never reviewed, or checks never settled). Look at the PR
  manually — don't treat a timeout as "probably fine."

### 2. On NOT READY

Fix what's reported (failing check or unresolved thread), commit, push,
and re-invoke the script. Do not merge in this state under any
circumstances.

### 3. On READY

Report to the user: "PR #N is ready — CI green, Copilot's review settled
N minutes ago, no unresolved threads." **Then stop.** Do not run
`gh pr merge` yourself unless the user explicitly says to merge this PR
in this conversation. If they do, use a plain `gh pr merge --squash` (or
whatever method they specify) — never `--auto`, since `--auto` reintroduces
the exact race this skill exists to avoid.

### 4. On TIMEOUT

Report what's still outstanding (no Copilot review seen yet, or checks
still pending after the cap) and ask the user how they want to proceed —
wait longer, check manually, or merge anyway if they're confident the
repo's Copilot review just isn't going to fire (e.g. it's disabled for
this repo).

## Hard rules

- **Never merge automatically** — this skill's entire job is removing the
  incentive to reach for `--auto`, not adding a slower path to the same
  outcome.
- **A new push resets readiness.** Copilot hasn't reviewed the new commit
  yet; don't reuse a stale "ready" verdict after pushing more changes.
- **Unresolved ≠ unaddressed.** If you've pushed a fix for a comment,
  reply on the thread and resolve it (see the code-review PR workflow
  used elsewhere in this session: `gh api .../pulls/comments/{id}/replies`
  then the `resolveReviewThread` GraphQL mutation) before re-running the
  check — otherwise it'll correctly keep reporting NOT READY.
- **Timeouts are not green lights.** Exit 2 means "unknown," not "safe."
