# Compass — Implementation Plan

> **Living document.** Updated whenever a feature ships or scope changes.
> The `docs-keeper` subagent (`.claude/agents/docs-keeper.md`) is responsible for keeping this in sync with reality after each merge.
>
> See [`strategic-review-2026-05.md`](strategic-review-2026-05.md) for the latest snapshot of where we stand and why.

## Status snapshot

| Bucket | Items | % done |
|---|---|---|
| **Phase 0** — Agent infrastructure | 7 sub-areas | 100% |
| **Phase 0+** — Leading-edge agent infra | 10 items | 90% (0+.6, 0+.9 superseded — see Phase 0++) |
| **Phase 0++** — Claude Code platform refresh (May 2026) | 6 items | 100% (0++.1–0++.6 all shipped) |
| **Phase 1** — Critical bug fixes | 5 items | 100% (all shipped prior to this branch) |
| **Phase 2** — Remaining PRD features | 7 items | 100% (2.1–2.7 all shipped prior to this branch) |
| **Phase 3** — Beyond-PRD polish | 2 selected items | 100% (onboarding wizard + tray/notifications shipped) |
| **Phase 4** — Finance forward roadmap | 8 items | 4.0–4.6 shipped; 4.7 closed early (Plaid is source of truth as of 2026-05-21; Excel pipeline retired) |
| **Phase 5 (cont.)** — Bounded UX wins | 5 items | 100% (5.10–5.14 shipped) |
| **Phase 6** — Code-health debt (May 2026) | 5 items | 6.1 = 100% (all IPC handlers tested) + 6.3 done; 6.2 / 6.4 / 6.5 = 0% |

PRD-completion of the running app: **~99%** (all Phases 1–3 + Phase 4.0–4.5 merged with UIs).

---

## Decisions locked in

| Question | Choice |
|---|---|
| Tooling stack | **Biome + Oxlint (CI fast-layer) + ESLint (React-only) + Vitest + Playwright + Knip + Lefthook + Renovate + Changesets + electron-trpc** + GitHub Actions CI |
| Phase 3 scope | **Onboarding wizard (3.1) + System notifications + tray quick-capture (3.2)** |
| Per-integration sync | **Implement now** in Phase 2.5 |
| Knowledge "Suggest edit" | **Regex baseline + opt-in Ollama** (local, privacy-preserving) |

---

## Phase 0 — Agent infrastructure

Modern (Nov 2025+) Claude Code best practice splits guidance into 4 layers. This phase puts all four in place so the rest of the work can be parallelized across agents.

- **CLAUDE.md** (≤ 60 lines) — always-loaded project context
- **Skills** (`.claude/skills/<name>/SKILL.md`) — auto-invoked playbooks
- **Subagents** (`.claude/agents/<name>.md`) — isolated parallel workers
- **Hooks** (`.claude/settings.json`) — deterministic enforcement

### 0.1 Root `CLAUDE.md` (≤ 60 lines, terse pointer doc)
- [x] Project (2 lines), Run, Architecture pointer, Conventions pointer, Implementation plan pointer, DO NOT touch list, Always-run-before-commit, Branch convention, Security boundary

### 0.2 `docs/` directory
- [x] `docs/implementation_plan.md` (this file)
- [x] `docs/architecture.md` — DB schema overview, IPC handler map, security model, data flow diagrams
- [x] `docs/conventions.md` — TS/React style, file naming, error handling pattern, IPC handler pattern, toast notification pattern
- [x] `docs/integrations.md` — how to add a new integration (Notion, Linear, etc.)
- [x] `docs/knowledge-extractor.md` — how the knowledge file auto-update pipeline works
- [x] Move existing `FINANCE_MODULE.md` → `docs/finance.md`

### 0.3 `.claude/skills/` — auto-invoked workflows
- [x] **`add-integration`** — DB schema → IPC → preload → types → UI card → extractor playbook
- [x] **`add-ipc-handler`** — handler + preload + type definition pattern
- [x] **`add-page`** — route + sidebar + command palette + page component
- [x] **`add-vault-category`** — vault category + field templates
- [x] **`safe-commit`** — typecheck + lint + draft conventional-commit + open PR
- [x] **`security-review`** — IPC sanitization, vault invariants, CSP changes
- [x] **`brand-style-check`** — verify tailwind tokens

### 0.4 `.claude/agents/` — subagents
- [x] **`bug-triager`** — read-only crawl for TODOs, dead code, unused deps
- [x] **`migration-author`** — Drizzle migration generator
- [x] **`security-auditor`** — diff review for vault/OAuth/IPC/CSP regressions
- [x] **`integration-implementer`** — heavy isolated impl of full integration end-to-end
- [x] **`ui-polish`** — accessibility + keyboard nav + states review
- [x] **`docs-keeper`** — keeps `docs/*` in sync with code

### 0.5 `.claude/hooks/` — enforcement (`.claude/settings.json`)
- [x] PreToolUse on Bash: block `git push --force` to main/master
- [x] PreToolUse on Write/Edit: block writes under data dirs (mirror pre-commit)
- [x] PreToolUse on Edit/Write: warn on `electron/ipc/vault.ts`, `electron/db/schema.ts`
- [x] PostToolUse on schema.ts edit: auto-run `npm run db:generate`
- [ ] PostToolUse on commit: append summary to `docs/CHANGELOG.md`

