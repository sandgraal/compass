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
- **`electron/ipc/backup.ts` `restoreAllTablesRaw` bundle-driven table/column identifiers interpolated into `DELETE`/`PRAGMA`/`INSERT` strings (run 2026-07-11, v3 "allTables" backup):** Table names come from `Object.keys(bundle.allTables)` (attacker-controlled) but are gated by `existing.has(name)` where `existing` is read live from THIS machine's `sqlite_master` before the loop — an attacker can only select an identifier that already equals a real table name, never inject one. Column names are similarly intersected against `PRAGMA table_info("<already-validated-name>")` before being embedded in the `INSERT` column list. All row *values* are bound as `?` params. This is the same "closed allowlist sourced from the live schema, not the bundle" shape as the `contacts:list` LIKE-pattern pattern above — safe, not injectable. Re-verify this reasoning if `restoreAllTablesRaw` is ever refactored to build the `existing`/`destCols` sets from anything other than a fresh `sqlite_master`/`PRAGMA table_info` read.

## Recurring issues

> Findings that keep coming back. If the same regression appears in multiple PRs, write a note about *why* (lint rule missing, no test, easy to forget).

- **File-size cap before `readFileSync` on user-picked files — RESOLVED in PR #176 (run 2026-06-14):** `contacts:import-vcard` (incl. `multiSelections`) and `contacts:import-csv` now `statSync(...).size > MAX_IMPORT_BYTES` (50 MB) before reading and bail out otherwise. Keep the pattern in mind for *future* importers (Google Contacts / archive importers in Wave 1.1+): every new `readFileSync` on a user-picked file should size-check first.
  - **Still OUTSTANDING in `electron/ipc/backup.ts` `backup:restore` (flagged 2026-07-11, `feat/encrypted-backup`):** `readFileSync(filePaths[0])` (line ~674) has no size cap before AES-GCM decrypt (`decryptBundle`, full-buffer `decipher.update`/`.final()` at line ~275) and `JSON.parse`. Notably this doesn't even require the correct passphrase to trigger the memory/CPU cost — only correct magic+version header bytes. Pre-existing gap (not introduced by the v3 diff), but the v3 "every table + documents store" bundle format makes legitimate backups (and therefore the plausible ceiling an attacker can hide behind) much larger, raising the severity. Recommend a `statSync` ceiling (e.g. a few GB) before `readFileSync` in `backup:restore`, mirroring the `contacts:import-*` pattern. Re-check on next backup.ts touch.
- **Pattern to watch (first seen 2026-07-11, feat/device-sync):** any value that is (a) derived from a user secret AND (b) exposed to an untrusted party (relay operator, network path, URL, log line) MUST use the same slow/memory-hard KDF as the thing it's meant to protect — never a fast hash. A fast hash on the "public identifier" half of a passphrase-derived pair turns an offline scrypt/argon2 attack into a cheap SHA-256 dictionary attack on the passphrase itself, silently defeating the KDF used on the "secret" half. Check for this pattern any time a new pairing/sync/sharing feature derives a public routing id from a user-supplied secret.

## Threat-model deltas

> Changes to the threat model itself: new attack surface (e.g., new MCP server, new IPC channel), retired surface (e.g., `development` Plaid env), or new mitigations (e.g., CSP tightening).

- **Phase 9 "Storehouse" export surface (2026-06-14):** New IPC channels `calendar:export-ics`, `finance:export-transactions-csv`, `knowledge:export-folder`, `export:export-all`, plus the full `contacts:` CRUD namespace. All export destinations are chosen by the OS native dialog — no renderer-supplied paths. The vault is explicitly excluded from all export paths. New attack surface to track in future audits: the `contacts:import-vcard` `multiSelections` path (multiple large files), and the `vCard PHOTO` data-URI storage path.
- **Phase 4b "Device sync" — first feature that egresses the whole dataset off-device (2026-07-11, `feat/device-sync`, uncommitted):** New relay surface `relay/src/sync.ts` (`/sync/blob/<groupId>`, `/sync/meta/<groupId>`, opt-in via `RELAY_SYNC_DIR`, same bearer gate as the aggregator proxy but with NO per-token group ownership — any allowlisted token can PUT/GET any groupId, documented as an accepted structural tradeoff). New IPC namespace `device-sync:*` (`electron/ipc/device-sync.ts`, `electron/integrations/device-sync.ts`) reuses the audited backup façade (`buildEncryptedSnapshot`/`restoreEncryptedSnapshot` over `collectBundle`/`encryptBundle`/`applyRestore` in `electron/ipc/backup.ts`) so a push/pull is byte-for-byte the same v3 `.compass-backup` bundle (incl. vault blobs + plaintext `masterKeyHex` inside the passphrase-encrypted payload — that inclusion itself was accepted in the 4a backup review). ~~Not yet resolved as of the first pass: the sync group id was `sha256(passphrase)`~~ — **fixed same-day**: `syncGroupId` now uses scrypt at the same cost parameters as the blob KDF (fixed public-context salt), passphrase floor raised to 12 for sync specifically. See run log for full resolution detail. Track this surface in future audits for drift (e.g. someone "simplifying" the groupId derivation back to a fast hash).

