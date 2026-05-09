---
'compass': minor
---

Phase 2.7 — Knowledge "Suggest edit" (regex baseline)

Adds a non-destructive, pattern-based layer on top of the existing knowledge auto-updater.
After each Gmail or GitHub sync, Compass analyses synced data and proposes additions to
user-owned knowledge files (profile/relationships.md, work/employers.md). Users review
proposals in a new side panel inside the Knowledge Base page and can Accept or Dismiss
each one individually.

- New DB table `knowledge_suggestions` with idempotent insertion
- Three deterministic regex/string extractors (no AI required):
  - Contacts from Gmail senders (display name seen >= 2 times in 30 days)
  - Org names from Gmail domains (domain seen >= 3 times, non-free-mail)
  - Contacts from GitHub assignees / authors
- Three new IPC handlers: `knowledge:list-suggestions`, `knowledge:accept-suggestion`,
  `knowledge:dismiss-suggestion` — all with path-traversal protection and an allowlist
  of writable target paths
- "Suggestions" toolbar button with badge count when pending suggestions exist for the
  current file; side panel shows proposed markdown snippet, source badge, and context