### 0.6 `.github/` — CI/PR scaffolding
- [x] `.github/workflows/ci.yml` — typecheck + lint + test + build on PR
- [x] `.github/workflows/security.yml` — weekly `npm audit`
- [x] `.github/dependabot.yml` — fallback (Renovate is primary)
- [x] `.github/PULL_REQUEST_TEMPLATE.md`
- [x] `.github/ISSUE_TEMPLATE/` (bug + feature)
- [x] `.github/CODEOWNERS`

### 0.7 Tooling — leading-edge stack
**Lint + format**: [x] Biome [x] Oxlint (CI fast-layer) [x] ESLint (React-only minimal config) [x] Knip
**Hooks**: [x] Lefthook (replaces Husky)
**Tests**: [x] Vitest [x] Playwright (E2E) [ ] coverage 70% on `electron/ipc/` + `electron/knowledge/`
**Type safety**: [x] `npm run typecheck` script [ ] electron-trpc (incremental adoption)
**Dependency hygiene**: [x] Renovate [ ] syncpack [x] remove `react-beautiful-dnd`
**Release**: [x] Changesets [x] electron-updater auto-update (GitHub Actions CI pipeline — `npm version patch && git push --follow-tags`)

---

## Phase 0+ — Leading-edge agent infrastructure (the "futuristic" tier)

- [x] **0+.1 Custom statusline** (`.claude/statusline/`) — branch + test status + sync queue length
- [x] **0+.2 Compass MCP server** (`mcp/compass-mcp/`) — read-only knowledge + tasks + calendar + sync status as MCP tools (vault excluded)
- [x] **0+.3 Output styles** (`.claude/output-styles/`) — code-mode, explain-mode, commit-mode
- [x] **0+.4 Plugin manifest** (`.claude/plugin.json`) — wrap whole `.claude/` as installable plugin
- [x] **0+.5 Director-pattern agent orchestration** (`.claude/agents/director.md`) — coordinates parallel subagents per feature
- [x] **0+.6 Living docs PostToolUse hook** — superseded by 0++.3 (shipped) — see Phase 0++
- [x] **0+.7 Parallel PR review pipeline** — `claude-code-action` runs security-auditor + ui-polish + bug-triager in parallel
- [x] **0+.8 Worktree workflow** — `scripts/worktree.sh` + `docs/agent-orchestration.md`
- [x] **0+.9 Background scheduled-task agents** — superseded by 0++.4 (shipped) — see Phase 0++
- [x] **0+.10 Project status JSON** (`.claude/project-status.json`) — `scripts/project-status.ts` regenerates it; `npm run status` is wired. Captures table list, IPC count by domain, test files, phase status (parsed from this doc), and the last 8 merge commits. Manual regen for now; the 0+.6 living-docs hook can wire auto-update later.

---

## Phase 0++ — Claude Code platform refresh (May 2026)

The Claude Code platform shipped meaningful features since Phase 0+ landed. Adopt the ones that move the agent-success needle. See [`strategic-review-2026-05.md`](strategic-review-2026-05.md) for the rationale.

