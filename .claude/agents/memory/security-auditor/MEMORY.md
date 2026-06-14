# Security auditor memory

> Persistent project memory for the `security-auditor` subagent. Phase 0++.5.
> The agent reads this file at the start of every run and appends new entries at the end of every run.

## How to use this file

- **At start:** Skim every section. Carry context forward — past findings, accepted risks, known-safe patterns.
- **At end:** Append a dated entry under "Run log". If a finding from a prior run was resolved, edit the original entry inline (don't delete — strike through with `~~text~~` so the audit trail survives).
- **Retention:** Keep this file focused on active context. When the run log reaches a new calendar year, move prior-year run-log entries to `ARCHIVE.md` in this directory (grouped by year) and leave a one-line pointer.
- **Never store secrets, tokens, or PII here.** This file lives in the repo (`.claude/agents/memory/`) — treat it as public.

## Accepted risks (do not re-flag)

> Findings the user has explicitly acknowledged as out-of-scope or accepted. Cite the run that established each.

_(empty — no accepted risks yet)_

## Known-safe patterns

> Patterns that look concerning but are intentional. Examples: a `// @ts-ignore` on a Node↔Electron stub, a SQL string concatenation that's actually a column name from a closed allowlist.

- **`contacts:list` LIKE with user search string (run 2026-06-14):** Drizzle's `like()` passes the pattern as a bound parameter to better-sqlite3, so the `%${q}%` interpolation does NOT create SQL injection. The risk is a performance-only full-table scan — not a correctness/security issue.
- **`listMarkdown` symlink following (run 2026-06-14):** `statSync` follows symlinks by default, but the `.endsWith('.md')` filter means vault `.enc` files can never be copied even if a symlink inside `KNOWLEDGE_DIR` pointed at `VAULT_DIR`. Symlink attacks that target arbitrary `.md` files outside the app require the user to plant the symlink in their own knowledge dir — outside the threat model.
- **`copyKnowledgeInto` `relative()` output (run 2026-06-14):** `listMarkdown` only yields paths built by `join(KNOWLEDGE_DIR, …)` starting from a directory walk rooted at `KNOWLEDGE_DIR`. All `src` values passed to `relative(KNOWLEDGE_DIR, src)` are within `KNOWLEDGE_DIR` (absent symlinks addressed above), so the `dest` path stays within `destDir`.
- **`contacts:export-vcard/csv` renderer-supplied `ids` array (run 2026-06-14):** The `ids` array controls only which already-fetched DB rows are filtered in memory via `Array.includes`. A renderer supplying non-integer or bogus values simply causes the filter to match nothing — it cannot trigger path traversal, SQL injection, or vault access. This is not a security defect.
- **`vCard PHOTO` with arbitrary `data:` MIME type (run 2026-06-14):** Stored as a plain string in SQLite. The renderer currently renders no `<img>` from this field; `rowToRecord(..., false)` omits it from list payloads, and `contacts:get` returns it only on direct lookup. Even if rendered as `<img src=...>` in future, `data:text/html` in an `<img src>` is displayed as a broken image by Electron's Chromium, not executed as HTML.

## Recurring issues

> Findings that keep coming back. If the same regression appears in multiple PRs, write a note about *why* (lint rule missing, no test, easy to forget).

- **No file-size cap before `readFileSync` on user-picked files (run 2026-06-14):** Both `contacts:import-vcard` (with `multiSelections`) and `contacts:import-csv` call `readFileSync` without checking file size first. A user who picks a multi-GB file will OOM the main process. This pattern is likely to recur as new importers are added. Fix: add `statSync` size check (e.g. 50 MB limit) before reading. Track as a low-severity recurring pattern.

## Threat-model deltas

> Changes to the threat model itself: new attack surface (e.g., new MCP server, new IPC channel), retired surface (e.g., `development` Plaid env), or new mitigations (e.g., CSP tightening).

- **Phase 9 "Storehouse" export surface (2026-06-14):** New IPC channels `calendar:export-ics`, `finance:export-transactions-csv`, `knowledge:export-folder`, `export:export-all`, plus the full `contacts:` CRUD namespace. All export destinations are chosen by the OS native dialog — no renderer-supplied paths. The vault is explicitly excluded from all export paths. New attack surface to track in future audits: the `contacts:import-vcard` `multiSelections` path (multiple large files), and the `vCard PHOTO` data-URI storage path.

## Run log

> One entry per audit run. Date · scope · top findings · status.

### 2026-06-14 — Phase 9 "Storehouse" Wave 1 (contacts + export)

**Scope:** `electron/ipc/export.ts`, `electron/ipc/contacts.ts`, `electron/lib/vcard.ts`, `electron/lib/ics.ts`, `electron/lib/csv.ts`, `electron/knowledge/contacts-extractor.ts`, `electron/preload.ts` (contacts: and exporter: namespaces)

**Top findings:**
1. (medium) `contacts:import-vcard` + `contacts:import-csv` call `readFileSync` without a file-size check; a multi-GB file will OOM the main process. `multiSelections` on vCard import compounds this.
2. (low) `contacts:list` search string has no length bound before passing to drizzle `like()`. Not SQL-injectable (parameterized), but an unbounded string causes a full-table scan. Low risk given local-only deployment.
3. (low) `vCard PHOTO` parser accepts any `data:` URI MIME type without restriction. Stored as a string; not currently rendered in the UI. Risk is low but worth sanitizing to `data:image/…` only at parse time.

**Status: advisory** (no blockers; no vault leakage; all writes go through native OS dialog)