## Run log

> One entry per audit run. Date · scope · top findings · status.

### 2026-07-11 — encrypted backup/restore goes "v3 all-tables" (branch `feat/encrypted-backup`, uncommitted diff)

**Scope:** `electron/ipc/backup.ts` only (per request), read-context from `electron/ipc/documents.ts`, `electron/db/client.ts`, `electron/db/schema.ts`, `electron/ipc/auth.ts`, `electron/paths.ts`, `docs/data-access-policy.md`, `electron/ipc/backup-handlers.test.ts`.

**Top findings:**
1. (medium, advisory) No size cap before `readFileSync(filePaths[0])` on the user-picked restore file (`backup.ts:674`) or on the full-buffer AES-GCM decrypt (`backup.ts:275`) — pre-existing gap, but v3's "every table + documents store" bundle makes the realistic blast radius (and the size an attacker can hide behind) much bigger. Matches the recurring "size-cap before readFileSync on user-picked files" pattern above — not yet applied here.
2. (low, advisory) No unit test exercises path-traversal rejection for the new `documentsFiles` restore stage (`backup.ts:615-619`) — the vault/knowledge stages have this coverage (`backup-handlers.test.ts:234-247`), documents doesn't, even though the code shape is identical.
3. (low, advisory) The file header (`backup.ts:1-37`) and the `applyRestore` staging doc (`backup.ts:303-322`) still describe only the v2 shape — not updated for `allTables`/`documentsFiles`/v3. Since this agent's own instructions say "read the header comment for intended invariants," a stale header is a minor trust hazard for future audits.