- [x] **0++.1 SessionStart hook** — shipped. `.claude/hooks/session-start.sh` emits a compact orientation snapshot (branch, last commit, drift from origin/main, dirty count, open PRs) into every new session; wired under `hooks.SessionStart`. (Uses git/gh directly rather than regenerating project-status.json, to keep session start fast.)
- [x] **0++.2 UserPromptSubmit guardrails** — shipped. `.claude/hooks/guardrails.sh` warns on push-to-main / force-push, nudges to `/safe-commit` when "commit" appears with nothing staged, and flags protected-path mentions. Advisory only (never blocks); real enforcement stays at the tool-call layer.
- [x] **0++.3 Living-docs PostToolUse hook** (supersedes 0+.6) — `.claude/hooks/living-docs.sh` fires on Edit/Write to `electron/db/schema.ts`, `electron/db/schema.finance.ts`, `electron/preload.ts`, or `src/types/electron.d.ts` and emits an `additionalContext` nudge instructing the agent to run the `docs-keeper` subagent (a shell hook can't spawn a subagent directly). Advisory only — never blocks. Wired as a 2nd PostToolUse command alongside `post-schema-edit.sh`.
- [x] **0++.4 Background scheduled agents** (supersedes 0+.9) — three GitHub Actions workflows under `.github/workflows/agent-*.yml` (following the `0+.7` claude-review.yml pattern): **nightly** bug-triager (06:00 UTC → rolling "🌙 Nightly bug triage" issue + memory commit), **weekly** docs-keeper (Mon 05:00 UTC → opens a doc-reconcile PR when docs drift), **monthly** security-auditor (1st 04:00 UTC, diff-focused on `electron/ipc/vault.ts`, `auth.ts`, `electron/db/schema.ts`, `main.ts`, `preload.ts` → rolling "🔒 Monthly security audit" issue + memory commit). All three are **dormant by default** — the job runs only when `vars.CLAUDE_SCHEDULED_AGENTS_ENABLED == 'true'`, and the agent step is additionally guarded so it skips when the `ANTHROPIC_API_KEY` secret is absent, so they cost nothing until opted in. (Implemented as scheduled workflows rather than the `CronCreate` tool so the schedule lives in the repo and runs server-side, not tied to a local session.)
- [x] **0++.5 Subagent memory** — shipped. `.claude/agents/memory/{security-auditor,bug-triager}/MEMORY.md` scaffolds (accepted risks / known-safe patterns / run log, with a per-year retention/archival rule); each agent's prompt consults memory at start and appends a run-log entry on completion, with an ephemeral-CI fallback that reports when persistence isn't possible. `Edit` granted, scoped to the memory file only.
- [x] **0++.6 MCP server self-knowledge expansion** — extended `mcp/compass-mcp/index.ts` with `compass_recent_commits` (git log, repo root derived from `import.meta.url`, fields delimited by `%x1f` so subjects parse cleanly), `compass_test_status` (static inventory by default; `run=true` executes `npm run test:run` behind the `COMPASS_MCP_ALLOW_TEST_RUN=1` opt-in and returns the parsed pass/fail summary), and `compass_integration_health` (integrations joined with recent `sync_events` counts + last error). All read-only by default; `execFileSync` (not `execSync`) so args can't be shell-injected. Lets agents introspect without shelling out.

---

## Phase 1 — Critical bug fixes

### 1.1 Fix dual `CommandPalette` mounting
- [x] **Shipped** — `AppLayout.tsx` never mounted a duplicate; `App.tsx` owns the single ⌘K listener

### 1.2 Cron interval doesn't restart on Settings change
- [x] **Shipped** — `electron/ipc/settings.ts` calls `restartCronJobs()` when `key === 'syncInterval'`

### 1.3 Cron `0` ("Manual only") crashes
- [x] **Shipped** — `cronExpressionForIntervalMinutes()` returns null for interval ≤ 0; scheduler skips

### 1.4 Replace `alert()` and `confirm()` with toast/dialog primitives
- [x] **Shipped** — All pages use `useConfirm()` / `useToast()` from `src/components/ui/`

### 1.5 Pre-commit passes
- [x] **Verified** — `npm run typecheck && npm run check && npm test` all green

---

## Phase 2 — Complete remaining PRD features

### 2.1 Vault inline edit form
- [x] **Shipped** in PR #10 follow-up — `Pencil` button + `updateEntry` via `vault:update-entry` IPC

### 2.2 Finance — account management UI
- [x] **Shipped** — `AccountsTab` in `Finance.tsx` (grouped by type, inline add/edit/delete with ConfirmDialog)

### 2.3 Finance — transaction edit/delete
- [x] **Shipped** — Inline edit for category/subcategory/notes; hover-reveal delete with ConfirmDialog

### 2.4 Finance — categorization rules manager
- [x] **Shipped** — `RulesTab` in `Finance.tsx` (list, add, edit, delete, re-apply)

### 2.5 Per-integration sync frequency
- [x] **Shipped** — `syncIntervalMinutes` column on `integrations`; `cron.ts` uses `Map<service, ScheduledTask>`; per-card select in `Integrations.tsx`

### 2.6 Weekly: "events attended" stat
- [x] **Shipped** — `attendedEvents` in `Weekly.tsx` counts past events in current week

### 2.7 Knowledge "Suggest edit" — regex baseline + opt-in Ollama
- [x] **Shipped** — `electron/knowledge/suggestions.ts` (regex baseline) + `electron/knowledge/ollama.ts` (opt-in); Settings toggle; checkboxes in `KnowledgeBase.tsx`

---

## Phase 3 — Beyond-PRD product improvements (DECIDED scope: 3.1 + 3.2)

### 3.1 Onboarding wizard
- [x] **Shipped** — `OnboardingWizard.tsx` shown once on first launch; `onboardingCompleted` in `appSettings`; legacy key handled

### 3.2 System notifications + macOS menu-bar quick-capture
- [x] **Shipped** — `electron/menu-bar.ts` (Tray + global shortcut); `src/quickCapture/` (320×80 popup); `QuickCapture.tsx`

---

## Phase 4 — Finance forward roadmap

Compass owns the user's full financial life as of `feat/finance-rocket-money-import`
(merged 2026-05). The Excel pipeline in the user-configured legacy finance project
directory ran in parallel and was retired early on 2026-05-21 once Plaid became the
source of truth (see [`finance/legacy-cutover.md`](finance/legacy-cutover.md) and §4.7).
This phase turns the retrospective dashboard into a forward-looking financial command center.

Each item below has its own plan doc under [`docs/finance/`](finance/) sized to land as one PR.

### 4.0 ✅ Rocket Money import + geo/CR-purpose tagging + subscription audit
Shipped in `feat/finance-rocket-money-import`. Adds Rocket Money parser, `categorize()` smart fallbacks (CR ATM regex + RM category map), `finance-geo.ts` (geo + purpose tagger via `notes` tokens), `finance-atm-split.ts` (idempotent 70/30 CR ATM split), `finance-subscriptions.ts`, `scripts/import-from-excel.ts`, plus the **CR & Subs** Finance tab and the *Hide Property* budget toggle.

### 4.1 [`db-migrate-fix.md`](finance/db-migrate-fix.md) — restore `npm run db:migrate`
- [x] **Shipped** — `electron/db/migrate.ts` created with `--check` / `--reset --yes` flags + 7 tests in `migrate.test.ts`

### 4.2 [`geo-purpose-schema-promotion.md`](finance/geo-purpose-schema-promotion.md) — promote tags to indexed columns
- [x] **Shipped** — `geo` / `purpose` columns on `financeTransactions` with 3 indexes; backfill migration `0004_grey_shiver_man.sql`; `tagGeoAndPurpose` writes to columns directly; `finance:get-geo-summary` uses SQL aggregation

### 4.3 [`tax-tagging.md`](finance/tax-tagging.md) — Schedule C / E / capex tags
- [x] **Backend shipped** — `taxTag` / `taxTagSource` / `taxYear` columns on `financeTransactions` (indexed on `(taxYear, taxTag)`); `electron/integrations/finance-tax.ts` classifier wired into both ingest paths + Excel import; historical-row backfill via `backfillTaxTags()` runs from both `initDb()` and the standalone `db:migrate` runner; `finance:get-tax-summary` and `finance:set-transaction-tax-tag` IPC handlers exposed through preload + types; user overrides sticky via `taxTagSource='user'`; 21 classifier + backfill tests
- [x] **UI shipped** — color-coded `TaxBadge` column in Transactions tab (short label per tag, ring around manually-overridden rows, full label + source on hover); tax-tag `<select>` in the expanded transaction editor calls `setTransactionTaxTag` and marks `taxTagSource='user'`; year-to-date Tax summary card on the Overview tab listing per-tag count + signed total

### 4.4 [`net-worth.md`](finance/net-worth.md) — asset-side tracking + trajectory
- [x] **Backend shipped** — `assetClass` column on `financeAccounts` + new `finance_balance_snapshots` table (indexed on `(accountId, capturedAt)`); `electron/integrations/finance-snapshot.ts` with `captureSnapshots()` (idempotent within a day), `inferBalance()` (snapshot baseline + Σ newer txns, with debt-account sign flip), `setAccountBalance()`, `getNetWorthSnapshot()` (assets / liabilities / net + 30/90/365-day deltas), `getNetWorthTrajectory()`; nightly cron at 00:05 local time
- [x] **UI shipped** — Net Worth tab on Finance page with 4-tile snapshot (Assets / Liabilities / Net / Δ), Recharts area trajectory (with forward-fill across days), per-account table with inline "Set balance" for manual_asset rows, "Capture snapshot" CTA + empty-state. 6 unit tests on the trajectory roll-up helper

### 4.5 [`cash-flow-forecast.md`](finance/cash-flow-forecast.md) — 90-day projection
- [x] **Backend shipped** — `forecast_overrides` table + `paymentDayOfMonth` column on `financeAccounts`; `electron/integrations/finance-forecast.ts` engine with pure functions for `projectSubscriptionEvents`, `projectIncomeEvents`, `projectDebtEvents` (debt minimums route to cash), `projectCalendarEvents`, `applyOverrides`, `projectCashflow` (day-aggregated walk with low-cash detection); 3 IPC handlers wired through preload + types
- [x] **UI shipped** — Forecast tab on Finance page with low-cash warning banner, Recharts multi-line trajectory (one line per account), event list grouped by ISO week, click-to-open Skip / Shift / Override dialog, "Reset" clears overrides via `delete-forecast-override`. 9 unit tests on `buildForecastChartData` + `groupEventsByWeek`

### 4.6 [`plaid-integration.md`](finance/plaid-integration.md) — kill the Sunday CSV ritual
Plaid Link in a child BrowserWindow, encrypted tokens in Vault, `transactions/sync` cursor loop, daily 06:00 cron. CSV watcher stays as fallback for institutions Plaid can't reach (CR Banco Popular). Multi-PR effort — orchestrate via `director`.
*Owner: `director` orchestrating `migration-author` + `integration-implementer` + `security-auditor` + `ui-polish` · ~1,500–2,000 LOC across 5–6 PRs*

- [x] **PR 1 — Schema** — `plaid_items` table + `plaidItemId`/`plaidAccountId`/`mask` columns on `financeAccounts` (indexed via `idx_finance_accounts_plaid`); migration 0009; backward compat in `client.ts` for both `ensureNewTables` + `createTablesIfNeeded`; migrate test asserts the new columns exist
- [x] **PR 2a — Vault layer** — extracted shared crypto primitives to `electron/lib/crypto-vault.ts` (the existing vault now imports from there; no behaviour change); new `electron/integrations/plaid/vault.ts` encrypts both per-env Plaid API secrets AND per-Item access tokens into a single `.vault/plaid.enc` blob via AES-256-GCM; 32 unit tests with mocked safeStorage covering round-trip, tamper detection, wrong-key, unicode, isolation per env / per Item, sorted ID listing without token leakage, and the "wipe leaves an encrypted empty blob on disk" invariant
- [x] **PR 2b — Plaid SDK wrapper** — `electron/integrations/plaid/config.ts` parses `~/.config/compass/plaid.env` (non-secret `PLAID_CLIENT_ID` + `PLAID_ENV`; rejects the retired `development` env). `electron/integrations/plaid/client.ts` exposes `getPlaidClient(env?)` that re-reads config + secret on every call (stateless, matching the vault's no-cache invariant) and returns `{ api, env, clientId }`. Typed `PlaidNotConfiguredError` with `reason: 'missing-config' | 'missing-secret' | 'env-mismatch'` lets the upcoming Integrations card branch cleanly on setup state. `plaid@^42.2.0` added. 27 unit tests (15 config + 12 client) covering header wiring, base-path routing, stateless re-reads, env-mismatch rejection
- [x] **PR 3 — Plaid Link flow** — `electron/integrations/plaid/link.ts` adds `createLinkToken()` (pinned to `Products.Transactions` + `CountryCode.Us` for the narrowest consent prompt; stable per-process `client_user_id` UUID), `exchangePublicToken(publicToken)` (vault-write FIRST so a mid-flow crash can't strand an Item we can't reach; `accountsGet` + `institutionsGetById` failures are non-fatal; access token never appears in the return shape), and `buildLinkHtml(linkToken)` (self-contained HTML that loads `cdn.plaid.com/link/v2/stable/link-initialize.js` and posts back via `compass-plaid://success` / `exit`; token escaped against `<`, `"`, `\`, U+2028/U+2029 before interpolation). New `electron/ipc/plaid.ts` registers `plaid:get-status`, `plaid:set-secret`, `plaid:start-link`, `plaid:disconnect`. The Link child BrowserWindow runs with `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, and a per-window CSP that whitelists `cdn.plaid.com` + `*.plaid.com` only — main window's CSP untouched. User-cancellation resolves with `{ ok: false, cancelled: true }`; only programmer errors reject. 36 unit tests (21 link helpers + 15 IPC)
- [x] **PR 4 — Sync loop** — `electron/integrations/plaid/normalize.ts` maps Plaid `Transaction` → `RawTxn` (sign flip, `merchant_name ?? name`, natural-field hash so CSV→Plaid migration doesn't double-count); `electron/integrations/plaid/cursor.ts` r/w of `plaidItems.cursor`; `electron/integrations/plaid/sync.ts` exporting `syncPlaid(itemId)` + `syncAllPlaid()` (cursor loop on `has_more`, `removed` deletes by `'plaid:<institution>:<txnId>'` `sourceFile` match, `sync_events` + `integrations.lastSyncedAt` written); wired into `electron/ipc/sync.ts`. Reuses existing `categorize()` + `tagGeoAndPurpose()` + hash-dedupe upsert. Tests: `normalize.test.ts`, `cursor.test.ts`, `sync.test.ts`
- [x] **PR 5 — Integrations card UI + Accounts-tab "linked" badge** — Plaid card in `src/pages/Integrations.tsx` with set-secret form, start-link CTA branching on `configured`/`hasSecret`, per-Item disconnect; `plaid:list-items` IPC + preload + types added; `src/pages/Finance.tsx` Accounts tab renders "linked · <institution>" badge on rows whose `plaidItemId` resolves
- [x] **PR 6 — Daily 06:00 cron + error-surface UX** — `electron/cron-plaid.ts` schedules `syncAllPlaid()` at 06:00 local time (separate from generic `cron.ts` rotation so per-Item error codes can surface on the Item card); `cron-plaid.test.ts` covers scheduling + error surface; `cron.ts` skips `service === 'plaid'` rows in the generic loop

### 4.7 [`legacy-cutover.md`](finance/legacy-cutover.md) — retire the Excel pipeline (closed early 2026-05-21)
- [x] **Closed early (2026-05-21)** — Plaid is the source of truth as of this date; Excel parallel-run retired ahead of the originally planned 2026-06-10 cutover. Reconciliation log discontinued.

### Recommended sequence

```
4.1 (db:migrate fix) → 4.2 (schema promotion) → 4.3 (tax tagging) ─┐
                                                                    ├→ 4.4 (net worth)
                                                                    │
                                                                    ├→ 4.5 (forecast)
                                                                    │
                                                                    └→ 4.6 (Plaid, multi-PR)

4.7 (cutover) closed early on 2026-05-21 — Plaid became the source of truth ahead of schedule.
```

4.4 and 4.5 are independent of each other; can parallelize in worktrees.
4.6 is the largest and most risk-prone — start it after 4.4 lands so the
Net Worth view has live balances waiting.

### Phase 4 verification

- `npm run db:migrate -- --check` passes after each schema item.
- New IPC handlers all have type defs in `src/types/electron.d.ts`.
- Each new tab lands behind the existing tab navigation pattern in `Finance.tsx`.
- Markdown summaries written to `knowledge-base/profile/finances*.md` stay PII-free.
- During the Plaid rollout, `security-auditor` review is a merge gate (token storage + CSP additions).

---

## Phase 5 (cont.) — bounded UX wins

- [x] **5.10 Vault auto-lock** — `Vault.tsx` tracks idle activity (mouse, keyboard, scroll, touch) and locks the entries panel behind an "Unlock" CTA after `vaultAutoLockMinutes` (default 5; `0` disables). Also locks immediately on `window.blur` so unattended Macs stop showing secrets when another app takes focus. Setting lives in `app_settings` under `vaultAutoLockMinutes`; Settings → Security & Privacy adds a dropdown.
- [x] **5.11 Habit streaks badges** — `src/lib/habit-streaks.ts` adds pure `computeHabitStreak()` (current + longest) over the existing `habits:get-entries` map. "Today unchecked but yesterday checked" doesn't break a streak until end-of-yesterday. Monthly habits view shows a `🔥 N` badge next to each habit with `current >= 2`; tooltip includes longest-ever. 10 unit tests cover boundaries.
- [x] **5.12 Ask Compass — in-app RAG assistant** (Tier 2 #7). New `/ask` page with single-pane chat against the user's knowledge base; answers cite `[N]` source notes inline. BYO Anthropic + OpenAI keys (encrypted via crypto-vault primitives at `.vault/assistant.enc`; only masked tails cross IPC). Retrieval composes with Phase 5.9 semantic search; falls back to keyword-scan when no embedding index. Cancellation via `assistant:cancel`. Settings → AI assist gets a BYO-key panel with per-provider key/model/active controls. 21 new unit tests.
- [x] **5.13 Apple Calendar RRULE + RDATE expansion** — promised follow-up from #74. New `electron/integrations/apple-rrule.ts` materializes occurrences within the lookahead window for DAILY/WEEKLY/MONTHLY/YEARLY + INTERVAL/COUNT/UNTIL/BYDAY/EXDATE/RDATE. DST-safe calendar-day arithmetic (wall-clock preserved across spring-forward). MONTHLY/YEARLY skip non-existent dates (Jan 31 → no Feb, Feb 29 → non-leap years skipped). BYDAY is honoured as a weekday filter on DAILY + WEEKLY; positional BYDAY on MONTHLY/YEARLY + other unsupported modifiers (BYSETPOS, BYMONTHDAY, etc.) short-circuit to base-only with a console.warn. Base occurrence reuses the bare uid so pre-PR rows upsert in place; subsequent occurrences get `${baseUid}::${occISO}`. 45 unit tests (37 expander + 8 end-to-end iCal).
- [x] **5.14 Spotlight-friendly knowledge mirror** — opt-in one-way mirror of `knowledge-base/*.md` to a user-chosen path under `~/Documents` or `~/Desktop` (Spotlight-indexed locations) via `electron/integrations/spotlight-mirror.ts`. Path validated against allowlist; reconcile uses mtime-skip backfill + stale-file prune + empty-dir cleanup. Watcher piggybacks on chokidar against `KNOWLEDGE_DIR` (`awaitWriteFinish: 500ms`). README in the mirror dir documents one-way semantics. Settings → Data adds the toggle, path field, and manual "Reconcile" button. 22 new unit tests.

---

## Phase 6 — Code-health debt (May 2026)

Backfill that's accumulated as the project shipped fast. None individually critical; together they're worth a dedicated phase. See [`strategic-review-2026-05.md`](strategic-review-2026-05.md) §"Phase 6" for the full audit.

### 6.1 IPC test coverage backfill
Originally most `electron/ipc/*.ts` modules lacked test coverage. The bulk shipped between PR #96 and #102 in May 2026. **What remains: `sync.ts` has no test at all, and `auth.ts` is only partially covered** — its PAT + Google-credentials handlers are tested (`auth-github-pat.test.ts`, `auth-google-creds.test.ts`), but the OAuth-flow handlers (`auth:connect-google`, `auth:connect-github`, `auth:disconnect`, `auth:get-status`, `auth:get-redirect-uris`) are not.
- [x] **P0** — `electron/ipc/vault.ts` (security-critical) — shipped via #96
- [~] **P0** — `electron/ipc/auth.ts` — partial: PAT + Google-creds handlers covered (`auth-github-pat.test.ts`, `auth-google-creds.test.ts`); OAuth-flow handlers still uncovered
- [x] **P1** — `electron/ipc/finance.ts` (largest handler) — shipped via #102 (chunk 1/3 of 3)
- [ ] **P1** — `electron/ipc/sync.ts` (no test)
- [x] **P1** — `electron/ipc/knowledge.ts` — shipped via #97
- [x] **P2** — `electron/ipc/settings.ts` — shipped via #98
- [x] **P2** — `electron/ipc/spotlight.ts` (integration coverage exists; handler seam backfill) — shipped via #101
- [x] **P3** — `electron/ipc/habits.ts` — shipped via #99
- [x] **P3** — `electron/ipc/updater.ts` — shipped via #100

### 6.2 Knowledge module test backfill
- [ ] `electron/knowledge/extractor.ts` — auto-update pipeline entrypoint
- [ ] `electron/knowledge/finance-extractor.ts`
- [ ] `electron/knowledge/writer.ts`

### 6.3 Empty-catch sweep
- [x] **Shipped** — converted all 13 silent `catch {}` to `catch (err) { console.warn('[area]', err) }` in `electron/menu-bar.ts` (x3), `electron/url-scheme.ts` (x1), `electron/cron.ts` (x2), `electron/integrations/finance-watcher.ts` (x2), `electron/integrations/apple-calendar.ts` (x5). Each warn carries an area tag + the relevant path/value for context; existing fall-through comments and return values preserved. Behaviour unchanged - affected suites still green (`url-scheme` 12, `cron-plaid` 9, `apple-calendar` 27, `apple-rrule` 37).

### 6.4 Biome warning cleanup
- [ ] Fix the 78 standing warnings — concentrated in `electron/integrations/finance.ts:64-66` (noAssignInExpressions ×3) and `src/pages/Weekly.tsx` (a11y + exhaustive-deps + button-type)
- [ ] Add `--max-diagnostics=0` to the CI Biome step so future PRs can't re-introduce them

### 6.5 Type-safety escape audit
- [x] **Shipped** — removed all 4 remaining escapes: `electron/preload-quick-capture.ts` + `electron/preload.ts` (×3 `@ts-ignore` on the non-isolated `window.*` fallback assignments) now use a localized widened-`window` cast instead of suppression; `electron/ipc/finance.ts:106` dropped `db as any` (the `getDb()` return type already matches `ingestCsvFolder`'s `BetterSQLite3Database<typeof schema>` param, so the cast was dead). typecheck stays green.
- [ ] **Deferred (deliberate non-change):** narrowing `PlaidEnv` in `electron/integrations/plaid/vault.ts` from `'sandbox' | 'development' | 'production'` to `'sandbox' | 'production'`. The vault layer is an intentionally env-agnostic keyed store (config.ts is the validation gate that rejects the retired `development` env); `vault.test.ts` exercises `'development'` precisely to prove the store is env-key-generic. Narrowing here would break those isolation tests and over-couple the store to the gate. Leaving as-is.

---

## Backlog (deferred, considered but out of scope this round)

## Phase 5 — Strategic-review follow-ups (May 2026)

Driven by the May 2026 strategic review (`/Users/christopherennis/.claude/plans/give-me-a-detailed-logical-whisper.md`). Promotes the Tier 1 + Tier 2 items the review flagged as the highest-impact next moves.

- [x] **5.1 Encrypted backup / restore** — passphrase-derived AES-256-GCM bundle of all SQLite tables + knowledge markdown + `.vault/*.enc` (master key wrapper included). `electron/ipc/backup.ts` with `backup:create` / `backup:restore` IPC, Settings UI panel, 7 round-trip tests (wrong passphrase, tampered blob, bad magic, version mismatch). Survives a dead machine — the only thing the user has to bring is the passphrase.
- [x] **5.2 Global ⌘K search** — new `search:global` IPC returns ranked hits across knowledge bodies, vault titles (never bodies), task titles, and transaction descriptions. CommandPalette renders matches inline. Vault decryption happens in the main process so secrets never cross the IPC boundary.
- [x] **5.3 Wikilinks + backlinks** — `[[target]]` and `[[target|display]]` syntax parsed in `markdownToHtml` and re-emitted by `htmlToMarkdown`. New `knowledge:get-backlinks` handler scans for inbound links by title / basename / path. Clicking a wikilink in the editor navigates (or offers to create) the target note. Panel in `KnowledgeBase.tsx` lists referencing files with snippets.
- [x] **5.4 Tax-pack export** — `finance:export-tax-pack` IPC writes one CSV per non-`tax:none` tag for the requested year into a user-chosen folder, plus a `*-manifest.txt` index. Button next to the YTD Tax summary card on the Finance Overview tab. CPA-ready / TurboTax-importable.
- [x] **5.5 Subscription price-hike alerts** — `auditSubscriptions` now splits each subscription's charge stream into recent (last ~3) vs historical and reports `priceHike` + `priceHikeDelta` + `priceHikePct`. The Active Subscriptions table highlights hike rows, shows a `+X%` chip, and surfaces a top-of-table banner with the projected annual impact. Three new unit tests cover the clean hike / flat stream / noisy drift cases.
- [x] **5.6 Windows + Linux build targets** — `electron-builder` config now emits `dmg+zip` for macOS (arm64+x64), `nsis+portable` for Windows, and `AppImage+deb` for Linux. The release workflow fans out into three OS jobs (`macos-latest`, `windows-latest`, `ubuntu-latest`).
- [x] **5.7 Apple Calendar (iCal) local read** — `electron/integrations/apple-calendar.ts` walks `~/Library/Calendars/*.calendar/Events/*.ics`, parses VEVENTs (line unfolding, escape decode, DATE / DATE-TIME / TZID handling, RRULE flagging) and upserts into `calendar_events` with `source: 'apple'`. `syncAppleCalendar()` wired into `sync:trigger`, `sync:trigger-all`, and the per-integration cron schedule. Integrations card is local-only — "Connect" runs the sync, no OAuth. RRULE expansion is a follow-up (base instance is emitted today); TZID bodies parse as floating local time.
- [x] **5.8 `compass://` URL scheme** — `electron/url-scheme.ts` registers Compass as the default handler and routes a small command vocabulary (`capture`, `open/<page>`, `search`) into the running process via `open-url` (macOS) or single-instance argv (Win/Linux). `electron-builder.protocols` advertises the scheme on packaged installs. Renderer-side bridge inside `<HashRouter>` handles navigation + palette pre-fill.
- [x] **5.9 Semantic search via local Ollama embeddings** — `electron/knowledge/embeddings.ts` adds a paragraph-aware chunker (~700-char target), an `/api/embeddings` round-trip against the user's local Ollama, a JSON-on-disk index at `.data/knowledge-embeddings.json`, and cosine-similarity ranking with per-path dedup. Incremental builds reuse chunks whose `(path, mtime)` still matches; a model-version change invalidates the whole index. Three IPC handlers (`knowledge:get-embedding-status`, `knowledge:rebuild-embeddings`, `knowledge:semantic-search`) feed the Settings UI (rebuild button + status) and a "By meaning" section in the Knowledge Base sidebar that runs alongside the existing keyword search. Defaults off; same opt-in trust posture as the existing Ollama-backed suggestions.

### Deferred (revisit Q3 2026)

- Apple Contacts import
- PWA / web companion
- Plaid Investments (holdings + securities) — only if retirement net-worth tracking goes beyond manual edits
- Vault entry sharing (encrypted export for a trusted partner)

> Prior entries (habit streaks, privacy auto-lock, distraction-free reading, bulk ops, Apple Spotlight, Apple RRULE, in-app AI assistant) were promoted into Phase 5 and shipped — see §5.10–5.14.

---

## Recommended PR sequence

| # | Branch | Phase items | Owner |
|---|---|---|---|
| A | `chore/agent-infrastructure` | Phase 0 + Phase 0+ scaffolding | docs-keeper / infra |
| F ←→ | `fix/dual-command-palette` | Phase 1.1 | any |
| G ←→ | `fix/cron-restart-and-zero-guard` | Phase 1.2, 1.3 | any |
| H ←→ | `feat/toast-confirm-primitives` | Phase 1.4 | ui-polish |
| J | `feat/finance-management-ui` | Phase 2.2, 2.3, 2.4 | feature agent |
| K | `feat/per-integration-sync` | Phase 2.5 | integration-implementer |
| L | `feat/weekly-events-attended` | Phase 2.6 | small PR, any |
| M | `feat/knowledge-suggestions-regex` | Phase 2.7 baseline | feature agent |
| N | `feat/knowledge-suggestions-ollama` | Phase 2.7 Ollama | integration-implementer |
| O | `feat/onboarding-wizard` | Phase 3.1 | feature agent |
| P | `feat/notifications-and-tray` | Phase 3.2 | feature agent |
| Q ✅ | `feat/finance-rocket-money-import` | Phase 4.0 | merged |
| R | `fix/db-migrate-script` | Phase 4.1 | migration-author |
| S | `feat/finance-geo-purpose-columns` | Phase 4.2 | migration-author + integration-implementer |
| T | `feat/finance-tax-tagging` | Phase 4.3 | integration-implementer |
| U ←→ | `feat/finance-net-worth` | Phase 4.4 | migration-author + ui-polish |
| V ←→ | `feat/finance-forecast` | Phase 4.5 | integration-implementer + ui-polish |
| W | `feat/finance-plaid-*` (5–6 PRs) | Phase 4.6 | director |

`←→` = independent, parallelizable across worktrees.

---

## Verification

**Phase 0**: `tree -L 2 .claude/ docs/ .github/` shows structure; `wc -l CLAUDE.md` ≤ 60; `npm run typecheck && npm run check && npm test && npm run build` all pass; `npx knip` returns no unused deps; Lefthook fires on commit; `claude mcp list` shows `compass`.

**Phase 1**: ⌘K opens exactly ONE palette; sync interval change applies without restart; "Manual only" doesn't crash; vault delete uses ConfirmDialog (not native popup).

**Phase 2**: Vault password edit saves + history retains old; finance account add/edit/delete persists; Google→5m, GitHub→1h fire on own schedules; Weekly "events attended" matches; Gmail from new sender → 📝 suggestion appears, then 🤖 if Ollama enabled.

**Phase 3**: First launch shows wizard once; habit reminder fires; tray menu opens quick-capture popup; `Cmd+Shift+T` works from any app.

**Phase 4**: `npm run db:migrate -- --check` exits 0 after each schema item; `finance:get-geo-summary` and `finance:get-tax-summary` return SQL-aggregated results (not JS post-aggregation); Net Worth tab shows non-zero deltas after a snapshot capture; Forecast tab projects 90 days with at least the active subscriptions visible as outflow events; Plaid Link completes in sandbox env with a fixture institution; the Excel project at `~/Documents/Claude/Projects/Getting on top of finances/` was archived to `~/Documents/Claude/Archived/` at the early 2026-05-21 cutover.
