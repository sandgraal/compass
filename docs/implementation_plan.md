# Compass — Implementation Plan

> **Living document.** Updated whenever a feature ships or scope changes.
> The `docs-keeper` subagent (`.claude/agents/docs-keeper.md`) is responsible for keeping this in sync with reality after each merge.

## Status snapshot

| Bucket | Items | % done |
|---|---|---|
| **Phase 0** — Agent infrastructure | 7 sub-areas | 100% |
| **Phase 0+** — Leading-edge agent infra | 10 items | 80% (0+.6, 0+.9, 0+.10 deferred) |
| **Phase 1** — Critical bug fixes | 5 items | 100% (all shipped prior to this branch) |
| **Phase 2** — Remaining PRD features | 7 items | 100% (2.1–2.7 all shipped prior to this branch) |
| **Phase 3** — Beyond-PRD polish | 2 selected items | 100% (onboarding wizard + tray/notifications shipped) |
| **Phase 4** — Finance forward roadmap | 7 items | partial (4.0–4.5 shipped; 4.6 outstanding) |

PRD-completion of the running app: **~99%** (all Phases 1–3 + Phase 4.0–4.5 merged).

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
- [ ] **0+.6 Living docs PostToolUse hook** — auto-run docs-keeper on schema/preload edits
- [x] **0+.7 Parallel PR review pipeline** — `claude-code-action` runs security-auditor + ui-polish + bug-triager in parallel
- [x] **0+.8 Worktree workflow** — `scripts/worktree.sh` + `docs/agent-orchestration.md`
- [ ] **0+.9 Background scheduled-task agents** — nightly bug-triager, weekly docs-keeper, monthly security-auditor
- [ ] **0+.10 Project status JSON** (`.claude/project-status.json`) — agent-readable snapshot of repo state

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
directory runs in parallel through 2026-06-10, then retires (see [`finance/legacy-cutover.md`](finance/legacy-cutover.md)).
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
- [ ] **UI follow-up** — tax badge in Transactions tab + override dropdown + year-end summary card (separate `ui-polish` PR)

### 4.4 [`net-worth.md`](finance/net-worth.md) — asset-side tracking + trajectory
- [x] **Backend shipped** — `assetClass` column on `financeAccounts` + new `finance_balance_snapshots` table (indexed on `(accountId, capturedAt)`); `electron/integrations/finance-snapshot.ts` with `captureSnapshots()` (idempotent within a day), `inferBalance()` (snapshot baseline + Σ newer txns, with debt-account sign flip), `setAccountBalance()`, `getNetWorthSnapshot()` (assets / liabilities / net + 30/90/365-day deltas), `getNetWorthTrajectory()`; nightly cron at 00:05 local time
- [x] **UI shipped** — Net Worth tab on Finance page with 4-tile snapshot (Assets / Liabilities / Net / Δ), Recharts area trajectory (with forward-fill across days), per-account table with inline "Set balance" for manual_asset rows, "Capture snapshot" CTA + empty-state. 6 unit tests on the trajectory roll-up helper

### 4.5 [`cash-flow-forecast.md`](finance/cash-flow-forecast.md) — 90-day projection
- [x] **Backend shipped** — `forecast_overrides` table + `paymentDayOfMonth` column on `financeAccounts`; `electron/integrations/finance-forecast.ts` engine with pure functions for `projectSubscriptionEvents`, `projectIncomeEvents`, `projectDebtEvents` (debt minimums route to cash), `projectCalendarEvents`, `applyOverrides`, `projectCashflow` (day-aggregated walk with low-cash detection); 3 IPC handlers wired through preload + types
- [x] **UI shipped** — Forecast tab on Finance page with low-cash warning banner, Recharts multi-line trajectory (one line per account), event list grouped by ISO week, click-to-open Skip / Shift / Override dialog, "Reset" clears overrides via `delete-forecast-override`. 9 unit tests on `buildForecastChartData` + `groupEventsByWeek`

### 4.6 [`plaid-integration.md`](finance/plaid-integration.md) — kill the Sunday CSV ritual
Plaid Link in a child BrowserWindow, encrypted tokens in Vault, `transactions/sync` cursor loop, daily 06:00 cron. CSV watcher stays as fallback for institutions Plaid can't reach (CR Banco Popular). Multi-PR effort — orchestrate via `director`.
*Owner: `director` orchestrating `migration-author` + `integration-implementer` + `security-auditor` + `ui-polish` · ~1,500–2,000 LOC across 5–6 PRs*

### 4.7 [`legacy-cutover.md`](finance/legacy-cutover.md) — retire the Excel pipeline (2026-06-10)
Operational doc. Transition rules for the parallel-run window, cutover-day checklist, rollback plan. Not a PR — `docs-keeper` maintains the reconciliation log here during the window.
*Owner: `docs-keeper` + `director` · operational, no code*

### Recommended sequence

```
4.1 (db:migrate fix) → 4.2 (schema promotion) → 4.3 (tax tagging) ─┐
                                                                    ├→ 4.4 (net worth)
                                                                    │
                                                                    ├→ 4.5 (forecast)
                                                                    │
                                                                    └→ 4.6 (Plaid, multi-PR)

4.7 (cutover) runs as background ops doc throughout May 2026.
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

## Backlog (deferred, considered but out of scope this round)

- Encrypted backup/restore (high value — Phase 4)
- Apple Calendar (iCal) local read
- Habit streaks badges
- Wiki-style `[[link]]` between knowledge files
- Global search via ⌘K (knowledge + vault titles + tasks inline)
- Privacy auto-lock (Vault re-auth after N min idle)
- Distraction-free reading mode
- Bulk operations in Daily checklist
- Apple Spotlight integration
- Apple Contacts import
- PWA / web companion

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

**Phase 4**: `npm run db:migrate -- --check` exits 0 after each schema item; `finance:get-geo-summary` and `finance:get-tax-summary` return SQL-aggregated results (not JS post-aggregation); Net Worth tab shows non-zero deltas after a snapshot capture; Forecast tab projects 90 days with at least the active subscriptions visible as outflow events; Plaid Link completes in sandbox env with a fixture institution; the Excel project at `~/Documents/Claude/Projects/Getting on top of finances/` is in `~/Documents/Claude/Archived/` after 2026-06-10.