**Verified safe (no regressions):** table/column identifiers in `restoreAllTablesRaw` are double-whitelisted against the live destination `sqlite_master`/`PRAGMA table_info` before SQL interpolation (attacker's bundle can't introduce a new identifier, only select among real ones) — see new Known-safe-patterns entry above. `documentsFiles`/vault/knowledge restore all reject `/`, `\`, `..` before any `fs` write and stay under their `*_DIR`. The `restoreAllTablesRaw` DELETE+INSERT run inside one `sqlite.transaction()`, so a throw anywhere (bad row shape, type mismatch, deferred-FK violation at commit) rolls back the whole DB restore before any Stage-4 filesystem write — the documented "DB commits before FS writes" invariant holds and now correctly covers the new documents stage too. Grepped `schema.ts` for token/secret/password/credential columns — confirmed no plaintext secrets live in any newly-included table; real secrets (OAuth tokens, Plaid `access_token`, SimpleFIN Access URL) stay in separate `safeStorage`-encrypted files outside `allTables`/`documentsFiles`/`vault` entirely, untouched by this diff. `masterKeyHex` handling, scrypt+AES-256-GCM crypto layer, and "master key never returned to renderer" are all unchanged.

**Status: advisory** (no blockers — safe to merge; recommend the size-cap fix (#1) land this sprint given it directly matches Compass's named "billion-row blowup" threat-model item)
### 2026-07-11 — Phase 4b device sync (uncommitted diff, branch `feat/device-sync`, worktree `data-silos-access-02fd1c`)

**Scope:** `relay/src/sync.ts` + `relay/src/sync.test.ts` (new), `electron/integrations/device-sync.ts` + `.test.ts` (new), `electron/ipc/device-sync.ts` (new), `electron/ipc/backup.ts` (new `buildEncryptedSnapshot`/`restoreEncryptedSnapshot` façade), `electron/main.ts`, `electron/preload.ts`, `relay/README.md`, `relay/src/index.ts`, `relay/src/server.ts`, `src/pages/Settings.tsx`, `src/types/electron.d.ts`.

**Top findings:**
1. **(high, must-fix)** `syncGroupId()` (`electron/integrations/device-sync.ts:49`) is a bare `sha256('compass-device-sync:' + passphrase)`, but the group id travels in the `/sync/blob/<groupId>` URL path — visible to the relay operator and any network intermediary. Because SHA-256 is orders of magnitude cheaper than the scrypt (N=2^15) used to derive the actual blob key, an attacker who learns a user's groupId can brute-force the *passphrase itself* through the fast hash, sidestepping the scrypt protection entirely — then trivially derive the real key and decrypt the full snapshot (vault + plaintext `masterKeyHex`). Current 8-char passphrase floor makes this practical, not theoretical. Fix: derive groupId via a slow/memory-hard KDF with a fixed public salt/context (distinct from the blob's per-blob random salt), or decouple the group id from the passphrase entirely (out-of-band pairing code) and/or raise the passphrase floor + add a strength meter.
2. **(medium, should-fix)** `pullSnapshot()` (`electron/integrations/device-sync.ts:215-223`) has no client-side cap on the downloaded blob — `res.json()` buffers an unbounded body from whatever `relayUrl` points at (user-configurable). A malicious/misconfigured relay can OOM the Electron main process on pull. Mirror `MAX_RESTORE_BYTES` from `electron/ipc/backup.ts`.
3. **(low, note/document)** `relay/src/sync.ts` has no per-token groupId ownership — any operator-allowlisted bearer can PUT/GET any group's mailbox (structural: pairing requires two *different* device tokens to reach the same group, so this can't be trivially fixed without a separate pairing/auth step). Combined with #1 this is an availability (griefing) risk, not confidentiality. Recommend documenting explicitly in `relay/README.md`, not a code fix for this PR.

**Verified safe:** AES-256-GCM + verified authTag in the reused backup crypto (unchanged); no plaintext secrets ever returned to renderer via `deviceSync.*` IPC; passphrase-at-rest reuses the standard `writeEncryptedJson`/`safeStorage` vault primitive (no new crypto surface); no cross-group passphrase adoption (groupId always derived from the *locally configured* passphrase, never trusted from the remote); relay path traversal blocked by `GROUP_ID_RE`; relay decode-size cap enforced + isolated to `/sync/*` only; no cron/scheduled auto-push anywhere in the diff — every egress is a user-initiated button click with the destination `relayUrl` shown and a destructive-confirm dialog on pull.

~~**Status: blocker** (finding #1 must be fixed before this ships — it defeats the E2E-encryption premise of the feature for realistic passphrases)~~

**RESOLVED same-day (2026-07-11, re-review of the coordinator's fix-up, still uncommitted):**
1. `syncGroupId()` now `scryptSync(passphrase, 'compass-device-sync-groupid-v1', 16, {N:1<<15, r:8, p:1, maxmem:128MB})` — cost parameters verified byte-identical to the blob KDF (`deriveKey` in `electron/ipc/backup.ts:131-138`), so the URL-visible groupId no longer offers a cheap oracle. Passphrase floor raised 8→12 in `configureDeviceSync` (`electron/integrations/device-sync.ts:133`) and the Settings UI guard/placeholder/disabled-state (confirmed the pre-existing 8-char floor at `src/pages/Settings.tsx:770,801` is the *unrelated* local-file `BackupRow`, correctly left alone). Docstrings corrected in both files. **Closed.**
2. `pullSnapshot()` now checks `content-length` before buffering and re-checks the buffered text length before `JSON.parse`/base64-decode, capped at `MAX_PULL_BODY_BYTES` (1 GB) (`electron/integrations/device-sync.ts:246-256`). **Closed for the blob-download path.** Residual, non-blocking: `checkRemote`'s `res.json()` on `/sync/meta/` (`:185`) and `pushSnapshot`'s error-branch `res.json()` (`:210`) still read an unbounded body from the same untrusted `relayUrl` before any size check — lower severity since neither feeds decrypt/restore; fold in if this file is touched again.
3. Documented (not code-fixed, as intended): `relay/README.md:65-69` "Sync auth caveat" + `relay/src/sync.ts:18-21` header now state any-token-any-group plainly plus operator guidance to scope `RELAY_CLIENT_TOKENS`. **Closed.**

Verified independently (not just taken on the coordinator's word): scrypt cost-parameter match confirmed by direct diff against `backup.ts`; 21/21 tests pass (`npx vitest run electron/integrations/device-sync.test.ts relay/src/sync.test.ts`); `tsc --noEmit` and `biome check` clean on all touched files.

**Final status: clean — safe to merge** (the one residual noted in #2 above is a non-blocking follow-up, not a re-open of any of the three original findings)

### 2026-07-03 — Oura Personal Access Token integration + habit auto-link (uncommitted diff, worktree `optimistic-feynman-c1558b`)

**Scope:** `electron/ipc/auth.ts` (`auth:connect-oura`), `electron/integrations/oura.ts` (`syncOura`, `applyOuraHabitAutoLinks`), `electron/lib/habit-autolink.ts`, `electron/ipc/habits.ts` (`habits:update` widened), `electron/main.ts` CSP, `electron/db/schema.ts` + migrations `0027`/`0028` + `client.ts` fallback tables, `electron/lib/storehouse-projectors.ts` (`projectOuraMetrics`), `electron/knowledge/extractor.ts` (`updateOuraKnowledge`), `src/pages/Integrations.tsx`, `src/lib/integration-registry.ts`, `electron/preload.ts`, `src/types/electron.d.ts`.

**Findings: none.** `auth:connect-oura` is a structural match to `auth:connect-todoist` (length-bound-before-trim/regex, real-endpoint probe against `/v2/usercollection/personal_info` with 401/403 handling, `saveToken` — `safeStorage`-encrypted — before returning `{ success: true }` with no token field ever in the IPC response). Token never logged (`oura.ts`'s only `console.warn` logs the habit-autolink error object, not the token/response). CSP gained exactly `https://api.ouraring.com` in `connect-src`, no other directive touched, no wildcard. Renderer form uses `type="password"`, no client-side gating beyond an empty-string check, clears `ouraTokenInput` to `null` immediately on success. `oura_daily_metrics` is aggregate-only (day-level scores/steps, no raw biometric series), added correctly to BOTH migration `0027` and the `ensureNewTables`/`createTablesIfNeeded` fallback (per the `migrations_bundled_in_asar` pattern from prior sessions). `updateOuraKnowledge` writes only aggregate scores to `knowledge-base/health/oura-summary.md`, matching the pre-existing GitHub-summary knowledge-file pattern — no token, no new export path. `habits:update`/`habits:toggle` widening (`autoLinkSource`/`autoLinkThreshold`/`source` columns) uses Drizzle's typed `.set(updates)` — no raw string interpolation, no path arguments, doesn't touch vault/finance AI-boundary tables at all (habits/habit_entries only).

**Status: clean** (no blockers, no advisories — this diff faithfully followed the established Todoist/Linear/GitHub-PAT precedent with zero deviations found)

### 2026-06-14 — Phase 9 "Storehouse" Wave 1 (contacts + export)

**Scope:** `electron/ipc/export.ts`, `electron/ipc/contacts.ts`, `electron/lib/vcard.ts`, `electron/lib/ics.ts`, `electron/lib/csv.ts`, `electron/knowledge/contacts-extractor.ts`, `electron/preload.ts` (contacts: and exporter: namespaces)

**Top findings (all ADDRESSED in PR #176 before merge):**
1. (medium) `contacts:import-vcard` + `contacts:import-csv` `readFileSync` without a file-size check → multi-GB OOM. **Fixed:** `statSync` 50 MB (`MAX_IMPORT_BYTES`) guard before read.
2. (low) `contacts:list` search string had no length bound before drizzle `like()` (parameterized → not injectable, just a full-table scan). **Fixed:** clamped to `MAX_SEARCH_CHARS` (200).
3. (low) `vCard PHOTO` parser accepted any `data:` URI MIME type. **Fixed:** parser only accepts `data:image/…` (and base64 detection now matches the `b`/`base64` token exactly, not the substring `b` in `8bit`); `toStorage` also rejects non-`data:image/`/non-`http(s)` photo strings from the renderer.

**Status: resolved** (no blockers; no vault leakage; all writes go through native OS dialog; the three advisories above were fixed in-PR)
